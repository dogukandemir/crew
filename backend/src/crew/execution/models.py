"""Model routing: grade → tier → concrete model, with a price table for budgeting (docs/04 §2).

Prices are **USD per million tokens** (the ledger stores micro-USD), taken from the provider's
published rate card and carrying the buckets the provider actually bills:

- input served from the provider's prefix cache (on DeepSeek Flash a hit is 50x cheaper than a
  miss, and the cache is automatic for a repeated prefix),
- input that missed the cache,
- output, which on DeepSeek includes the thinking tokens.

DeepSeek also prices by time of day: peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday
through Friday, and every other hour (plus all weekend) bills at half. Verified on 16 October
2026 against https://api-docs.deepseek.com/quick_start/pricing. A reservation still uses the
peak cache-miss rate, so the guard errs conservative; the settlement uses the buckets the
provider reports for that call.

Unknown hosted models fail closed. Operators can supply exact-model overrides through
CREW_MODEL_PRICES after checking their provider's actual terms.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from crew.core.models import Agent
from crew.core.settings import settings
from crew.domain.catalog import MIN_TIER_FOR_ROLE
from crew.domain.enums import ModelTier, Role

log = logging.getLogger("crew.models")


@dataclass(frozen=True)
class PriceSpec:
    """A provider's rate card in USD per million tokens, at its PEAK rate."""

    cache_hit: float
    cache_miss: float
    output: float
    # DeepSeek halves every rate outside its peak windows; 1.0 means the provider has no
    # time-of-day pricing (see `is_peak`, which is DeepSeek's window rule).
    off_peak_multiplier: float = 1.0


# Exact provider/model → peak rate card. Only a rate verified against the provider's own
# published page carries a cache-hit bucket; everywhere else a hit is priced as a miss, which
# errs conservative instead of inventing a discount.
PRICES: dict[str, PriceSpec] = {
    # DeepSeek (legacy deepseek-chat/-reasoner retired 2026-07-24). Cache hits are automatic
    # for a repeated prefix; off-peak is half of peak.
    "deepseek/deepseek-flash": PriceSpec(cache_hit=0.006, cache_miss=0.30, output=1.20,
                                         off_peak_multiplier=0.5),
    "deepseek/deepseek-v4-pro": PriceSpec(cache_hit=0.044, cache_miss=1.32, output=3.96,
                                          off_peak_multiplier=0.5),
    "openai/gpt-4o-mini": PriceSpec(0.15, 0.15, 0.60),
    "openai/gpt-4o": PriceSpec(2.50, 2.50, 10.00),
    "openai/gpt-4.1": PriceSpec(2.00, 2.00, 8.00),
    "openai/o4-mini": PriceSpec(1.10, 1.10, 4.40),
    "openai/text-embedding-3-small": PriceSpec(0.02, 0.02, 0.0),
    "anthropic/claude-3-5-haiku-20241022": PriceSpec(0.80, 0.80, 4.00),
    "anthropic/claude-haiku-4-5-20251001": PriceSpec(1.00, 1.00, 5.00),
    "anthropic/claude-sonnet-4-6": PriceSpec(3.00, 3.00, 15.00),
    "gemini/gemini-2.5-flash": PriceSpec(0.30, 0.30, 2.50),
    "gemini/gemini-2.5-pro": PriceSpec(1.25, 1.25, 10.00),
    "openrouter/openai/gpt-4o-mini": PriceSpec(0.15, 0.15, 0.60),
    "openrouter/anthropic/claude-sonnet-4.6": PriceSpec(3.00, 3.00, 15.00),
}

# DeepSeek's peak windows, as [start_hour, end_hour) in UTC on weekdays. Everything else,
# weekends included, is off-peak.
PEAK_WINDOWS_UTC: tuple[tuple[int, int], ...] = ((1, 4), (6, 10))

# rough output-token fraction used for pre-flight reservations
EST_OUTPUT_FRACTION = 0.35


def is_peak(at: datetime | None = None) -> bool:
    """Whether the provider bills its peak rate right now (DeepSeek's window rule)."""
    moment = (at or datetime.now(UTC)).astimezone(UTC)
    if moment.weekday() >= 5:  # Saturday, Sunday: the whole day is off-peak
        return False
    return any(start <= moment.hour < end for start, end in PEAK_WINDOWS_UTC)


def _spec_from_override(price: tuple[float, ...]) -> PriceSpec:
    """CREW_MODEL_PRICES entries: (cache_miss, output) or (cache_hit, cache_miss, output)."""
    if len(price) == 2:
        miss, out = price
        return PriceSpec(cache_hit=miss, cache_miss=miss, output=out)
    if len(price) == 3:
        return PriceSpec(cache_hit=price[0], cache_miss=price[1], output=price[2])
    raise ValueError("prices are (cache_miss, output) or (cache_hit, cache_miss, output)")


@dataclass(frozen=True)
class ModelChoice:
    tier: ModelTier
    model: str
    api_key: str = ""
    base_url: str = ""
    token_cap: int = 8_000


