from types import SimpleNamespace

import pytest
from sqlalchemy import select

from crew.control import onboarding, org
from crew.control.orchestrator import MAX_TASK_ATTEMPTS, orchestrator
from crew.core import events
from crew.core.db import session_scope
from crew.core.models import Event, Project, Run, Task
from crew.core.settings import settings


@pytest.mark.asyncio
@pytest.mark.parametrize("interrupted", ["paused", "aborted"])
async def test_stale_learning_cannot_overwrite_a_stop_or_start_follow_on_work(project, monkeypatch, interrupted):
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        run = Run(project_id=p.id, goal="Finishing", stage="LEARNING")
        s.add(run)
        await s.flush()
        s.add(Task(project_id=p.id, run_id=run.id, title="Done", state="completed"))
    # The caller retained a running snapshot, but the operator stopped it meanwhile.
    async with session_scope() as s:
        (await s.get(Run, run.id)).status = interrupted

    async def forbidden(*args):
        raise AssertionError("Stopped runs must not start follow-on work")

    monkeypatch.setattr(orchestrator, "_maybe_cadence", forbidden)
    await orchestrator._learn(run, p)
    async with session_scope() as s:
        current = await s.get(Run, run.id)
        assert current.status == interrupted and current.report == {}
        assert await s.scalar(select(Event).where(Event.run_id == run.id, Event.type == "run.completed")) is None


@pytest.mark.asyncio
async def test_final_report_and_completion_event_roll_back_together(project, monkeypatch):
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        run = Run(project_id=p.id, goal="Atomic report", stage="LEARNING")
        s.add(run)
        await s.flush()
        s.add(Task(project_id=p.id, run_id=run.id, title="Done", state="completed"))
    original = events.emit

    async def fail(*args, **kwargs):
        result = await original(*args, **kwargs)
        if args and args[0] == "run.completed":
            raise RuntimeError("completion event failed")
        return result

    monkeypatch.setattr(events, "emit", fail)
    with pytest.raises(RuntimeError, match="completion event failed"):
        await orchestrator._learn(run, p)
    async with session_scope() as s:
        current = await s.get(Run, run.id)
        assert current.status == "running" and current.report == {}
        assert await s.scalar(select(Event).where(Event.run_id == run.id, Event.type == "run.completed")) is None


@pytest.mark.asyncio
async def test_pause_after_learning_commit_does_not_repeat_the_lesson_on_resume(project, monkeypatch):
    from crew.core.brains import brain_service
    from crew.core.db import after_commit
    from crew.core.models import Agent, BrainEntry

    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        agent = Agent(project_id=p.id, name="Learner", role="worker")
        run = Run(project_id=p.id, goal="Resume learning", stage="LEARNING")
        s.add_all([agent, run])
        await s.flush()
        task = Task(project_id=p.id, run_id=run.id, title="Verified output", state="completed", assignee_agent_id=agent.id)
        s.add(task)
        await s.flush()
    original = brain_service.write
    writes = []

    async def write_then_pause(**kwargs):
        entry = await original(**kwargs)
        writes.append(entry["id"])

        async def stop():
            await orchestrator.pause_project(p.id)

        await after_commit(stop)
        return entry

    async def no_background_work(run_id):
        return {}

    monkeypatch.setattr(brain_service, "write", write_then_pause)
    monkeypatch.setattr(orchestrator, "advance", no_background_work)
    await orchestrator._learn(run, p)
    async with session_scope() as s:
        assert (await s.get(Run, run.id)).status == "paused"
    await orchestrator.resume_project(p.id)
    await orchestrator._learn(run, p)
    async with session_scope() as s:
        lessons = (await s.scalars(select(BrainEntry).where(BrainEntry.project_id == p.id,
            BrainEntry.source["task_id"].as_string() == task.id))).all()
        assert len(lessons) == len(writes) == 1
        assert (await s.get(Run, run.id)).status == "completed"


@pytest.mark.asyncio
@pytest.mark.parametrize("operator_paused", [False, True])
@pytest.mark.parametrize("granted", [False, True])
async def test_approval_decision_releases_only_parked_task_and_preserves_operator_pause(project, operator_paused, granted):
    from crew.core.models import Agent, Approval

    async with session_scope() as s:
        agent = Agent(project_id=project["id"], name="Waiting worker", role="worker")
        run = Run(project_id=project["id"], goal="Approval decision", status="paused",
                  error="" if operator_paused else "Waiting for operator approval")
        s.add_all([agent, run])
        await s.flush()
        task = Task(project_id=project["id"], run_id=run.id, title="Waiting", state="blocked",
                    assignee_agent_id=agent.id)
        s.add(task)
        await s.flush()
        approval = Approval(project_id=project["id"], task_id=task.id, agent_id=agent.id,
                            capability="code.python", state="granted" if granted else "denied",
                            request={"run_id": run.id, "tool": "python_eval", "args": {"code": "print(1)"}})
        s.add(approval)
        await s.flush()
        task.escalation_reason = f"approval_required:{approval.id}"
    result = await orchestrator.approval_decided(approval.id, granted=granted)
    assert result == (None if operator_paused else (project["id"], run.id))
    async with session_scope() as s:
        assert (await s.get(Task, task.id)).state == ("assigned" if granted else "aborted")
        assert (await s.get(Run, run.id)).status == ("paused" if operator_paused else "running")


