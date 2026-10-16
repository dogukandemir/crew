"""Efficiency fixes from the 16 October live runs: a file written into the workspace has
to count as a registered deliverable, and a money stop must name its cause and never
latch on a cap that is not the project's own."""

from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path

import pytest
from sqlalchemy import select

from crew.control.orchestrator import orchestrator
from crew.core.db import session_scope
from crew.core.models import Agent, Artifact, Project, Run, Task
from crew.core.security import BudgetExceeded, budget
from crew.domain.enums import Capability, RunStatus
from crew.execution.tools import invoker


async def _agent(s, project_id: str, name: str, *, tools: list[str] | None = None) -> Agent:
    a = Agent(project_id=project_id, name=name, role="worker", grade=2, state="idle",
              tools=tools if tools is not None else [], autonomy="autonomous", mission="x")
    s.add(a)
    await s.flush()
    return a


@pytest.mark.asyncio
async def test_fs_write_registers_the_deliverable_for_verification(
        tool_context, bound_loop, project):
    """The live run's agent wrote landing_page_da.md with fs_write; the verifier saw
    "0 registered artifact(s)" and failed the task. A workspace write IS the deliverable."""
    async with session_scope() as s:
        agent = await _agent(s, project["id"], "Writer", tools=[Capability.FS_WORKSPACE.value])
        run = Run(project_id=project["id"], goal="Write the guide", status=RunStatus.RUNNING.value)
        s.add(run)
        await s.flush()
        task = Task(project_id=project["id"], run_id=run.id, title="Write the guide",
                    state="running", attempts=2, assignee_agent_id=agent.id)
        s.add(task)
        await s.flush()
        task_id, run_id, agent_id = task.id, run.id, agent.id
    ctx = await tool_context(project_id=project["id"], agent=agent, task_id=task_id, run_id=run_id)
    body = "# Guide\n\nSign up, then take the first punch.\n"
    out = await asyncio.to_thread(invoker.invoke, ctx, "fs_write",
                                  {"path": "guide.md", "content": body})
    assert out["ok"] is True, out
    async with session_scope() as s:
        rows = (await s.scalars(select(Artifact).where(Artifact.task_id == task_id))).all()
    assert len(rows) == 1
    artifact = rows[0]
    assert artifact.agent_id == agent_id
    assert (artifact.meta or {}).get("name") == "guide.md"
    assert (artifact.meta or {}).get("attempt") == 2  # the producer's final attempt
    stored = await asyncio.to_thread(Path(artifact.path).read_bytes)
    assert stored.decode() == body  # byte exact, no newline mangling
    assert artifact.sha256 == hashlib.sha256(stored).hexdigest()


@pytest.mark.asyncio
async def test_a_scope_cap_refusal_does_not_latch_the_project_breaker(project):
    """docs/08 §8: a scope refusal fails the job. Only the project or company envelope
    stops the run, otherwise one worker's daily cap freezes every other agent's work."""
    async with session_scope() as s:
        agent = await _agent(s, project["id"], "Capped Worker")
        agent.spend_cap_per_run_micros = 50_000
        s.add(agent)
        run = Run(project_id=project["id"], goal="Capped worker", status=RunStatus.RUNNING.value)
        s.add(run)
        await s.flush()
        agent_id, run_id = agent.id, run.id
    with pytest.raises(BudgetExceeded):
        await budget.reserve(project["id"], amount_micros=200_000, scope_kind="agent",
                             scope_id=agent_id, ref="task-1", run_id=run_id,
                             idempotency_key="reserve:scope:1")
    assert budget.breaker_open(project["id"]) is False
    assert await budget.envelope_available(project["id"]) > 0


@pytest.mark.asyncio
async def test_an_exhausted_envelope_pauses_the_run_with_its_cause_and_heals(project):
    async with session_scope() as s:
        agent = await _agent(s, project["id"], "Broke Worker")
        agent_id = agent.id
        p = await s.get(Project, project["id"])
        p.spend_micros = p.budget_cap_micros  # the envelope is empty
        s.add(p)
    with pytest.raises(BudgetExceeded):
        await budget.reserve(project["id"], amount_micros=1_000, scope_kind="agent",
                             scope_id=agent_id, ref="task-1", idempotency_key="reserve:env:1")
    assert budget.breaker_open(project["id"]) is True
    assert await orchestrator._budget_stop_stands(project["id"]) is True

    async with session_scope() as s:
        run = Run(project_id=project["id"], goal="Speed test", status=RunStatus.RUNNING.value)
        s.add(run)
        await s.flush()
        run_id = run.id
    async with session_scope() as s:
        proj = await s.get(Project, project["id"])
        run_row = await s.get(Run, run_id)
    await orchestrator._pause_for_budget(run_row, proj)
    async with session_scope() as s:
        row = await s.get(Run, run_id)
        assert row.status == RunStatus.PAUSED_BUDGET.value
        assert "envelope is exhausted" in (row.error or "")
        assert "Raise the cap" in (row.error or "")

    async with session_scope() as s:  # the operator raises the cap
        p = await s.get(Project, project["id"])
        p.budget_cap_micros += 2_000_000
        s.add(p)
    assert await orchestrator._budget_stop_stands(project["id"]) is False
    assert budget.breaker_open(project["id"]) is False


@pytest.mark.asyncio
async def test_the_verifier_reads_a_workspace_write_as_evidence(project, tool_context, bound_loop):
    """The other half of the live failure: registering the write is not enough while the
    verifier's authority check accepts only the artifact store. The four tasks failed with
    "0 chars" and "artifact is outside this task's authority" while their files were on
    disk, so both halves (register the write, accept the workspace) are what heals a run."""
    from crew.control import verify

    criteria = "Sign up, take the first punch, and read the guide."
    async with session_scope() as s:
        agent = await _agent(s, project["id"], "Verifier Evidence Writer",
                             tools=[Capability.FS_WORKSPACE.value])
        run = Run(project_id=project["id"], goal="Write the guide", status=RunStatus.RUNNING.value)
        s.add(run)
        await s.flush()
        task = Task(project_id=project["id"], run_id=run.id, title="Write the guide",
                    state="running", attempts=1, acceptance_criteria=[criteria],
                    assignee_agent_id=agent.id)
        s.add(task)
        await s.flush()
        task_id, run_id = task.id, run.id
    ctx = await tool_context(project_id=project["id"], agent=agent, task_id=task_id, run_id=run_id)
    body = ("# Guide\n\n" + criteria + " The guide walks the signup, the punch flow, the "
            "payment and the support path in the order a new owner meets them.\n")
    out = await asyncio.to_thread(invoker.invoke, ctx, "fs_write", {"path": "guide.md", "content": body})
    assert out["ok"] is True, out
    async with session_scope() as s:
        task_row = await s.get(Task, task_id)
    outcome = await verify.verifier.verify_task(project_id=project["id"], task=task_row,
                                                result_text=body)
    integrity = [c for c in outcome.checks if c["name"] == "artifact_integrity"]
    assert integrity and all(c["ok"] for c in integrity), outcome.checks
    assert any(c["name"] == "evidence_present" and c["ok"] for c in outcome.checks), outcome.checks
    assert outcome.passed, outcome.checks
