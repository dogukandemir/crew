"""Model routing: grade → tier → concrete model, with a price table for budgeting (docs/04 §2).

Prices are public list prices in **micro-USD per token** (i.e. USD per million tokens).
They only need to be right within a factor of ~2 to keep the budget guard useful; every
number here is overridable via settings/DB so the user can reconcile against a real invoice.
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

# model-substring → (micro_usd_per_input_token, micro_usd_per_output_token)
PRICES: dict[str, tuple[float, float]] = {
    "deepseek-chat": (0.28, 0.42),
    "deepseek-reasoner": (0.55, 2.19),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o": (2.50, 10.00),
    "gpt-4.1": (2.00, 8.00),
    "o4-mini": (1.10, 4.40),
    "claude-3-5-haiku": (0.80, 4.00),
    "claude-sonnet": (3.00, 15.00),
    "claude-opus": (15.00, 75.00),
    "gemini-2.5-flash": (0.30, 2.50),
    "gemini-2.5-pro": (1.25, 10.00),
    "llama": (0.10, 0.20),
}
DEFAULT_PRICE = (1.0, 3.0)

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
                                 "timeout": 120}
        if choice.api_key:
            kwargs["api_key"] = choice.api_key
        if choice.base_url:
            kwargs["base_url"] = choice.base_url
        return LLM(**kwargs)

    @staticmethod
    def price(model: str) -> tuple[float, float]:
        for key, price in PRICES.items():
            if key in model:
                return price
        return DEFAULT_PRICE

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
