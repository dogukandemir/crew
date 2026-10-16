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


class CacheProvider:
    """Reports the buckets the way the provider does: prompt tokens, a prefix-cache hit, and
    thinking tokens inside the completion."""

    def __init__(self, prompt=10_000, cached=9_000, completion=1_000):
        self.calls = 0
        self.prompt, self.cached, self.completion = prompt, cached, completion

    def get_token_usage_summary(self):
        return SimpleNamespace(prompt_tokens=self.prompt * self.calls,
                               completion_tokens=self.completion * self.calls,
                               cached_prompt_tokens=self.cached * self.calls,
                               reasoning_tokens=400 * self.calls)

    def call(self, messages):
        self.calls += 1
        return "answer"


@pytest.mark.asyncio
async def test_a_prefix_cache_hit_is_billed_at_the_cache_rate(project, monkeypatch):
    """The ledger has to describe what the provider charges: DeepSeek bills a repeated prefix
    at the cache-hit rate and halves every rate off-peak. Until 16 October every input token
    was charged at the peak miss rate, so the screen showed more than the invoice."""
    from crew.execution import gateway as gw
    from crew.execution import models as model_mod

    monkeypatch.setattr(gw, "is_peak", lambda at=None: True)          # pin the peak window
    monkeypatch.setattr(model_mod, "is_peak", lambda at=None: True)
    provider = CacheProvider()
    usages = []
    _, usage = await call_model(provider, model="deepseek/deepseek-flash", messages="hello",
                                project_id=project["id"], on_usage=usages.append)
    # 1,000 missed input at $0.30/M + 9,000 cached input at $0.006/M + 1,000 output at $1.20/M
    assert usage["cost_micros"] == 1_554
    assert usage["cached_tokens_in"] == 9_000 and usage["reasoning_tokens"] == 400
    assert usage["peak"] is True
    async with session_scope() as s:
        event = (await s.scalars(select(Event).where(Event.project_id == project["id"],
                                                     Event.type == "llm.response"))).one()
    assert event.payload["cached_tokens_in"] == 9_000
    assert event.payload["reasoning_tokens"] == 400
    assert event.payload["peak"] is True
    # The same call billed as if nothing had been cached would cost 4,200 micros.
    assert usage["cost_micros"] < model_mod.router.cost_micros(
        "deepseek/deepseek-flash", 10_000, 1_000, at=None)


@pytest.mark.asyncio
async def test_the_planner_disables_thinking_on_deepseek(project, monkeypatch):
    """Planning has to return complete JSON inside a bounded output allowance, and thinking
    is ON by default at high effort now, so the compact path turns it off explicitly."""
    import crewai

    from crew.execution import gateway as gw

    captured: dict = {}

    class FakeLLM:
        def __init__(self, **kw):
            captured.update(kw)

        def call(self, messages, **kwargs):
            return "{}"

        def get_token_usage_summary(self):
            return SimpleNamespace(prompt_tokens=0, completion_tokens=0)

    monkeypatch.setattr(crewai, "LLM", FakeLLM)
    await gw.complete(project_id=project["id"], model="deepseek/deepseek-flash",
                      messages=[{"role": "user", "content": "plan the work"}], compact=True)
    assert captured["reasoning_effort"] == "none"
    assert captured["max_tokens"] == 4096
