"""Real CrewAI loop and tool adapters, deterministic provider, no external requests."""
import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from crew.control.workspaces import resolve_workspace
from crew.core.db import session_scope
from crew.core.models import Agent, Artifact, Event, Project, Run, Task
from crew.core.settings import settings
from crew.execution.models import router
from crew.execution.runner import AgentSnapshot, CrewAICrewRunner, ExecutionRequest, TaskSpec


@pytest.mark.asyncio
@pytest.mark.parametrize("premature_answer", [False, True])
@pytest.mark.parametrize("routed_model", ["openai/gpt-4o-mini", "deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"])
async def test_real_crewai_loop_writes_and_publishes_with_accounted_generations(project, bound_loop, monkeypatch, routed_model, premature_answer):
    responses = [
        'Thought: Write the requested file.\nAction: fs_write\nAction Input: {"path":"result.txt","content":"real harness artifact"}\nObservation: {"invented": "provider ignored stop"}',
        'Thought: Publish the deliverable.\nAction: artifact_publish\nAction Input: {"name":"result.txt","source_path":"result.txt"}',
        'Thought: The file is written and published.\nFinal Answer: Created result.txt containing real harness artifact.',
    ]
    if premature_answer:
        responses.insert(0, 'Thought: Done.\nFinal Answer: I wrote and published result.txt.')

    class DeterministicProvider:
        model = routed_model.split("/", 1)[1]  # Native SDKs normalize away the provider prefix.
        calls = 0

        def get_token_usage_summary(self):
            return SimpleNamespace(prompt_tokens=self.calls * 100, completion_tokens=self.calls * 30)

        def call(self, messages):
            assert any("Observation" in stop for stop in self.stop)
            prompt = "\n".join(m["content"] for m in messages)
            assert "You are a careful assistant. Use the provided tools." in prompt
            assert "Write and publish result.txt containing real harness artifact." in prompt
            assert "Action Input" in prompt and "fs_write" in prompt and "artifact_publish" in prompt
            assert "content" in prompt and "path" in prompt
            assert self.calls < len(responses), "unexpected extra provider call"
            response = responses[self.calls]
            self.calls += 1
            return response

    provider = DeterministicProvider()
    monkeypatch.setattr(router, "build_llm", lambda *args, **kwargs: provider)
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        workspace = resolve_workspace(p)
        a = Agent(project_id=p.id, name="Harness test", role="worker", grade=5,
                  autonomy="autonomous", model_id=routed_model, mission="Write the requested artifact",
                  tools=["fs.workspace", "artifact.publish"], token_cap_per_step=4096)
        r = Run(project_id=p.id, goal="Write a small artifact")
        s.add_all([a, r])
        await s.flush()
        t = Task(project_id=p.id, run_id=r.id, title="Write result", state="running", assignee_agent_id=a.id)
        s.add(t)
        await s.flush()
        req = ExecutionRequest(project_id=p.id, run_id=r.id, trace_id="harness-regression",
                               agent=AgentSnapshot.from_agent(a), task=TaskSpec(id=t.id, title=t.title, description=t.title),
                               system_prompt="You are a careful assistant. Use the provided tools.",
                               user_prompt="Write and publish result.txt containing real harness artifact.",
                               workspace=workspace, artifacts=settings.artifacts_dir(p.id))
    result = await asyncio.wait_for(asyncio.to_thread(CrewAICrewRunner().run_task, req), timeout=60)
    assert result.ok, result.error
    assert provider.calls == len(responses)
    assert (workspace / "result.txt").read_text() == "real harness artifact"
    async with session_scope() as s:
        artifacts = (await s.scalars(select(Artifact).where(Artifact.task_id == t.id))).all()
        usage = (await s.scalars(select(Event).where(Event.run_id == r.id, Event.type == "llm.response"))).all()
        p = await s.get(Project, project["id"])
        (await s.get(Run, r.id)).status = "completed"
    assert len(artifacts) == 1
    assert await asyncio.to_thread(Path(artifacts[0].path).read_text) == "real harness artifact"
    assert len(usage) == len(responses)
    assert all(e.payload["model"] == routed_model for e in usage)
    assert result.tokens_in == 100 * len(responses) and result.tokens_out == 30 * len(responses)
    assert p.reserved_micros == 0
    assert p.spend_micros == result.cost_micros == sum(e.cost_micros for e in usage) > 0
