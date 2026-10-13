import json

import pytest

from crew.control import org
from crew.core.db import session_scope
from crew.core.models import Project
from crew.core.settings import settings
from crew.execution import gateway


@pytest.mark.asyncio
async def test_live_planner_reaches_provider_with_literal_json_template(project, monkeypatch):
    monkeypatch.setattr(settings, "offline_llm", False)
    monkeypatch.setattr(settings, "deepseek_api_key", "fake-planner-test-key")
    monkeypatch.setattr(settings, "tier_reasoning", "deepseek/deepseek-v4-pro")
    calls = []

    async def complete(**kwargs):
        calls.append(kwargs)
        prompt = kwargs["messages"][0]["content"]
        assert '{"interpretation":' in prompt
        assert '{skills}' not in prompt
        assert 'python' in prompt
        return json.dumps({"interpretation": "Build converter", "tasks": [{
            "key": "implement", "title": "Implement converter", "required_skills": [{"skill": "python"}],
            "acceptance_criteria": ["Unit tests pass"], "effort": "S",
        }]})

    monkeypatch.setattr(gateway, "complete", complete)
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
    plan = await org.plan_run(project=p, goal="Build converter without network access")
    assert len(calls) == 1
    assert calls[0]["compact"] is True
    assert plan.source == "llm"
    assert [t.key for t in plan.tasks] == ["implement"]


@pytest.mark.asyncio
async def test_live_planner_does_not_substitute_unrelated_work_on_truncated_output(project, monkeypatch):
    monkeypatch.setattr(settings, "offline_llm", False)
    monkeypatch.setattr(settings, "deepseek_api_key", "fake-planner-test-key")
    monkeypatch.setattr(settings, "tier_reasoning", "deepseek/deepseek-v4-pro")

    async def truncated(**kwargs):
        return '{"tasks": [{"title": "unfinished'

    monkeypatch.setattr(gateway, "complete", truncated)
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
    with pytest.raises(ValueError, match="no tasks were started"):
        await org.plan_run(project=p, goal="Write code without network access")
