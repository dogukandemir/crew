"""ADR 0016: souls, deterministic people, human names, the SOUL prompt section."""

from __future__ import annotations

import pytest

from crew.control import org
from crew.core.db import session_scope
from crew.core.models import Agent
from crew.domain import soul
from crew.domain.catalog import RoleSpec
from crew.domain.enums import Role
from crew.execution.prompt import build_system_prompt


def test_soul_composes_deterministically_and_reads_like_a_person():
    a = soul.compose_soul(role="analyst", grade=1, seed="p1:analyst:1")
    b = soul.compose_soul(role="analyst", grade=1, seed="p1:analyst:1")
    c = soul.compose_soul(role="analyst", grade=1, seed="p1:analyst:2")
    assert a == b, "same seed, same person"
    assert a["name"] != c["name"]
    assert len(a["traits"]) == 3 and a["values"] and a["vision"] and a["voice"]
    assert a["background"] and a["source"] == "deterministic"
    md = soul.render_soul_md(a, role_title="Analyst")
    assert md.startswith(f"# {a['name']}") and a["vision"] in md and "## Personality" in md


def test_names_come_from_the_demographic_pools():
    names = {soul.compose_soul(role="worker", grade=1, seed=f"x:{i}")["name"]
             for i in range(60)}
    assert len(names) >= 50, "collisions are the exception, never the rule"
    assert all(len(n.split()) >= 2 for n in names), "every hire has a first and last name"


def test_leader_banks_differ_from_craft_banks():
    lead = soul.compose_soul(role="orchestrator", grade=5, seed="s:1")
    craft = soul.compose_soul(role="worker", grade=1, seed="s:1")
    assert set(lead["traits"]) != set(craft["traits"])
    assert soul.role_archetype("cto") == "leader"
    assert soul.role_archetype("analyst") == "craft"
    assert soul.role_archetype("critic") == "scrutiny"


@pytest.mark.asyncio
async def test_a_hire_gets_a_soul_and_the_prompt_carries_it(bound_loop, project):
    a = await org.hire_agent(project_id=project["id"],
                             spec=RoleSpec.from_template(Role.WORKER),
                             rationale="soul test")
    async with session_scope() as s:
        row = await s.get(Agent, a["id"])
    assert row.soul and row.soul["source"] == "deterministic"
    assert row.name == row.soul["name"] and " " in row.name
    assert row.prompt_version == 2
    bundle = build_system_prompt(name=row.name, role=row.role, grade=row.grade,
                                 mission=row.mission, autonomy=row.autonomy,
                                 soul=row.soul)
    assert "## SOUL" in bundle.system
    assert row.soul["vision"] in bundle.system


@pytest.mark.asyncio
async def test_employee_names_stay_unique_within_a_project(bound_loop, project):
    a = await org.hire_agent(project_id=project["id"],
                             spec=RoleSpec.from_template(Role.WORKER), rationale="u1")
    b = await org.hire_agent(project_id=project["id"],
                             spec=RoleSpec.from_template(Role.WORKER), rationale="u2")
    assert a["name"] != b["name"]


def test_the_name_walk_steps_past_every_taken_name_deterministically():
    """F15: uniqueness is a property of the walk, not of a lucky draw."""
    import random

    first = soul.pick_name(random.Random("crew-soul:p:worker:1"))[3]
    again = soul.pick_name(random.Random("crew-soul:p:worker:1"), {first})[3]
    assert again != first
    assert soul.pick_name(random.Random("crew-soul:p:worker:1"), {first})[3] == again, \
        "same seed and same taken set, same walk"
    taken = {soul.pick_name(random.Random(f"x:{i}"))[3] for i in range(300)}
    fresh = soul.pick_name(random.Random("crew-soul:p:worker:1"), taken)[3]
    assert fresh not in taken, "a walk that runs into taken names keeps going"


@pytest.mark.asyncio
async def test_a_second_project_never_hires_a_name_that_already_exists(bound_loop, project):
    """F15: the name pools used to be seeded per project, so a hire on a second
    project could be the same person as a hire on the first."""
    from sqlalchemy import func, select

    from crew.core.db import session_scope
    from crew.core.models import Agent

    second = await org.create_project(name="Second Floor", goal="ship the other slice",
                                      budget_usd=5.0)
    async with session_scope() as s:
        idx = int(await s.scalar(select(func.count(Agent.id))
                                 .where(Agent.project_id == second["id"])) or 0) + 1
    # The name the second project's own seed would compose first, placed on the first
    # project's roster: under the old per-project check this hire came out twice.
    squatted = soul.compose_soul(role="worker", grade=1,
                                 seed=f"{second['id']}:worker:{idx}")["name"]
    async with session_scope() as s:
        s.add(Agent(project_id=project["id"], name=squatted, role="worker", grade=1,
                    state="idle"))
        await s.flush()
        names_before = set(await s.scalars(select(Agent.name)))

    hired = await org.hire_agent(project_id=second["id"],
                                 spec=RoleSpec.from_template(Role.WORKER), rationale="u3")
    assert hired["name"] not in names_before, \
        "the same person cannot exist on two floors"


@pytest.mark.asyncio
async def test_agent_snapshot_carries_the_soul_into_the_execution_path(bound_loop, project):
    """The live runner builds its CrewAI agent from AgentSnapshot, the soul must ride."""
    from crew.execution.runner import AgentSnapshot

    a = await org.hire_agent(project_id=project["id"],
                             spec=RoleSpec.from_template(Role.WORKER), rationale="snap")
    async with session_scope() as s:
        row = await s.get(Agent, a["id"])
    snap = AgentSnapshot.from_agent(row)
    assert snap.soul and snap.soul["vision"] == row.soul["vision"]
    assert snap.soul["voice"]