class ModelRouter:
    def tier_for_agent(self, agent: Agent) -> ModelTier:
        tier = ModelTier(agent.model_tier or "fast")
        floor = MIN_TIER_FOR_ROLE.get(Role(agent.role))
        if floor is not None and _rank(tier) < _rank(floor):
            # policy: a decider/critic/orchestrator may never be downgraded to a cheap model
            return floor
        return tier

    def model_for_tier(self, tier: ModelTier) -> str:
        return {
            ModelTier.REASONING: settings.tier_reasoning,
            ModelTier.STANDARD: settings.tier_standard,
            ModelTier.FAST: settings.tier_fast,
            ModelTier.EMBED: settings.tier_embed,
        }[tier]

    def choice_for_agent(self, agent: Agent, *, escalate: int = 0) -> ModelChoice:
        tier = self.tier_for_agent(agent)
        for _ in range(max(0, escalate)):
            tier = _upgrade(tier)
        model = agent.model_id or self.model_for_tier(tier)
        if escalate and not agent.model_id:
            model = self.model_for_tier(tier)
        return ModelChoice(tier=tier, model=model, api_key=settings.provider_key_for(model),
                           base_url=settings.ollama_base_url if model.startswith("ollama") else "",
                           token_cap=agent.token_cap_per_step or 8_000)

    def build_llm(self, agent: Agent, *, escalate: int = 0, temperature: float = 0.2):
        """Construct a CrewAI LLM. Kept lazy so importing this module never needs crewai."""
        from crewai import LLM

        choice = self.choice_for_agent(agent, escalate=escalate)
        kwargs: dict[str, Any] = {"model": choice.model, "temperature": temperature,
                                 "max_tokens": min(choice.token_cap, 4096),
                                 "timeout": 60, "max_retries": 0}
        if choice.api_key:
            kwargs["api_key"] = choice.api_key
        if choice.base_url:
            kwargs["base_url"] = choice.base_url
        if choice.model.startswith("deepseek"):
            # DeepSeek V4: thinking is a request parameter, not a model. CrewAI's LLM
            # forwards reasoning_effort to LiteLLM; non-DeepSeek providers never see it.
            kwargs["reasoning_effort"] = settings.reasoning_effort
        return LLM(**kwargs)

    @staticmethod
    def price(model: str) -> PriceSpec:
        """The provider's peak rate card for this model. An unknown model fails closed."""
        if model in settings.model_prices:
            return _spec_from_override(tuple(settings.model_prices[model]))
        # Local inference has no per-token provider charge; host costs are excluded.
        if model.startswith("ollama/"):
            return PriceSpec(0.0, 0.0, 0.0)
        key = model if "/" in model else f"openai/{model}"
        if key in PRICES:
            return PRICES[key]
        raise ValueError(f"No price configured for model {model!r}; set CREW_MODEL_PRICES before Live use")

    def cost_micros(self, model: str, tokens_in: int, tokens_out: int, *,
                    cached_in: int = 0, at: datetime | None = None) -> int:
        """What one call costs at the provider's published rates.

        `cached_in` is the part of `tokens_in` the provider served from its prefix cache
        (DeepSeek reports it as `prompt_cache_hit_tokens`); the rest is billed as a miss.
        `at` is when the call was billed, which decides peak or off-peak.
        """
        spec = self.price(model)
        multiplier = spec.off_peak_multiplier if not is_peak(at) else 1.0
        cached = max(0, min(int(cached_in), int(tokens_in)))
        missed = max(0, int(tokens_in) - cached)
        micros = missed * spec.cache_miss + cached * spec.cache_hit + int(tokens_out) * spec.output
        return int(round(micros * multiplier))

    def estimate_cost_micros(self, model: str, tokens_in: int, tokens_out: int | None = None) -> int:
        """A reservation: the peak cache-miss rate over the whole input, so the guard errs
        conservative. Settlements price the buckets the provider reports (`cost_micros`)."""
        spec = self.price(model)
        out = tokens_out if tokens_out is not None else int(tokens_in * EST_OUTPUT_FRACTION)
        return int(round(tokens_in * spec.cache_miss + out * spec.output))

    def pricing_snapshot(self) -> dict:
        """What the ledger charges right now: the peak window, the rate card and the thinking
        effort in force. Served on the status surface so a number on screen can be explained."""
        def card(model: str) -> dict:
            spec = self.price(model)
            return {"cache_hit": spec.cache_hit, "cache_miss": spec.cache_miss,
                    "output": spec.output, "off_peak_multiplier": spec.off_peak_multiplier}

        return {
            "peak_now": is_peak(),
            "peak_windows_utc": [[start, end] for start, end in PEAK_WINDOWS_UTC],
            "peak_days_utc": "Mon-Fri",
            "reasoning_effort": settings.reasoning_effort,
            "tiers": {tier.value: {"model": self.model_for_tier(tier),
                                   "per_million_tokens": card(self.model_for_tier(tier))}
                      for tier in ModelTier},
        }

    def estimate_step_reservation(self, agent: Agent, *, tokens_in: int = 2_000, escalate: int = 0) -> int:
        choice = self.choice_for_agent(agent, escalate=escalate)
        return self.estimate_cost_micros(choice.model, tokens_in, int(tokens_in * EST_OUTPUT_FRACTION))

    def available(self) -> dict:
        """Provider health summary for /api/system/status."""
        out = {}
        for tier in ModelTier:
            model = self.model_for_tier(tier)
            out[tier.value] = {"model": model, "key_present": bool(settings.provider_key_for(model))}
        return out


def _rank(tier: ModelTier) -> int:
    return {ModelTier.FAST: 0, ModelTier.STANDARD: 1, ModelTier.REASONING: 2, ModelTier.EMBED: 1}[tier]


def _upgrade(tier: ModelTier) -> ModelTier:
    return {ModelTier.FAST: ModelTier.STANDARD, ModelTier.STANDARD: ModelTier.REASONING,
            ModelTier.REASONING: ModelTier.REASONING, ModelTier.EMBED: ModelTier.EMBED}[tier]


router = ModelRouter()
