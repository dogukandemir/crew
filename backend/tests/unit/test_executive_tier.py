"""ADR 0008 / docs/02 §2: the executive tier, one chief per function, once a function
reaches two departments, with the heads re-seated to report through it."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from crew.control import org
from crew.core.db import session_scope
from crew.core.models import Agent, Department, Event, Project
from crew.domain.catalog import MIN_TIER_FOR_ROLE, ROLE_TEMPLATES
from crew.domain.enums import Grade, ModelTier, Role


async def _dept_with_head(s, project_id: str, name: str, category: str) -> tuple[str, str]:
    d = Department(project_id=project_id, name=name, mission=f"{name} mission", status="active",
                   charter={"category": category})
    s.add(d)
    await s.flush()
    head = Agent(project_id=project_id, department_id=d.id, name=f"{name} Head", role="head",
                 grade=4, state="idle", tools=[], autonomy="autonomous", mission="head")
    s.add(head)
    await s.flush()
    d.head_agent_id = head.id
    s.add(d)
    return d.id, head.id


def test_the_executive_vocabulary_is_complete():
    for role in (Role.CTO, Role.CMO, Role.CPO, Role.COO):
        assert ROLE_TEMPLATES[role].base_grade == Grade.CHIEF
        assert MIN_TIER_FOR_ROLE[role] == ModelTier.REASONING


@pytest.mark.asyncio
async def test_two_departments_of_a_function_earn_one_chief(bound_loop, project):
    async with session_scope() as s:
        _, eng_head = await _dept_with_head(s, project["id"], "Engineering", "engineering")
        _, data_head = await _dept_with_head(s, project["id"], "Data", "data")
        _, design_head = await _dept_with_head(s, project["id"], "Design", "design")
        p = await s.get(Project, project["id"])

    created = await org._staff_function_chiefs(project=p, run_id="r-1", orchestrator_id=None)
    # growth hires seat the Head of People first (ADR 0016), the chief is the story here
    hr = [c for c in created if c.get("role") == Role.HR.value]
    assert len(hr) == 1, "the first growth wave seats a Head of People"
    assert hr[0]["name"] and " " in hr[0]["name"], "and it is a person, not a 'Head #1'"
    chiefs = [c for c in created if c.get("role") in {r.value for r in (Role.CTO, Role.CMO, Role.CPO, Role.COO)}]
    assert len(chiefs) == 1, "exactly one function reached two departments"
    chief = chiefs[0]
    assert chief["role"] == Role.CTO.value and chief["grade"] == Grade.CHIEF

    async with session_scope() as s:
        assert (await s.get(Agent, eng_head)).manager_id == chief["id"], "engineering reports to the CTO"
        assert (await s.get(Agent, data_head)).manager_id == chief["id"], "data reports to the CTO"
        assert (await s.get(Agent, design_head)).manager_id != chief["id"], "product is untouched"
        events = (await s.scalars(select(Event).where(Event.project_id == project["id"],
                                                      Event.type == "org.function.formed"))).all()
    assert len(events) == 1 and events[0].payload["function"] == "technology"

    # the lookup a later department's head hire uses
    assert await org._function_chief_id(project["id"], "security") == chief["id"]
    assert await org._function_chief_id(project["id"], "design") is None

    # idempotent: a working chief is never duplicated
    again = await org._staff_function_chiefs(project=p, run_id="r-2", orchestrator_id=None)
    assert again == []
