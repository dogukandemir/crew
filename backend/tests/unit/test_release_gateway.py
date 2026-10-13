from types import SimpleNamespace

import pytest
from sqlalchemy import select

from crew.core.db import session_scope
from crew.core.models import Event, Project
from crew.core.security import budget
from crew.execution.gateway import call_model


class Provider:
    def __init__(self, fail=False):
        self.calls = 0
        self.fail = fail
    def get_token_usage_summary(self):
        return SimpleNamespace(prompt_tokens=100 * self.calls, completion_tokens=20 * self.calls)
    def call(self, messages):
        self.calls += 1
        if self.fail:
            raise RuntimeError("provider interrupted")
        return "answer"


@pytest.mark.asyncio
async def test_unpriced_model_never_reaches_provider(project):
    provider = Provider()
    with pytest.raises(ValueError, match="No price configured"):
        await call_model(provider, model="custom/unpriced", messages="hello", project_id=project["id"])
    assert provider.calls == 0


@pytest.mark.asyncio
async def test_each_generation_is_settled_once(project):
    provider = Provider()
    usages = []
    for _ in range(2):
        result, _usage = await call_model(provider, model="openai/gpt-4o-mini", messages="hello",
                                         project_id=project["id"], on_usage=usages.append)
        assert result == "answer"
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
        events = (await s.scalars(select(Event).where(Event.project_id == p.id,
                                                      Event.type == "llm.response"))).all()
    assert p.reserved_micros == 0
    assert len(events) == 2
    assert p.spend_micros == sum(u["cost_micros"] for u in usages) > 0
    assert sum(e.tokens_in for e in events) == 200


@pytest.mark.asyncio
async def test_unknown_failure_charges_reservation_and_reports_usage(project):
    usages = []
    provider = Provider(fail=True)
    with pytest.raises(RuntimeError, match="interrupted"):
        await call_model(provider, model="openai/gpt-4o-mini", messages="hello",
                         project_id=project["id"], on_usage=usages.append)
    assert provider.calls == 1
    assert usages[0]["usage_state"] == "unknown_reserved"
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
    assert p.reserved_micros == 0
    assert p.spend_micros == usages[0]["cost_micros"] > 0


@pytest.mark.asyncio
async def test_restart_accounts_for_unknown_usage_once(project):
    await budget.reserve(project["id"], amount_micros=123, scope_kind="project",
                         scope_id=project["id"], ref="interrupted-call")
    await budget.recover_reservations()
    await budget.recover_reservations()
    async with session_scope() as s:
        p = await s.get(Project, project["id"])
    assert p.reserved_micros == 0 and p.spend_micros == 123
