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