@pytest.mark.asyncio
async def test_expired_permission_can_be_requested_again_only_after_explicit_resume(project, monkeypatch):
    from crew.core.models import Agent, Approval

    async with session_scope() as s:
        agent = Agent(project_id=project["id"], name="Renewal worker", role="worker")
        run = Run(project_id=project["id"], goal="Expired", status="paused", stage="EXECUTING")
        s.add_all([agent, run])
        await s.flush()
        task = Task(project_id=project["id"], run_id=run.id, title="Waiting", state="blocked",
                    assignee_agent_id=agent.id)
        s.add(task)
        await s.flush()
        approval = Approval(project_id=project["id"], task_id=task.id, agent_id=agent.id,
                            capability="code.python", state="expired", request={"run_id": run.id})
        s.add(approval)
        await s.flush()
        task.escalation_reason = f"approval_required:{approval.id}"

    async def no_provider(run_id):
        return {}

    monkeypatch.setattr(orchestrator, "advance", no_provider)
    assert await org.revive_blocked(project["id"], run.id) == 0
    await orchestrator.resume_project(project["id"])
    async with session_scope() as s:
        assert (await s.get(Task, task.id)).state == "assigned"
        assert (await s.get(Approval, approval.id)).state == "expired"


@pytest.mark.asyncio
async def test_approval_continuation_waits_for_prior_wave_instead_of_disappearing(project, monkeypatch):
    import asyncio

    from crew.api.routes import _drive

    started, release = asyncio.Event(), asyncio.Event()
    calls = []
    run = await orchestrator.start_run(project_id=project["id"], goal="Resume race")

    async def wave(run_id):
        calls.append(run_id)
        started.set()
        await release.wait()
        return {"run_id": run_id, "status": "paused"}

    monkeypatch.setattr(orchestrator, "_advance", wave)
    first = asyncio.create_task(orchestrator.advance(run["id"]))
    await started.wait()
    continuation = asyncio.create_task(_drive(project["id"], run["id"]))
    await asyncio.sleep(0)
    assert calls == [run["id"]]
    release.set()
    await asyncio.gather(first, continuation)
    assert calls == [run["id"], run["id"]]


@pytest.mark.asyncio
@pytest.mark.parametrize("unfinished", ["failed", "aborted", "blocked"])
async def test_partial_delivery_is_failed_and_cannot_start_cadence(project, monkeypatch, unfinished):
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        run = Run(project_id=p.id, goal="All requirements must pass")
        s.add(run)
        await s.flush()
        s.add_all([Task(project_id=p.id, run_id=run.id, title="Delivered", state="completed"),
                   Task(project_id=p.id, run_id=run.id, title="Missing", state=unfinished)])

    async def forbidden(*args):
        raise AssertionError("Failed runs must not start cadence")

    monkeypatch.setattr(orchestrator, "_maybe_cadence", forbidden)
    await orchestrator._learn(run, p)
    async with session_scope() as s:
        assert (await s.get(Run, run.id)).status == "failed"


@pytest.mark.asyncio
async def test_driver_failure_persists_terminal_status_and_error(project, monkeypatch):
    from crew.api.routes import _drive

    run = await orchestrator.start_run(project_id=project["id"], goal="Malformed provider plan")

    async def fail(run_id):
        raise ValueError("Live planning failed; no tasks were started")

    monkeypatch.setattr(orchestrator, "advance", fail)
    await _drive(project["id"], run["id"])
    async with session_scope() as s:
        row = await s.get(Run, run["id"])
        assert row.status == "failed" and row.ended_at is not None
        assert "Live planning failed" in row.error


@pytest.mark.asyncio
@pytest.mark.parametrize("choice", ["retry_more_budget", "reduce_scope"])
async def test_council_life_lines_are_bounded_and_capped(project, monkeypatch, choice):
    """ADR 0018: a failure council requeues the task (two fresh attempts, or a criteria
    set of at most two), but a task gets at most two council life-lines before the third
    failure aborts it. The old contract (never requeue, always abort) turned every hard
    task into an operator dead end; the KaffeKlip runs paid for that twice."""
    from crew.control.council import council

    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        run = Run(project_id=p.id, goal="Bounded retries")
        s.add(run)
        await s.flush()
        task = Task(project_id=p.id, run_id=run.id, title="Failed task", state="failed", attempts=3,
                    acceptance_criteria=["Works correctly", "Tests pass"])
        s.add(task)
        await s.flush()

    async def convene(**kwargs):
        return {"session_id": "test"}

    async def run_round(**kwargs):
        return None

    async def decide(**kwargs):
        return SimpleNamespace(chosen_option=choice)

    monkeypatch.setattr(council, "convene", convene)
    monkeypatch.setattr(council, "run_round", run_round)
    monkeypatch.setattr(council, "decide", decide)

    # life-line 1 and 2: requeued, attempts reset, criteria never widened
    for _ in range(2):
        await orchestrator._escalate_failed_task(run, p, task.id, "verification failed")
        async with session_scope() as s:
            row = await s.get(Task, task.id)
            assert row.state == "ready"
            assert row.attempts == MAX_TASK_ATTEMPTS - 2
            assert len(row.acceptance_criteria or []) <= 2
            row.state = "failed"  # the next attempt failed again
            s.add(row)

    # life-line 3: the cap aborts, and the reason says so
    await orchestrator._escalate_failed_task(run, p, task.id, "verification failed")
    async with session_scope() as s:
        row = await s.get(Task, task.id)
        assert row.state == "aborted"
        assert "retry cap" in (row.escalation_reason or "")


