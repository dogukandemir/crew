"""One accounting boundary for worker, planner, evaluator and council model calls.

Costs are estimates using the configured price table, never a provider invoice.
Unknown/failed request usage conservatively consumes the whole reservation.
"""

import asyncio
import json
from datetime import UTC, datetime
from uuid import uuid4

from crew.core import events
from crew.core.db import session_scope
from crew.core.models import Run
from crew.core.security import budget
from crew.execution import lifecycle
from crew.execution.models import is_peak, router

_limits = None
_limits_loop = None


def _usage_int(summary, name: str) -> int:
    """A provider usage counter, or 0 when the provider does not report that bucket."""
    return int(getattr(summary, name, 0) or 0)


async def call_model(delegate, *, model: str, messages, project_id: str,
                     agent_id: str | None = None, run_id: str | None = None,
                     task_id: str | None = None, output_tokens: int = 4096, on_usage=None):
    global _limits, _limits_loop
    loop = asyncio.get_running_loop()
    if _limits_loop is not loop:
        from crew.core.settings import settings
        _limits_loop, _limits = loop, asyncio.Semaphore(max(1, settings.max_concurrent_crews))
    # Include planners and reviewers in the same provider concurrency bound.
    await asyncio.wait_for(_limits.acquire(), timeout=30)
    try:
        return await _call_model(delegate, model=model, messages=messages, project_id=project_id,
                                 agent_id=agent_id, run_id=run_id, task_id=task_id,
                                 output_tokens=output_tokens, on_usage=on_usage)
    finally:
        _limits.release()


async def _call_model(delegate, *, model, messages, project_id, agent_id, run_id,
                      task_id, output_tokens, on_usage):
    lifecycle.check_cancelled(run_id)
    if run_id:
        async with session_scope() as s:
            run = await s.get(Run, run_id)
            if run is None or run.project_id != project_id or run.status != "running":
                raise RuntimeError("model call refused: run is not active")
    # UTF-8 byte count is a conservative text-token bound; reserve protocol overhead too.
    input_bound = len(json.dumps(messages, ensure_ascii=False).encode()) + 1024
    if input_bound > 100_000:
        raise ValueError("model input exceeds the supported context budget")
    amount = router.cost_micros(model, input_bound, output_tokens)
    scope_kind, scope_id = ("agent", agent_id) if agent_id else ("project", project_id)
    call_id = uuid4().hex
    ref = f"run:{run_id}:{call_id}" if run_id else call_id
    await budget.reserve(project_id, amount_micros=amount, scope_kind=scope_kind, scope_id=scope_id,
                         ref=ref, run_id=run_id, idempotency_key=f"model-reserve:{call_id}")
    charged, tin, tout, usage_state = amount, 0, 0, "unknown_reserved"
    cached_in, reasoning_tokens = 0, 0
    now = datetime.now(UTC)  # the moment the provider bills against, which decides peak
    billed_peak = is_peak(now)
    response_excerpt = ""
    try:
        before = delegate.get_token_usage_summary()
        before_in, before_out = before.prompt_tokens, before.completion_tokens
        before_cached, before_reasoning = _usage_int(before, "cached_prompt_tokens"), _usage_int(before, "reasoning_tokens")
        # SDK retries are disabled when constructing providers. Bypass the provider's
        # automatic rate-limit retry wrapper: the caller must re-enter this gateway.
        wrapped = getattr(delegate.call, "__wrapped__", None)
        def invoke():
            if wrapped is not None:
                return wrapped(delegate, messages=messages)
            return delegate.call(messages=messages)
        pending = asyncio.create_task(asyncio.to_thread(invoke))
        try:
            result = await asyncio.shield(pending)
        except asyncio.CancelledError:
            # A cancelled coroutine cannot interrupt a provider thread. Keep its
            # reservation until the bounded provider request has actually finished.
            try:
                await pending
            finally:
                raise
        after = delegate.get_token_usage_summary()
        response_excerpt = str(result)[:2000]
        tin, tout = max(0, after.prompt_tokens-before_in), max(0, after.completion_tokens-before_out)
        # The provider bills a prefix-cache hit at a fraction of a miss, and DeepSeek counts
        # the thinking tokens as output. Both arrive in the usage summary (CrewAI reads
        # prompt_tokens_details.cached_tokens, which DeepSeek fills alongside its own
        # prompt_cache_hit_tokens), so settle on the real buckets instead of the estimate.
        cached_in = max(0, min(tin, _usage_int(after, "cached_prompt_tokens") - before_cached))
        reasoning_tokens = max(0, _usage_int(after, "reasoning_tokens") - before_reasoning)
        if tin or tout:
            charged = router.cost_micros(model, tin, tout, cached_in=cached_in, at=now)
            usage_state = "provider_tokens_estimated_price"
        lifecycle.check_cancelled(run_id)
        return result, {"cost_micros": charged, "tokens_in": tin, "tokens_out": tout,
                        "cached_tokens_in": cached_in, "reasoning_tokens": reasoning_tokens,
                        "peak": billed_peak, "usage_state": usage_state}
    finally:
        await budget.settle(project_id, reserved_micros=amount, actual_micros=charged,
                            scope_kind=scope_kind, scope_id=scope_id, ref=ref,
                            idempotency_key=f"model-settle:{call_id}")
        if on_usage:
            on_usage({"cost_micros": charged, "tokens_in": tin, "tokens_out": tout,
                      "cached_tokens_in": cached_in, "reasoning_tokens": reasoning_tokens,
                      "peak": billed_peak, "usage_state": usage_state})
        if charged > amount:
            # One call costing more than its estimate is booked, not a stop: the next
            # reservation reads availability from the ledger. Latching the project breaker
            # here paused runs whose envelope was half full (16 October).
            await events.emit("budget.overrun", project_id=project_id, run_id=run_id,
                              task_id=task_id, agent_id=agent_id, severity="warning",
                              title="model call exceeded its reservation", cost_micros=charged,
                              payload={"model": model, "call_id": call_id,
                                       "reserved_micros": amount, "charged_micros": charged})
        await events.emit("llm.response", project_id=project_id, run_id=run_id, task_id=task_id,
                          agent_id=agent_id, title="model usage recorded", cost_micros=charged,
                          tokens_in=tin, tokens_out=tout,
                          payload={"model": model, "usage_state": usage_state, "call_id": call_id,
                                   "reserved_micros": amount, "charged_micros": charged,
                                   "cached_tokens_in": cached_in, "reasoning_tokens": reasoning_tokens,
                                   "peak": billed_peak,
                                   "response_excerpt": response_excerpt})


