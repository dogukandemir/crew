"""ADR 0009: the company layer, a HQ project with a CEO, member projects that report up
through it, and a review that writes grounded directives into the members' streams."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from crew.control import company, org
from crew.control.orchestrator import orchestrator
from crew.core import events as ev
from crew.core.db import session_scope
from crew.core.models import Agent, Event, Project
from crew.domain.enums import Role


@pytest.mark.asyncio
async def test_company_bootstrap_hires_a_ceo_not_an_orchestrator(bound_loop):
    co = await company.create_company(name="Northwind", mission="own the portfolio", budget_usd=3.0)
    assert co["kind"] == "company"
    async with session_scope() as s:
        agents = (await s.scalars(select(Agent).where(Agent.project_id == co["id"]))).all()
        created = (await s.scalars(select(Event).where(Event.project_id == co["id"],
                                                       Event.type == "company.created"))).all()
    roles = [a.role for a in agents]
    assert Role.CEO.value in roles, "a company's executive is the CEO"
    assert Role.CHAIR.value in roles, "the board is seated with the company (ADR 0011)"
    assert roles.count(Role.BOARD_MEMBER.value) == 2, "two owners' seats"
    assert created and created[0].payload["name"] == "Northwind"
    # and it stays out of the ordinary project list
    listed = await org.list_projects()
    assert co["id"] not in {p["id"] for p in listed}


@pytest.mark.asyncio
async def test_attaching_a_project_repoints_the_report_chain(bound_loop, project):
    co = await company.create_company(name="Northwind", mission="x", budget_usd=3.0)
    res = await company.attach_project(company_id=co["id"], project_id=project["id"])
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        orch = await s.get(Agent, res["orchestrator_id"])
        ceo_id = (await s.get(Project, co["id"])).settings["ceo_id"]
        joined = (await s.scalars(select(Event).where(Event.project_id == co["id"],
                                                      Event.type == "company.project.joined"))).all()
    assert p.company_id == co["id"]
    assert orch.manager_id == ceo_id, "the orchestrator now reports to the CEO"
    assert joined

    # the company view carries the member and its CEO
    detail = await company.get_company(co["id"])
    assert detail["ceo"]["name"], "the company view names its CEO"
    assert {m["id"] for m in detail["projects"]} == {project["id"]}


@pytest.mark.asyncio
async def test_review_reads_the_books_and_writes_binding_directives(bound_loop, project):
    co = await company.create_company(name="Northwind", mission="x", budget_usd=3.0)
    await company.attach_project(company_id=co["id"], project_id=project["id"])
    # the member's story: heavy spend and recurring failures → at_risk (quality branch)
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        p.spend_micros = int(p.budget_cap_micros * 0.85)
        s.add(p)
    for i in range(3):
        await ev.emit("task.failed", project_id=project["id"], title="f", payload={"task_id": f"t{i}"})
    await ev.emit("task.completed", project_id=project["id"], title="c", payload={"task_id": "t9"})

    record = await company.review(company_id=co["id"])
    assert record["counts"]["at_risk"] == 1
    v = record["verdicts"][0]
    assert v["verdict"] == "at_risk" and "3 of 4" in v["directive"]

    async with session_scope() as s:
        d = (await s.scalars(select(Event).where(Event.project_id == project["id"],
                                                 Event.type == "company.directive"))).all()
        r = (await s.scalars(select(Event).where(Event.project_id == co["id"],
                                                 Event.type == "company.review.recorded"))).all()
    assert d and d[-1].payload["company_id"] == co["id"]
    assert d[-1].payload["basis"]["failed"] == 3
    assert r and r[-1].payload["counts"]["at_risk"] == 1


@pytest.mark.asyncio
async def test_directives_flow_into_the_task_prompt(bound_loop, project):
    co = await company.create_company(name="Northwind", mission="x", budget_usd=3.0)
    await ev.emit("company.directive", project_id=project["id"], agent_id="ceo-x", title="d",
                  payload={"company_id": co["id"], "directive": "tighten: freeze new spend until Friday",
                           "verdict": "at_risk", "basis": {}})
    lines = await orchestrator._company_directives(project["id"])
    assert any("freeze new spend" in line for line in lines), "a directive is read into prompts"


@pytest.mark.asyncio
async def test_found_company_lands_the_first_project_under_it(bound_loop):
    """ADR 0015: the wizard's one call, company, first project born beneath it, and the
    mission already sitting in the umbrella brain."""
    from crew.core.models import Brain, BrainEntry

    found = await company.found_company(name="Foundry", mission="ship the thing",
                                        budget_usd=4.0, project_name="Atlas",
                                        project_goal="ship atlas v1", project_budget_usd=2.0)
    co, prj = found["company"], found["project"]
    assert co["kind"] == "company" and prj["kind"] == "project"
    assert prj["company_id"] == co["id"], "born under the company"
    assert prj["company_name"] == "Foundry", "the breadcrumb's upper half ships with the payload"
    async with session_scope() as s:
        p = await s.get(Project, prj["id"])
        orch = await s.get(Agent, p.settings["orchestrator_id"])
        ceo_id = (await s.get(Project, co["id"])).settings["ceo_id"]
        joined = (await s.scalars(select(Event).where(Event.project_id == co["id"],
                                                      Event.type == "company.project.joined"))).all()
        brain = await s.scalar(select(Brain).where(Brain.project_id == co["id"],
                                                   Brain.scope == "company"))
        assert brain is not None, "the umbrella brain exists from birth"
        entries = (await s.scalars(select(BrainEntry).where(BrainEntry.brain_id == brain.id))).all()
    assert orch.manager_id == ceo_id, "orchestrator → CEO from birth, no attach step needed"
    assert joined, "the join is told on the company's own stream"
    assert any(e.title == "Mission" and e.body == "ship the thing" for e in entries), \
        "the mission seeds the company brain"


@pytest.mark.asyncio
async def test_member_agents_retrieve_the_company_brain(bound_loop, project):
    """ADR 0015: one directive in the umbrella, visible to every member's agents,
    the retrieval scope is the brain list, crossing the row boundary."""
    from crew.core.brains import brain_service
    from crew.core.models import Brain

    co = await company.create_company(name="Northwind", mission="quality before speed",
                                      budget_usd=3.0)
    await company.attach_project(company_id=co["id"], project_id=project["id"])
    async with session_scope() as s:
        brain = await s.scalar(select(Brain).where(Brain.project_id == co["id"],
                                                   Brain.scope == "company"))
    assert brain is not None
    async with session_scope() as s:
        agent = (await s.scalars(select(Agent).where(Agent.project_id == project["id"],
                                                     Agent.role == "orchestrator"))).first()
    ids = await brain_service.brains_for_agent(project["id"], agent)
    assert brain.id in ids, "the umbrella is in every member's scope"
    hits = await brain_service.search(project_id=project["id"], brain_ids=ids,
                                      query="quality before speed mission", top_k=5)
    assert any(h["brain_id"] == brain.id and "quality" in (h["body"] or "").lower()
               for h in hits), "the mission is retrievable from the member project"


@pytest.mark.asyncio
async def test_company_review_and_allocation_land_in_the_umbrella(bound_loop, project):
    """The company brain is alive: review and allocation write decisions into it."""
    co = await company.create_company(name="Northwind", mission="x", budget_usd=8.0)
    await company.attach_project(company_id=co["id"], project_id=project["id"])
    await company.review(company_id=co["id"])
    await company.allocate(company_id=co["id"])
    page = await company.brains_overview(company_id=co["id"])
    assert page["company_brain"] and page["company_brain"]["entries"] >= 2, \
        "review + allocation decisions live in the umbrella"
    members = {m["project_id"]: m for m in page["members"]}
    assert project["id"] in members
    scopes = {b["scope"] for b in members[project["id"]]["brains"]}
    assert "project" in scopes, "members list their own levels"
