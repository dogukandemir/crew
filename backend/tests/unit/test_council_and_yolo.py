"""The stalls the live runs hit (14 October 2026), closed by tests: human
gates get a per-project off switch (YOLO), council outcomes act instead of parking,
and verification reads the producer's final attempt, not its history (ADR 0018)."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from crew.control.orchestrator import MAX_TASK_ATTEMPTS, orchestrator
from crew.core import events as ev
from crew.core.db import session_scope
from crew.core.models import Event, Project, Run, Task
from crew.core.security import policy
from crew.domain.enums import Capability, Grade, PolicyOutcome, RunStatus, TaskState


def test_yolo_project_turns_the_human_gates_off(fake_agent, fake_project):
    a = fake_agent(role="lead", grade=Grade.MID, tools=[Capability.SHELL_SANDBOX.value],
                   autonomy="supervised")
    p = fake_project(settings={"yolo": True})
    decision = policy.check(agent=a, capability=Capability.SHELL_SANDBOX, project=p)
    assert decision.outcome == PolicyOutcome.ALLOW


def test_yolo_does_not_lift_capability_ceilings(fake_agent, fake_project):
    a = fake_agent(role="worker", grade=Grade.SENIOR, tools=[Capability.DECISION_BIND.value],
                   autonomy="autonomous")
    p = fake_project(settings={"yolo": True})
    assert policy.check(agent=a, capability=Capability.DECISION_BIND,
                        project=p).outcome == PolicyOutcome.DENY


def test_current_artifacts_scope_to_the_last_attempt():
    from crew.control.verify import current_artifacts
    from crew.core.models import Artifact

    def art(name: str, attempt: int | None):
        meta = {"name": name} if attempt is None else {"name": name, "attempt": attempt}
        return Artifact(project_id="p", task_id="t", kind="file", path=f"x/{name}",
                        bytes=1, sha256="0" * 64, meta=meta)

    first, second, report, unstamped = (
        art("guide.md", 1), art("guide.md", 2), art("report.md", 2), art("notes.md", None))
    keep = current_artifacts([first, second, report, unstamped])
    assert second in keep and report in keep and unstamped in keep and first not in keep


class _Outcome:
    def __init__(self, option: str):
        self.chosen_option = option


async def _seed(project, *, attempts: int = MAX_TASK_ATTEMPTS,
                criteria: list[str] | None = None, prior_retries: int = 0) -> tuple[str, str]:
    async with session_scope() as s:
        run = Run(project_id=project["id"], goal="g", mode="autonomous",
                  stage="EXECUTING", status=RunStatus.RUNNING.value)
        s.add(run)
        await s.flush()
        task = Task(project_id=project["id"], run_id=run.id, title="One-page guide",
                    state=TaskState.FAILED.value, attempts=attempts,
                    acceptance_criteria=criteria or ["a", "b", "c", "d"])
        s.add(task)
        await s.flush()
        run_id, task_id = run.id, task.id
    for i in range(prior_retries):
        await ev.emit("task.council.retry", project_id=project["id"], run_id=run_id,
                      task_id=task_id, severity="notice", title="seed retry",
                      payload={"option": "retry_more_budget", "retries": i + 1, "criteria": []},
                      actor="system:test")
    return run_id, task_id


def _patch_council(monkeypatch, option: str) -> None:
    from crew.control import orchestrator as mod

    async def fake_convene(**kwargs):
        return {"session_id": "sess-1"}

    async def fake_round(**kwargs):
        return []

    async def fake_decide(*, project, session_id, decider=None):
        return _Outcome(option)

    monkeypatch.setattr(mod.council, "convene", fake_convene)
    monkeypatch.setattr(mod.council, "run_round", fake_round)
    monkeypatch.setattr(mod.council, "decide", fake_decide)


async def _escalate(project, run_id: str, task_id: str) -> None:
    async with session_scope() as s:
        run = await s.get(Run, run_id)
        proj = await s.get(Project, project["id"])
    await orchestrator._escalate_failed_task(run, proj, task_id, "verification fail")


@pytest.mark.asyncio
async def test_council_retry_requeues_instead_of_parking(bound_loop, project, monkeypatch):
    run_id, task_id = await _seed(project)
    _patch_council(monkeypatch, "retry_more_budget")
    await _escalate(project, run_id, task_id)
    async with session_scope() as s:
        task = await s.get(Task, task_id)
        assert task.state == TaskState.READY.value
        assert task.attempts == MAX_TASK_ATTEMPTS - 2
        retries = (await s.scalars(select(Event).where(
            Event.task_id == task_id, Event.type == "task.council.retry"))).all()
    assert len(retries) == 1


@pytest.mark.asyncio
async def test_council_reduce_scope_shrinks_criteria_and_retries(bound_loop, project, monkeypatch):
    run_id, task_id = await _seed(project, criteria=["one", "two", "three", "four"])
    _patch_council(monkeypatch, "reduce_scope")
    await _escalate(project, run_id, task_id)
    async with session_scope() as s:
        task = await s.get(Task, task_id)
        assert task.state == TaskState.READY.value
        assert task.acceptance_criteria == ["one", "two"]


@pytest.mark.asyncio
async def test_council_retry_cap_aborts_the_task(bound_loop, project, monkeypatch):
    run_id, task_id = await _seed(project, prior_retries=2)
    _patch_council(monkeypatch, "retry_more_budget")
    await _escalate(project, run_id, task_id)
    async with session_scope() as s:
        task = await s.get(Task, task_id)
        assert task.state == TaskState.ABORTED.value
        assert "retry cap" in (task.escalation_reason or "")
