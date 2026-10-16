"""ADR 0013 (revision): the provider picker, roster, tier presets, local Ollama."""

from __future__ import annotations

import json

import pytest

from crew.control import onboarding
from crew.core.settings import settings


def test_roster_is_first_class_and_ordered():
    ids = [p["id"] for p in onboarding.PROVIDER_META]
    assert ids == ["deepseek", "openai", "anthropic", "openrouter", "ollama"]
    for pid in ids:
        assert pid in onboarding.PROVIDERS, f"{pid} must be a first-class provider"
    kinds = {p["id"]: p["kind"] for p in onboarding.PROVIDER_META}
    assert kinds["ollama"] == "local", "Ollama is the LOCAL tile, deliberately"
    assert all(kinds[i] == "key" for i in ids if i != "ollama")
    # HTTP providers verify against their models endpoint; local Ollama verifies by
    # reaching the machine's own server instead (custom branch in verify()).
    assert onboarding.PROVIDERS["openrouter"][2] == "https://openrouter.ai/api/v1/key"
    assert onboarding.PROVIDERS["ollama"][2] is None


def test_state_offers_the_picker_roster():
    state = onboarding.state()
    assert state["providers"], "the picker roster must always be present"
    assert {p["id"] for p in state["providers"]} == {p["id"] for p in onboarding.PROVIDER_META}
    assert all("configured" in p for p in state["providers"])


def test_ollama_base_normalisation():
    assert onboarding.normalize_ollama_base("") == onboarding.DEFAULT_OLLAMA_BASE
    assert onboarding.normalize_ollama_base("http://box:11434/") == "http://box:11434"
    assert onboarding.normalize_ollama_base("  http://box:11434  ") == "http://box:11434"


@pytest.mark.asyncio
async def test_local_ollama_is_verified_by_reaching_it():
    # Port 9 (discard) never has a listener: deterministic loopback refusal, no network.
    ok, detail = await onboarding.verify("ollama", "http://127.0.0.1:9")
    assert ok is False and "couldn't reach Ollama" in detail
    assert "ollama serve" in detail


def test_presets_point_the_tiers_and_persist(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    before = {name: getattr(settings, f"tier_{name}")
              for name in ("reasoning", "standard", "fast")}
    try:
        preset = onboarding.apply_presets("openrouter")
        assert settings.tier_standard == "openrouter/openai/gpt-4o-mini"
        assert preset["reasoning"].startswith("openrouter/")
        saved = json.loads((tmp_path / "provider.json").read_text(encoding="utf-8"))
        assert saved["provider"] == "openrouter"
        assert saved["tiers"]["standard"] == "openrouter/openai/gpt-4o-mini"
    finally:
        for name, value in before.items():
            setattr(settings, f"tier_{name}", value)


def test_ollama_pricing_is_zero_so_local_never_eats_the_budget():
    from crew.execution.models import router
    assert router.price("ollama/llama3.2").cache_miss == 0.0
    assert router.price("ollama/llama3.2").cache_hit == 0.0
    assert router.price("ollama/llama3.2").output == 0.0
    assert router.estimate_cost_micros("ollama/llama3.2", 10_000, 4_000) == 0
