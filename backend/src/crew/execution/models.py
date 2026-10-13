"""Model routing: grade → tier → concrete model, with a price table for budgeting (docs/04 §2).

Prices are estimates in **micro-USD per token** (USD per million tokens).
Unknown hosted models fail closed. Operators can supply exact-model price overrides
through CREW_MODEL_PRICES after checking their provider's actual terms.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from crew.core.models import Agent
from crew.core.settings import settings
from crew.domain.catalog import MIN_TIER_FOR_ROLE
from crew.domain.enums import ModelTier, Role

log = logging.getLogger("crew.models")

# Exact provider/model → (micro_usd_per_input_token, micro_usd_per_output_token).
PRICES: dict[str, tuple[float, float]] = {
    # DeepSeek V4 (Apr 2026; legacy deepseek-chat/-reasoner retired 2026-07-24). Priced at
    # the provider's PEAK, cache-miss rate so the budget guard errs conservative.
    "deepseek/deepseek-flash": (0.30, 1.20),
    "deepseek/deepseek-v4-pro": (1.32, 3.96),
    "openai/gpt-4o-mini": (0.15, 0.60),
    "openai/gpt-4o": (2.50, 10.00),
    "openai/gpt-4.1": (2.00, 8.00),
    "openai/o4-mini": (1.10, 4.40),
    "openai/text-embedding-3-small": (0.02, 0.0),
    "anthropic/claude-3-5-haiku-20241022": (0.80, 4.00),
    "anthropic/claude-haiku-4-5-20251001": (1.00, 5.00),
    "anthropic/claude-sonnet-4-6": (3.00, 15.00),
    "gemini/gemini-2.5-flash": (0.30, 2.50),
    "gemini/gemini-2.5-pro": (1.25, 10.00),
    "openrouter/openai/gpt-4o-mini": (0.15, 0.60),
    "openrouter/anthropic/claude-sonnet-4.6": (3.00, 15.00),
}

# rough output-token fraction used for pre-flight reservations
EST_OUTPUT_FRACTION = 0.35


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
    def price(model: str) -> tuple[float, float]:
        if model in settings.model_prices:
            return settings.model_prices[model]
        # Local inference has no per-token provider charge; host costs are excluded.
        if model.startswith("ollama/"):
            return (0.0, 0.0)
        key = model if "/" in model else f"openai/{model}"
        if key in PRICES:
            return PRICES[key]
        raise ValueError(f"No price configured for model {model!r}; set CREW_MODEL_PRICES before Live use")

    def estimate_cost_micros(self, model: str, tokens_in: int, tokens_out: int | None = None) -> int:
        pin, pout = self.price(model)
        out = tokens_out if tokens_out is not None else int(tokens_in * EST_OUTPUT_FRACTION)
        return int(round(tokens_in * pin + out * pout))

    def cost_micros(self, model: str, tokens_in: int, tokens_out: int) -> int:
        pin, pout = self.price(model)
        return int(round(tokens_in * pin + tokens_out * pout))

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
