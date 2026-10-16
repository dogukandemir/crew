"""Boot-time recovery: a restart cannot keep a run in flight, the engine settles what
was interrupted on the record and hands the runs back to be re-driven."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from crew.control.orchestrator import orchestrator
from crew.core.db import session_scope
from crew.core.models import Agent, Event, Run, Task
from crew.domain.enums import RunStatus, TaskState


@pytest.mark.asyncio
async def test_boot_settles_interrupted_tasks_and_hands_runs_back(bound_loop, project):
    async with session_scope() as s:
        agent = Agent(project_id=project["id"], name="Ada", role="worker", grade=1,
                      state="busy", autonomy="autonomous", mission="x")
        run = Run(project_id=project["id"], goal="g", mode="autonomous",
                  stage="EXECUTING", status=RunStatus.RUNNING.value)
        paused = Run(project_id=project["id"], goal="p", mode="autonomous",
                     stage="PLANNING", status=RunStatus.PAUSED.value)
        s.add_all([agent, run, paused])
        await s.flush()
        task = Task(project_id=project["id"], run_id=run.id, title="half-done",
                    state=TaskState.RUNNING.value, assignee_agent_id=agent.id)
        s.add(task)
        await s.flush()
        run_id, paused_id, tid = run.id, paused.id, task.id

    resumed = await orchestrator.recover_interrupted()

    ids = [rid for rid, _ in resumed]
    assert resumed == [], "restart must never repeat side effects automatically"
    assert paused_id not in ids, "a paused run is not the boot's business"
    async with session_scope() as s:
        assert (await s.get(Run, run_id)).status == RunStatus.PAUSED.value
        assert (await s.get(Agent, agent.id)).state == "idle"
        task = await s.get(Task, tid)
        types = {e.type for e in (await s.scalars(select(Event).where(
            Event.project_id == project["id"],
            Event.type.in_(("run.recovered", "task.failed"))))).all()}
    assert task.state == TaskState.FAILED.value
    assert "interrupted" in (task.escalation_reason or "")
    assert types == {"run.recovered", "task.failed"}


@pytest.mark.asyncio
async def test_boot_is_quiet_when_nothing_was_interrupted(bound_loop, project):
    async with session_scope() as s:
        done = Run(project_id=project["id"], goal="done", mode="autonomous",
                   stage="DONE", status=RunStatus.COMPLETED.value)
        s.add(done)
        await s.flush()
        done_id = done.id
    resumed = await orchestrator.recover_interrupted()
    assert all(rid != done_id for rid, _ in resumed), \
        "a completed run is never re-driven"
