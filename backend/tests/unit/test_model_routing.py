"""DeepSeek V4 routing (docs/04 §2): current model ids, peak prices, and reasoning_effort —
after V4, thinking is a request parameter, not a separate model."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from crew.control import onboarding
from crew.core.settings import Settings
from crew.execution.models import router


def test_defaults_are_v4_not_the_retired_names():
    s = Settings(_env_file=None)
    assert s.tier_standard == "deepseek/deepseek-flash"
    assert s.tier_fast == "deepseek/deepseek-flash"
    assert s.tier_reasoning == "deepseek/deepseek-v4-pro"
    for tier in ("tier_standard", "tier_fast", "tier_reasoning"):
        value = getattr(s, tier)
        assert "deepseek-chat" not in value and "deepseek-reasoner" not in value


def test_prices_follow_the_provider_page():
    # peak, cache-miss rates — the budget guard errs conservative
    assert router.price("deepseek/deepseek-flash") == (0.30, 1.20)
    assert router.price("deepseek/deepseek-v4-pro") == (1.32, 3.96)
    # an unknown DeepSeek id (e.g. a retired alias) bills as Flash, not the generic default
    assert router.price("deepseek/something-retired") == (0.30, 1.20)


def test_reasoning_effort_is_validated():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, reasoning_effort="yolo")


def test_reasoning_effort_reaches_deepseek_llms_only(monkeypatch):
    import crewai

    captured: dict = {}

    class FakeLLM:
        def __init__(self, **kw):
            captured.clear()
            captured.update(kw)

    monkeypatch.setattr(crewai, "LLM", FakeLLM)

    class _Agent:
        model_tier = "standard"
        role = "worker"
        model_id = ""
        token_cap_per_step = 4000

    router.build_llm(_Agent())  # type: ignore[arg-type]
    assert captured["model"].startswith("deepseek/")
    assert captured["reasoning_effort"] == "high"

    class _OpenAIAgent(_Agent):
        model_id = "gpt-4o-mini"

    router.build_llm(_OpenAIAgent())  # type: ignore[arg-type]
    assert "reasoning_effort" not in captured, "non-DeepSeek providers never see the knob"


def test_onboarding_offers_the_standard_tier_provider():
    state = onboarding.state()
    assert state["provider"] == "deepseek"
    assert state["model"] == "deepseek/deepseek-flash"
