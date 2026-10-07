"""ADR 0011: the board of directors, the portfolio call, and the HQ floor."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from crew.control import company, org
from crew.core import events as ev
from crew.core.db import session_scope
from crew.core.models import Agent, Event, Project
from crew.domain.enums import Role


@pytest.mark.asyncio
async def test_the_board_is_seated_and_the_ceo_reports_to_the_chair(bound_loop):
    co = await company.create_company(name="Boards Inc", mission="x", budget_usd=12.0)
    async with session_scope() as s:
        agents = (await s.scalars(select(Agent).where(Agent.project_id == co["id"]))).all()
        settings = (await s.get(Project, co["id"])).settings
        seated = (await s.scalars(select(Event).where(Event.project_id == co["id"],
                                                      Event.type == "board.seated"))).all()
    by_role = {a.role: a for a in agents}
    assert settings["chair_id"] == by_role[Role.CHAIR.value].id
    assert by_role[Role.CEO.value].manager_id == settings["chair_id"], "CEO → chair of the board"
    assert seated and seated[0].payload["chair_id"] == settings["chair_id"]

    # the HQ payload carries the floor's cast as the record has it
    hq = await company.hq(company_id=co["id"])
    assert hq["ceo"]["name"] == by_role[Role.CEO.value].name
    assert {b["role"] for b in hq["board"]} == {Role.CHAIR.value, Role.BOARD_MEMBER.value}
    assert hq["company"]["name"] == "Boards Inc"
    assert any(a["type"] == "board.seated" for a in hq["activity"])


@pytest.mark.asyncio
async def test_allocation_ranks_the_portfolio_and_freezes_a_stop(bound_loop):
    co = await company.create_company(name="Alloc Co", mission="x", budget_usd=30.0)
    good = await org.create_project(name="Good", goal="g", budget_usd=5.0)
    risky = await org.create_project(name="Risky", goal="g", budget_usd=5.0)
    dead = await org.create_project(name="Dead", goal="g", budget_usd=1.0)
    for p in (good, risky, dead):
        await company.attach_project(company_id=co["id"], project_id=p["id"])
    async with session_scope() as s:
        for pid, spent in ((good["id"], 1_000_000), (risky["id"], 4_200_000), (dead["id"], 980_000)):
            row = await s.get(Project, pid)
            row.spend_micros = spent
            s.add(row)
    # fresh activity so on_track isn't read as no_activity; ratios decide the rest
    await ev.emit("task.completed", project_id=good["id"], title="c", payload={"task_id": "g1"})
    await ev.emit("task.failed", project_id=risky["id"], title="f", payload={"task_id": "r1"})

    view = await company.portfolio(company_id=co["id"])
    assert [r["name"] for r in view["projects"]] == ["Good", "Risky", "Dead"]
    by = {r["name"]: r for r in view["projects"]}
    assert by["Dead"]["verdict"] == "stop" and by["Dead"]["share"] == 0.0

    out = await company.allocate(company_id=co["id"])
    got = {a["name"]: a for a in out["projects"]}
    assert got["Good"]["priority"] == 1 and got["Dead"]["priority"] == 3
    assert got["Dead"]["new_cap_micros"] == got["Dead"]["spend_micros"], "stop funds nothing new"
    assert got["Good"]["new_cap_micros"] > got["Risky"]["new_cap_micros"] > got["Dead"]["new_cap_micros"]
    async with session_scope() as s:
        dead_row = await s.get(Project, dead["id"])
        done = (await s.scalars(select(Event).where(Event.project_id == co["id"],
                                                    Event.type == "company.allocation.decided"))).all()
    assert dead_row.budget_cap_micros == 980_000, "the cap lands exactly on the spend"
    assert done and done[0].payload["headroom_micros"] == 30_000_000


@pytest.mark.asyncio
async def test_a_board_session_convenes_the_directors_on_the_company_ledger(bound_loop):
    co = await company.create_company(name="Sessions Inc", mission="x", budget_usd=12.0)
    out = await company.board_session(company_id=co["id"], topic="Approve the Q3 plan")
    assert out["session_id"] and len(out["panel"]) >= 3, "board + CEO sit in the session"
    async with session_scope() as s:
        conv = (await s.scalars(select(Event).where(Event.project_id == co["id"],
                                                    Event.type == "council.convened"))).all()
        board = (await s.scalars(select(Event).where(Event.project_id == co["id"],
                                                     Event.type == "board.convened"))).all()
    assert conv and conv[0].payload["question"] == "Approve the Q3 plan"
    assert board and board[0].payload["topic"] == "Approve the Q3 plan"
    assert len(board[0].payload["members"]) == 3, "chair + two seats are named in the event"


@pytest.mark.asyncio
async def test_the_hq_carries_executives_teams_and_verdicts(bound_loop):
    co = await company.create_company(name="Northwind HQ", mission="x", budget_usd=20.0)
    member = await org.create_project(name="Doc: Arctic", goal="film", budget_usd=4.0)
    await company.attach_project(company_id=co["id"], project_id=member["id"])
    await org.create_department(project_id=member["id"], name="Production", mission="shoot it")

    hq = await company.hq(company_id=co["id"])
    assert hq["projects"][0]["name"] == "Doc: Arctic"
    assert hq["projects"][0]["verdict"] in ("on_track", "no_activity", "at_risk", "stop")
    assert hq["projects"][0]["teams"][0]["name"] == "Production"
    assert hq["projects"][0]["teams"][0]["agents"] == 0
    assert any(a["type"] == "company.project.joined" for a in hq["activity"])


@pytest.mark.asyncio
async def test_the_cfo_is_a_function_chief_like_the_rest(bound_loop):
    co = await company.create_company(name="Money Inc", mission="x", budget_usd=12.0)
    chief = await company.hire_chief(company_id=co["id"], function="finance")
    async with session_scope() as s:
        row = await s.get(Agent, chief["id"])
    assert row.role == Role.CFO.value
    with pytest.raises(ValueError):
        await company.hire_chief(company_id=co["id"], function="finance")


@pytest.mark.asyncio
async def test_extra_board_seats_can_be_issued(bound_loop):
    co = await company.create_company(name="Seats Inc", mission="x", budget_usd=12.0)
    seat = await company.add_board_member(company_id=co["id"], role="board_member")
    async with session_scope() as s:
        settings = (await s.get(Project, co["id"])).settings
    assert seat["id"] in settings["board_ids"] and len(settings["board_ids"]) == 4
    with pytest.raises(ValueError):
        await company.add_board_member(company_id=co["id"], role="intern")