@pytest.mark.asyncio
async def test_project_summaries_follow_real_run_status_instead_of_stored_idle_stage(project):
    run = await orchestrator.start_run(project_id=project["id"], goal="Visible activity")
    for p in [await org.get_project(project["id"]), next(p for p in await org.list_projects() if p["id"] == project["id"])]:
        assert p["stage"] == "INTAKE"
        assert p["active_run"] is True
        assert p["latest_run_id"] == run["id"]
    await orchestrator.cancel_run(run["id"])
    p = await org.get_project(project["id"])
    assert p["stage"] == "ABORTED"
    assert p["active_run"] is False
    assert p["latest_run_id"] == run["id"]


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["mode", "provider"])
async def test_provider_verification_cannot_change_configuration_after_run_starts(project, monkeypatch, operation):
    monkeypatch.setattr(settings, "tier_standard", "openai/gpt-4o-mini")
    monkeypatch.setattr(settings, "openai_api_key", "test-key-not-a-real-provider-secret")
    monkeypatch.setattr(settings, "offline_llm", True)

    async def verify(*args):
        await orchestrator.start_run(project_id=project["id"], goal="Admitted during verification")
        return True, "verified"

    monkeypatch.setattr(onboarding, "verify", verify)
    with pytest.raises(ValueError, match="Finish or cancel"):
        if operation == "mode":
            await onboarding.set_mode("live")
        else:
            await onboarding.save_provider_key("openai", "another-fake-test-key")
    assert settings.offline_llm is True
    assert settings.openai_api_key == "test-key-not-a-real-provider-secret"
    async with session_scope() as s:
        run = await s.scalar(select(Run).where(Run.project_id == project["id"]))
    await orchestrator.cancel_run(run.id)


@pytest.mark.asyncio
async def test_pending_confirmation_blocks_new_runs_and_configuration_changes(project):
    async with session_scope() as s:
        run = Run(project_id=project["id"], goal="Waiting", status="pending_confirmation")
        s.add(run)
    with pytest.raises(ValueError, match="active run"):
        await orchestrator.start_run(project_id=project["id"], goal="Duplicate")
    with pytest.raises(ValueError, match="Finish or cancel"):
        await onboarding.set_mode("demo")
    await orchestrator.cancel_run(run.id)


@pytest.mark.asyncio
async def test_cancel_event_failure_rolls_back_state_before_stopping_workers(project, monkeypatch):
    from crew.execution import lifecycle

    run = await orchestrator.start_run(project_id=project["id"], goal="Atomic cancellation")
    cancelled = []
    monkeypatch.setattr(lifecycle, "cancel", lambda run_id: cancelled.append(run_id))
    original = events.emit

    async def fail(*args, **kwargs):
        await original(*args, **kwargs)
        raise RuntimeError("event failure")

    monkeypatch.setattr(events, "emit", fail)
    with pytest.raises(RuntimeError, match="event failure"):
        await orchestrator.cancel_run(run["id"])
    assert cancelled == []
    async with session_scope() as s:
        assert (await s.get(Run, run["id"])).status == "running"
        assert await s.scalar(select(Event).where(Event.run_id == run["id"], Event.type == "run.aborted")) is None
    monkeypatch.setattr(events, "emit", original)
    await orchestrator.cancel_run(run["id"])


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["completed", "aborted", "verifying"])
async def test_late_result_cannot_overwrite_terminal_or_already_recorded_task(project, state):
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        run = Run(project_id=p.id, goal="Late result")
        s.add(run)
        await s.flush()
        task = Task(project_id=p.id, run_id=run.id, title="Protected result", state=state, result_text="Original")
        s.add(task)
        await s.flush()
    result = SimpleNamespace(text="Duplicate", cost_micros=10, tokens_in=1, tokens_out=1, ok=True)
    await orchestrator._record_task_result(run, p, task.id, None, result, 0, "test", 1)
    async with session_scope() as s:
        current = await s.get(Task, task.id)
        assert current.state == state
        assert current.result_text == "Original"
        assert (await s.get(Run, run.id)).cost_micros == 0
        (await s.get(Run, run.id)).status = "completed"
