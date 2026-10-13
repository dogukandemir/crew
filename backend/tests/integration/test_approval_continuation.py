"""A real CrewAI worker yields without more spending, then resumes its exact approval."""
import asyncio
import json
from dataclasses import replace
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import select

from crew.api import routes
from crew.api.main import create_app
from crew.control import org
from crew.control.orchestrator import orchestrator
from crew.control.workspaces import resolve_workspace
from crew.core.db import session_scope
from crew.core.models import Agent, Approval, Event, Project, RewardEvent, Run, Task
from crew.core.settings import settings
from crew.execution.models import router
from crew.execution.runner import AgentSnapshot, CrewAICrewRunner, ExecutionRequest, TaskSpec
from crew.execution.tools import TOOLS


@pytest.mark.asyncio
async def test_real_worker_waits_without_retry_penalty_and_grant_resumes_same_agent(project, bound_loop, monkeypatch):
    code = 'print("verified result")'
    responses = [
        f'Thought: Execute the check.\nAction: python_eval\nAction Input: {{"code": {json.dumps(code)}}}',
        f'Thought: Execute the approved check.\nAction: python_eval\nAction Input: {{"code": {json.dumps(code)}}}',
        'Thought: Publish the result.\nAction: artifact_publish\nAction Input: {"name":"result.txt","content":"verified result"}',
        'Thought: Complete.\nFinal Answer: Published the verified result.',
    ]

    class Provider:
        model = "gpt-4o-mini"
        calls = 0

        def get_token_usage_summary(self):
            return SimpleNamespace(prompt_tokens=self.calls * 100, completion_tokens=self.calls * 30)

        def call(self, messages):
            result = responses[self.calls]
            self.calls += 1
            return result

    provider = Provider()
    monkeypatch.setattr(router, "build_llm", lambda *args, **kwargs: provider)
    executed = []

    def execute(ctx, args):
        executed.append(args["code"])
        return {"ok": True, "data": {"stdout": "verified result", "exit_code": 0}}

    monkeypatch.setitem(TOOLS, "python_eval", replace(TOOLS["python_eval"], handler=execute))
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        workspace = resolve_workspace(p)
        agent = Agent(project_id=p.id, name="Approval worker", role="worker", grade=1,
                      autonomy="supervised", model_id="openai/gpt-4o-mini", mission="Run a check",
                      tools=["code.python", "artifact.publish"], token_cap_per_step=4096)
        run = Run(project_id=p.id, goal="Run an approved check", stage="EXECUTING")
        s.add_all([agent, run])
        await s.flush()
        task = Task(project_id=p.id, run_id=run.id, title="Approved check", state="running",
                    assignee_agent_id=agent.id, attempts=1)
        s.add(task)
        await s.flush()
        snapshot = AgentSnapshot.from_agent(agent)
        req = ExecutionRequest(project_id=p.id, run_id=run.id, trace_id="approval-regression",
            agent=snapshot, task=TaskSpec(id=task.id, title=task.title, description=task.title),
            system_prompt="Use tools. Do not fabricate results.", user_prompt="Run the check and publish result.txt.",
            workspace=workspace, artifacts=settings.artifacts_dir(p.id))

    result = await asyncio.to_thread(CrewAICrewRunner().run_task, req)
    assert result.escalation == "approval_required"
    assert provider.calls == 1 and executed == []
    await orchestrator._record_task_result(run, p, task.id, snapshot, result, 0, req.agent.model_id, 1)
    await orchestrator._park_for_approval(run.id, task.id, result.error)
    assert await org.revive_blocked(p.id, run.id) == 0
    await orchestrator._execute(run, p)
    async with session_scope() as s:
        blocked = await s.get(Task, task.id)
        assert blocked.state == "blocked" and blocked.attempts == 0
        assert (await s.get(Run, run.id)).status == "paused"
        assert await s.scalar(select(RewardEvent).where(RewardEvent.task_id == task.id)) is None
        approval = await s.get(Approval, result.error)
        assert approval.request["args"] == {"code": code}

    scheduled = []

    async def schedule(project_id, run_id):
        scheduled.append((project_id, run_id))

    monkeypatch.setattr(routes, "drive_after_commit", schedule)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app()), base_url="http://localhost") as client:
        response = await client.post(f"/api/approvals/{result.error}/grant", json={"reason": "Test approval"})
    assert response.status_code == 200, response.text
    assert scheduled == [(p.id, run.id)]
    async with session_scope() as s:
        resumed = await s.get(Task, task.id)
        assert resumed.state == "assigned" and resumed.assignee_agent_id == agent.id and resumed.attempts == 0
        assert (await s.get(Run, run.id)).status == "running"
        assert await s.scalar(select(Event).where(Event.task_id == task.id, Event.type == "user.steering"))
        resumed.state = "running"

    result = await asyncio.to_thread(CrewAICrewRunner().run_task, req)
    assert result.ok, result.error
    assert executed == [code] and provider.calls == 4
    async with session_scope() as s:
        assert (await s.get(Approval, approval.id)).state == "consumed"
        assert (await s.get(Project, p.id)).reserved_micros == 0