async def complete(*, project_id: str, model: str, messages, agent_id: str | None = None,
                   run_id: str | None = None, task_id: str | None = None, compact: bool = False):
    from crewai import LLM

    from crew.core.settings import settings

    kwargs = {"model": model, "api_key": settings.provider_key_for(model), "temperature": 0.1,
              "timeout": 60, "max_tokens": 4096, "max_retries": 0}
    if model.startswith("ollama/"):
        kwargs["base_url"] = settings.ollama_base_url
    if model.startswith("deepseek/"):
        # Planning needs complete JSON within the same bounded output allowance.
        # Provider-default high thinking can consume it before emitting the plan.
        kwargs["reasoning_effort"] = "none" if compact else settings.reasoning_effort
    delegate = await asyncio.to_thread(LLM, **kwargs)
    result, _ = await call_model(delegate, model=model, messages=messages, project_id=project_id,
                                  agent_id=agent_id, run_id=run_id, task_id=task_id)
    return result


def governed_llm(delegate, req, *, model: str, before_call=None):
    """CrewAI's ReAct loop calls this adapter once for every billable generation."""
    from crewai.llms.base_llm import BaseLLM

    from crew.execution.tools import run_on_loop

    class GovernedLLM(BaseLLM):
        def record_usage(self, usage):
            self.total_cost += usage["cost_micros"]
            self.total_in += usage["tokens_in"]
            self.total_out += usage["tokens_out"]
            # Kept beside the totals so a task report can say how much of the input the
            # provider served from cache and how much of the output was thinking.
            self.total_cached_in += usage.get("cached_tokens_in", 0)
            self.total_reasoning += usage.get("reasoning_tokens", 0)

        def call(self, messages, **kwargs):
            if before_call:
                before_call()
            # CrewAI sets a per-call context override, not the static stop field.
            # Preserve it across our accounting wrapper and enforce it locally:
            # model-authored observations must never masquerade as tool results.
            delegate.stop = self.stop_sequences
            result, _ = run_on_loop(call_model(delegate, model=self.model, messages=messages,
                project_id=req.project_id, agent_id=req.agent.id, run_id=req.run_id, task_id=req.task.id,
                output_tokens=min(req.agent.token_cap_per_step or 4096, 4096), on_usage=self.record_usage), timeout=150)
            return self._apply_stop_words(result) if isinstance(result, str) else result

        def supports_function_calling(self):
            # The harness invokes tools; the provider must not run a hidden recursive
            # tool/model loop that bypasses per-generation reservations.
            return False

    # SDKs strip provider prefixes from delegate.model. Accounting must retain the
    # exact routed provider/model identity, including when a task escalates tiers.
    wrapped = GovernedLLM(model=model, temperature=0.2)
    wrapped.total_cost = wrapped.total_in = wrapped.total_out = 0
    wrapped.total_cached_in = wrapped.total_reasoning = 0
    return wrapped
