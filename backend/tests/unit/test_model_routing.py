"""DeepSeek V4 routing (docs/04 §2): current model ids, peak prices, and reasoning_effort,
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
    # peak, cache-miss rates, the budget guard errs conservative
    assert router.price("deepseek/deepseek-flash") == (0.30, 1.20)
    assert router.price("deepseek/deepseek-v4-pro") == (1.32, 3.96)
    with pytest.raises(ValueError, match="No price configured"):
        router.price("deepseek/something-retired")


def test_price_matching_cannot_confuse_provider_or_model_variants(monkeypatch):
    from crew.core.settings import settings

    for model in ("openai/gpt-4.1-mini", "unknown/gpt-4o", "hosted/ollama/llama", "openai/gpt-4o-more-expensive"):
        with pytest.raises(ValueError, match="No price configured"):
            router.price(model)
    monkeypatch.setattr(settings, "model_prices", {"custom/expensive": (20.0, 100.0)})
    assert router.cost_micros("custom/expensive", 100, 10) == 3000
    for price in ((-1, 2), (1, float("inf")), (float("nan"), 1)):
        with pytest.raises(ValidationError):
            Settings(_env_file=None, model_prices={"custom/invalid": price})


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
    assert captured["reasoning_effort"] == "low"

    class _OpenAIAgent(_Agent):
        model_id = "gpt-4o-mini"

    router.build_llm(_OpenAIAgent())  # type: ignore[arg-type]
    assert "reasoning_effort" not in captured, "non-DeepSeek providers never see the knob"


def test_onboarding_offers_the_standard_tier_provider():
    state = onboarding.state()
    assert state["provider"] == "deepseek"
    assert state["model"] == "deepseek/deepseek-flash"
