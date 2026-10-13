"""Batch 1 of docs/17 — the three doors that were painted on.

- a granted approval must OPEN the gate it was requested for (it used to be recorded
  and then ignored, so the retried call was denied forever);
- a task must never be handed to an agent holding none of its required skills
  (the grade bonus is a tie-breaker, not coverage);
- one agent runs one task at a time: `busy` is claimed atomically at the start and
  released on every end path, with a reaper as the safety net.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from crew.control import org
from crew.control.orchestrator import orchestrator
from crew.core.db import session_scope
from crew.core.models import Agent, AgentSkill, Task
from crew.core.security import approval_granted, decide_approval, request_approval
from crew.domain.catalog import SKILLS, RoleSpec
from crew.domain.enums import Capability, Role, TaskState
from crew.execution.tools import invoker


async def _agent(s, project_id: str, *, name: str, skills: dict[str, float] | None = None,
                 grade: int = 1, role: str = "worker", tools: list[str] | None = None,
                 state: str = "idle") -> Agent:
    a = Agent(project_id=project_id, name=name, role=role, grade=grade, state=state,
              tools=tools if tools is not None else [], autonomy="autonomous", mission="test fixture")
    s.add(a)
    await s.flush()
    for sid, prof in (skills or {}).items():
        s.add(AgentSkill(agent_id=a.id, skill_id=sid, proficiency=prof))
    return a


def _task(project_id: str, run_id: str, title: str, required: list[dict], **kw) -> Task:
    return Task(project_id=project_id, run_id=run_id, title=title, description="d",
                deliverable="x", acceptance_criteria=["a"], output_contract={}, effort=1,
                state=TaskState.PENDING.value, required_skills=required, **kw)


@pytest.mark.asyncio
async def test_assignment_never_lands_on_an_agent_with_zero_coverage(bound_loop, project):
    """The grade bonus is a tie-breaker, not coverage (docs/17 §7)."""
    skill_id = next(iter(SKILLS)).id
    run = await orchestrator.start_run(project_id=project["id"], goal="matching floor")
    async with session_scope() as s:
        await _agent(s, project["id"], name="Zero")                       # no skills at all
        skilled = await _agent(s, project["id"], name="Skilled", skills={skill_id: 0.8})
        skilled_id = skilled.id
        t1 = _task(project["id"], run["id"], "covered", [{"skill": skill_id, "weight": 1.0}])
        t2 = _task(project["id"], run["id"], "uncovered",
                   [{"skill": "no-such-skill-anywhere", "weight": 1.0}])
        s.add_all([t1, t2])
        await s.flush()
        t1_id, t2_id = t1.id, t2.id

    n = await org.assign_tasks(project_id=project["id"], run_id=run["id"])
    assert n == 1, "only the covered task can be assigned"
    async with session_scope() as s:
        t1 = await s.get(Task, t1_id)
        t2 = await s.get(Task, t2_id)
    assert t1.state == TaskState.ASSIGNED.value and t1.assignee_agent_id == skilled_id
    assert t2.state == TaskState.BLOCKED.value, "zero-coverage must park, not assign"


@pytest.mark.asyncio
async def test_a_granted_approval_covers_its_own_scope_only(bound_loop, project):
    async with session_scope() as s:
        a = await _agent(s, project["id"], name="Requester")
        agent_id = a.id

    ap = await request_approval(project["id"], capability="fs_delete", agent_id=agent_id,
                                task_id="t-1", request={"tool": "fs_delete", "args": {}})
    assert not await approval_granted(project["id"], agent_id=agent_id,
                                      capability="fs_delete", task_id="t-1"), "pending is not granted"
    decided = await decide_approval(ap, grant=True, decided_by="tester")
    assert decided is not None and decided.state == "granted"

    assert await approval_granted(project["id"], agent_id=agent_id, capability="fs_delete", task_id="t-1")
    # a task-scoped grant must NOT double as a general one, cover another task, another
    # agent or another capability:
    assert not await approval_granted(project["id"], agent_id=agent_id, capability="fs_delete", task_id=None)
    assert not await approval_granted(project["id"], agent_id=agent_id, capability="fs_delete", task_id="t-2")
    assert not await approval_granted(project["id"], agent_id="other-agent", capability="fs_delete", task_id="t-1")
    assert not await approval_granted(project["id"], agent_id=agent_id, capability="git_push", task_id="t-1")
    # an explicitly GENERAL grant (no task) is what covers other tasks
    general = await request_approval(project["id"], capability="fs_delete", agent_id=agent_id,
                                     task_id=None, request={"tool": "fs_delete", "args": {}})
    await decide_approval(general, grant=True, decided_by="tester")
    assert await approval_granted(project["id"], agent_id=agent_id, capability="fs_delete", task_id=None)
    assert await approval_granted(project["id"], agent_id=agent_id, capability="fs_delete", task_id="t-9")


@pytest.mark.asyncio
async def test_invoker_uses_a_granted_approval_end_to_end(tool_context, bound_loop, project, tmp_path):
    """The loop a human actually sees: gated → approve → the SAME call goes through."""
    async with session_scope() as s:
        a = await _agent(s, project["id"], name="Deleter", grade=5,
                         tools=[Capability.FS_DELETE.value])
        agent_id = a.id
    agent = Agent(project_id=project["id"], name="Deleter", role="worker", grade=5, state="idle",
                  tools=[Capability.FS_DELETE.value], autonomy="autonomous", mission="x")
    agent.id = agent_id  # detached twin: policy checks read attributes, not the row
    doomed = tmp_path / "doomed.txt"
    doomed.write_text("bye", encoding="utf-8")
    ctx = await tool_context(project_id=project["id"], agent=agent, task_id="t-1", workspace=tmp_path)

    # tools run in a worker thread in production; invoke from one so run_on_loop can block
    r1 = await asyncio.to_thread(invoker.invoke, ctx, "fs_delete", {"path": "doomed.txt"})
    assert r1["ok"] is False and r1["error"] == "approval_required"
    assert doomed.exists(), "nothing may happen before the decision"

    await decide_approval(r1["approval_id"], grant=True, decided_by="tester")
    r2 = await asyncio.to_thread(invoker.invoke, ctx, "fs_delete", {"path": "doomed.txt"})
    assert r2.get("ok") is True, r2
    assert not doomed.exists(), "the approved call must actually run"


@pytest.mark.asyncio
async def test_reaper_frees_busy_agents_with_nothing_running(bound_loop, project):
    run = await orchestrator.start_run(project_id=project["id"], goal="occupancy")
    async with session_scope() as s:
        stuck = await _agent(s, project["id"], name="Stuck", state="busy")
        held = await _agent(s, project["id"], name="Held", state="busy")
        stuck_id, held_id = stuck.id, held.id
        t = _task(project["id"], run["id"], "running", [])
        t.state = TaskState.RUNNING.value
        t.assignee_agent_id = held_id
        s.add(t)

    await orchestrator._reap_occupancy(project["id"])
    async with session_scope() as s:
        stuck = await s.get(Agent, stuck_id)
        held = await s.get(Agent, held_id)
    assert stuck.state == "idle", "no running task → freed"
    assert held.state == "busy", "a real run holds its agent"


@pytest.mark.asyncio
async def test_antithrash_has_a_window(bound_loop, project):
    """A layoff blocks an identical no-rationale rehire within the window — and only within it."""
    first = await org.hire_agent(project_id=project["id"],
                                 spec=RoleSpec.from_template(Role.SPECIALIST), rationale="first hire")
    async with session_scope() as s:
        row = await s.get(Agent, first["id"])
        row.state = "archived"
        row.archived_at = datetime.now(UTC)
        s.add(row)

    with pytest.raises(ValueError, match="laid off recently"):
        await org.hire_agent(project_id=project["id"],
                             spec=RoleSpec.from_template(Role.SPECIALIST), rationale="")

    second = await org.hire_agent(project_id=project["id"],
                                  spec=RoleSpec.from_template(Role.SPECIALIST),
                                  rationale="a real reason this time")
    assert second["id"] != first["id"], "a rationale opens the door"

    # age both archives beyond the project's layoff_idle_days window (14) — the door opens
    async with session_scope() as s:
        for aid in (first["id"], second["id"]):
            row = await s.get(Agent, aid)
            row.state = "archived"
            row.archived_at = datetime.now(UTC) - timedelta(days=30)
            s.add(row)
    third = await org.hire_agent(project_id=project["id"],
                                 spec=RoleSpec.from_template(Role.SPECIALIST), rationale="")
    assert third["id"] not in (first["id"], second["id"]), "the window expires the rule"


@pytest.mark.asyncio
async def test_a_standalone_order_is_adopted_by_the_next_wave(bound_loop, project):
    """The command desk's promise: a task created outside any run (run_id NULL) must be
    picked up and executed by the next wave. It used to sit `assigned` forever — every
    wave only ever looked at tasks clamped to its own run."""
    async with session_scope() as s:
        a = await _agent(s, project["id"], name="Ordered", grade=3)
        t = Task(project_id=project["id"], run_id=None, title="prepare a launch summary",
                 description="the Captain's order", deliverable="a summary",
                 acceptance_criteria=["delivered and verified"], output_contract={},
                 effort="M", state=TaskState.ASSIGNED.value, assignee_agent_id=a.id)
        s.add(t)
        await s.flush()
        tid = t.id

    run = await orchestrator.start_run(project_id=project["id"], goal="deliver the order")
    result = await orchestrator.advance(run["id"])
    assert result["status"] == "completed", result
    async with session_scope() as s:
        t = await s.get(Task, tid)
    assert t.state == TaskState.COMPLETED.value, f"standalone order state: {t.state}"
    assert t.run_id == run["id"], "the wave adopts the standalone task into its run"
