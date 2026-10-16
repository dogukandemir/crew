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
    """Verified on 16 October 2026 against api-docs.deepseek.com/quick_start/pricing: peak
    rates with a prefix-cache bucket, off-peak at exactly half, thinking billed as output."""
    from datetime import UTC, datetime

    from crew.execution.models import PriceSpec, is_peak

    assert router.price("deepseek/deepseek-flash") == PriceSpec(0.006, 0.30, 1.20, 0.5)
    assert router.price("deepseek/deepseek-v4-pro") == PriceSpec(0.044, 1.32, 3.96, 0.5)
    with pytest.raises(ValueError, match="No price configured"):
        router.price("deepseek/something-retired")

    peak = datetime(2026, 10, 16, 2, 0, tzinfo=UTC)        # Friday, inside 01:00-04:00 UTC
    off = datetime(2026, 10, 16, 12, 0, tzinfo=UTC)        # Friday 12:00 UTC is off-peak
    weekend = datetime(2026, 10, 17, 2, 0, tzinfo=UTC)     # Saturday: off-peak all day
    assert is_peak(peak) and not is_peak(off) and not is_peak(weekend)

    # 1M input that all missed plus 1M output: the peak card, then the same at half price.
    assert router.cost_micros("deepseek/deepseek-flash", 1_000_000, 1_000_000, at=peak) == 1_500_000
    assert router.cost_micros("deepseek/deepseek-flash", 1_000_000, 1_000_000, at=off) == 750_000
    # The same input served from the prefix cache: 0.006 instead of 0.30 per million.
    assert router.cost_micros("deepseek/deepseek-flash", 1_000_000, 0, cached_in=1_000_000,
                              at=peak) == 6_000
    # A hit is still billed, and never more hits than input tokens arrive.
    assert router.cost_micros("deepseek/deepseek-v4-pro", 1_000_000, 0, cached_in=2_000_000,
                              at=peak) == 44_000
    # The reservation stays conservative: peak, cache MISS over the whole input.
    assert router.estimate_cost_micros("deepseek/deepseek-flash", 1_000_000, 1_000_000) == 1_500_000


def test_price_matching_cannot_confuse_provider_or_model_variants(monkeypatch):
    from crew.core.settings import settings

    for model in ("openai/gpt-4.1-mini", "unknown/gpt-4o", "hosted/ollama/llama", "openai/gpt-4o-more-expensive"):
        with pytest.raises(ValueError, match="No price configured"):
            router.price(model)
    monkeypatch.setattr(settings, "model_prices", {"custom/expensive": (20.0, 100.0)})
    assert router.cost_micros("custom/expensive", 100, 10) == 3000
    # A third number names the cache-hit bucket, so an operator can price a cached provider.
    monkeypatch.setattr(settings, "model_prices", {"custom/cached": (1.0, 20.0, 100.0)})
    assert router.cost_micros("custom/cached", 100, 10) == 3000
    assert router.cost_micros("custom/cached", 100, 10, cached_in=100) == 1100
    for price in ((-1, 2), (1, float("inf")), (float("nan"), 1)):
        with pytest.raises(ValidationError):
            Settings(_env_file=None, model_prices={"custom/invalid": price})
    with pytest.raises(ValidationError):
        Settings(_env_file=None, model_prices={"custom/one-number": (5.0,)})


def test_reasoning_effort_accepts_the_providers_set_and_maps_its_legacy_names():
    """Thinking is a request parameter now: the current set is none|low|high|max, thinking is
    on by default at high, and the older spellings map onto it (thinking_mode guide)."""
    assert Settings(_env_file=None, reasoning_effort="none").reasoning_effort == "none"
    assert Settings(_env_file=None, reasoning_effort="MAX").reasoning_effort == "max"
    assert Settings(_env_file=None, reasoning_effort="minimal").reasoning_effort == "low"
    assert Settings(_env_file=None, reasoning_effort="medium").reasoning_effort == "high"
    assert Settings(_env_file=None, reasoning_effort="xhigh").reasoning_effort == "high"
    assert Settings(_env_file=None, reasoning_effort="ultra").reasoning_effort == "max"
    with pytest.raises(ValidationError):
        Settings(_env_file=None, reasoning_effort="yolo")


def test_the_status_surface_explains_what_a_spend_number_costs(monkeypatch):
    """A number on screen has to be explainable: the window in force and the rate card."""
    from datetime import UTC, datetime

    from crew.execution import models as model_mod

    original = model_mod.is_peak
    monkeypatch.setattr(model_mod, "is_peak",
                        lambda at=None: original(datetime(2026, 10, 16, 2, 0, tzinfo=UTC)))
    snapshot = router.pricing_snapshot()
    assert snapshot["peak_now"] is True
    assert snapshot["peak_windows_utc"] == [[1, 4], [6, 10]]
    assert snapshot["reasoning_effort"] == "low"
    assert snapshot["tiers"]["standard"]["per_million_tokens"]["cache_hit"] == 0.006
    assert snapshot["tiers"]["standard"]["per_million_tokens"]["cache_miss"] == 0.30
    assert snapshot["tiers"]["standard"]["per_million_tokens"]["off_peak_multiplier"] == 0.5


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
