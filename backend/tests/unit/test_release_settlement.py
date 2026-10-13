from types import SimpleNamespace

import pytest
from sqlalchemy import select

from crew.control.orchestrator import orchestrator
from crew.control.verify import verifier
from crew.core.db import session_scope
from crew.core.models import Agent, Event, Project, RewardEvent, Run, Task
from crew.core.reward import reward_engine
from crew.domain.enums import Verdict


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["cancel", "reward_error"])
async def test_verification_cannot_reward_after_cancel_or_partially_commit(project, monkeypatch, failure):
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        a = Agent(project_id=p.id, name="Atomic producer", role="worker", grade=1)
        run = Run(project_id=p.id, goal="Atomic completion")
        s.add_all([a, run])
        await s.flush()
        task = Task(project_id=p.id, run_id=run.id, title="Atomic task", state="verifying",
                    assignee_agent_id=a.id, attempts=1, result_text="result")
        s.add(task)
        await s.flush()

    async def pick(**kwargs):
        return None

    async def verify(**kwargs):
        if failure == "cancel":
            await orchestrator.cancel_run(run.id)
        return SimpleNamespace(passed=True, verdict=Verdict.PASS, quality=0.9,
                               verifier_agent_id=None, contradiction=False)

    original = reward_engine.settle_task

    async def fail_after_reward(**kwargs):
        await original(**kwargs)
        raise ValueError("injected settlement failure")

    monkeypatch.setattr(verifier, "pick_verifier", pick)
    monkeypatch.setattr(verifier, "verify_task", verify)
    result = SimpleNamespace(ok=True, tool_error_rate=0)
    if failure == "reward_error":
        monkeypatch.setattr(reward_engine, "settle_task", fail_after_reward)
        with pytest.raises(ValueError, match="settlement failure"):
            await orchestrator._verify_and_reward(run, p, task.id, result, 1)
    else:
        await orchestrator._verify_and_reward(run, p, task.id, result, 1)
    async with session_scope() as s:
        assert (await s.get(Task, task.id)).state == ("aborted" if failure == "cancel" else "verifying")
        assert await s.scalar(select(RewardEvent).where(RewardEvent.task_id == task.id)) is None
        assert await s.scalar(select(Event).where(Event.task_id == task.id, Event.type == "task.completed")) is None
        assert (await s.get(Agent, a.id)).tasks_done == 0
        if failure == "reward_error":
            (await s.get(Run, run.id)).status = "failed"
