"""org_tree serves the rooted tree the renderer walks — squads included.

The fresh-clone audit found the endpoint serving a flat shape the UI never read; the
first re-run then crashed on Squads (no spend column). This test walks the tree with
a real department and squad so both bugs stay dead."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from crew.control import org
from crew.core.db import session_scope
from crew.core.models import Agent, Department, Squad
from crew.domain.catalog import RoleSpec
from crew.domain.enums import Role


@pytest.mark.asyncio
async def test_org_tree_is_a_rooted_tree_with_squads(bound_loop, project):
    await org.create_department(project_id=project["id"], name="Build", mission="ship it")
    worker = await org.hire_agent(project_id=project["id"],
                                  spec=RoleSpec.from_template(Role.WORKER),
                                  rationale="contract check")
    async with session_scope() as s:
        dept = await s.scalar(select(Department).where(Department.project_id == project["id"]))
        sq = Squad(project_id=project["id"], department_id=dept.id, name="Squad A",
                   mission="one slice", lead_agent_id=None)
        s.add(sq)
        await s.flush()
        row = await s.get(Agent, worker["id"])
        row.department_id = dept.id
        row.squad_id = sq.id
        s.add(row)
        await s.flush()
        worker_spend = row.spend_today_micros

    d = await org.org_tree(project["id"])
    root = d["root"]
    assert root["kind"] == "project"
    assert "spend_micros" in root and "budget_envelope_micros" in root

    # walk: every node is one of the known kinds; the worker rides under the squad
    seen: dict[str, dict] = {}
    stack = [root]
    while stack:
        n = stack.pop()
        seen[n["id"]] = n
        assert n["kind"] in ("project", "department", "squad", "agent")
        assert isinstance(n.get("children", []), list)
        stack.extend(n.get("children", []))

    dept_node = next(n for n in root["children"] if n["kind"] == "department")
    squad_node = next(n for n in dept_node["children"] if n["kind"] == "squad")
    assert worker["id"] in {c["id"] for c in squad_node["children"]}, \
        "the worker hangs off its squad"
    assert seen[worker["id"]]["spend_micros"] == worker_spend

    # the flat index covers the tree, and the legacy keys still ride along
    assert len(d["nodes"]) == len(seen)
    assert d["project"]["id"] == project["id"] and d["departments"] is not None
    assert d["orchestrator"] and d["orchestrator"]["kind"] == "agent"


@pytest.mark.asyncio
async def test_a_project_with_nothing_on_it_still_serves_the_tree(bound_loop, project):
    """No departments, no squads, no tasks: the tree is just the project and its
    orchestrator — every node present, nothing invented."""
    d = await org.org_tree(project["id"])
    assert d["root"]["kind"] == "project"
    kids = d["root"]["children"]
    agents = [n for n in kids if n["kind"] == "agent"]
    assert len(agents) == 1 and agents[0]["role"] == "orchestrator"
    assert d["root"]["open_tasks"] == 0
