"""Event store (append-only, seq per project) + in-process bus (docs/07, ADR 0003/0006)."""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select

from crew.core.db import session_scope
from crew.core.models import Event, uid
from crew.core.settings import settings

log = logging.getLogger("crew.events")


class EventBus:
    """In-process pub/sub. Swap for Redis Streams in prod (docs/01 §4.2) — same interface."""

    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def subscribe(self, project_id: str, maxsize: int = 2000) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
        async with self._lock:
            self._subs[project_id].add(q)
        return q

    async def unsubscribe(self, project_id: str, q: asyncio.Queue) -> None:
        async with self._lock:
            self._subs[project_id].discard(q)

    async def publish(self, project_id: str, frame: dict) -> None:
        for q in list(self._subs.get(project_id, ())):
            try:
                q.put_nowait(frame)
            except asyncio.QueueFull:
                # Backpressure: drop oldest and tell the client there is a gap (docs/11 §3).
                try:
                    q.get_nowait()
                    q.put_nowait(frame)
                except Exception:  # pragma: no cover - racing consumer
                    pass

    def publish_threadsafe(self, loop: asyncio.AbstractEventLoop, project_id: str, frame: dict) -> None:
        try:
            loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self.publish(project_id, frame)))
        except RuntimeError:  # loop closed
            pass


bus = EventBus()
_seq_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
_seq_cache: dict[str, int] = {}

_loop: asyncio.AbstractEventLoop | None = None


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Remember the server loop so worker threads can emit events."""
    global _loop
    _loop = loop


def current_loop() -> asyncio.AbstractEventLoop | None:
    return _loop


async def next_seq(project_id: str) -> int:
    async with _seq_locks[project_id]:
        if project_id not in _seq_cache:
            async with session_scope() as s:
                cur = await s.scalar(select(func.max(Event.seq)).where(Event.project_id == project_id))
            _seq_cache[project_id] = int(cur or 0)
        _seq_cache[project_id] += 1
        return _seq_cache[project_id]


def event_to_dict(e: Event) -> dict[str, Any]:
    return {
        "id": e.id,
        "project_id": e.project_id,
        "seq": e.seq,
        "ts": (e.ts or datetime.now(UTC)).isoformat(),
        "type": e.type,
        "severity": e.severity,
        "title": e.title,
        "summary": e.summary,
        "payload": e.payload or {},
        "department_id": e.department_id,
        "squad_id": e.squad_id,
        "agent_id": e.agent_id,
        "task_id": e.task_id,
        "run_id": e.run_id,
        "job_id": e.job_id,
        "trace_id": e.trace_id,
        "span_id": e.span_id,
        "parent_span_id": e.parent_span_id,
        "actor": e.actor,
        "cost_micros": e.cost_micros,
        "tokens_in": e.tokens_in,
        "tokens_out": e.tokens_out,
        "duration_ms": e.duration_ms,
    }


async def emit(
    type: str,  # noqa: A002 - matches the domain vocabulary
    *,
    project_id: str,
    title: str = "",
    summary: str = "",
    severity: str = "info",
    payload: dict | None = None,
    actor: str = "system",
    department_id: str | None = None,
    squad_id: str | None = None,
    agent_id: str | None = None,
    task_id: str | None = None,
    run_id: str | None = None,
    job_id: str | None = None,
    trace_id: str = "",
    span_id: str = "",
    parent_span_id: str | None = None,
    cost_micros: int = 0,
    tokens_in: int = 0,
    tokens_out: int = 0,
    duration_ms: int = 0,
) -> dict[str, Any]:
    """Append an event and publish it live. Returns the serialized event."""
    seq = await next_seq(project_id)
    span = span_id or uid()[:16]
    e = Event(
        project_id=project_id, seq=seq, type=type, severity=severity, title=title[:300],
        summary=summary, payload=payload or {}, actor=actor, department_id=department_id,
        squad_id=squad_id, agent_id=agent_id, task_id=task_id, run_id=run_id, job_id=job_id,
        trace_id=trace_id, span_id=span, parent_span_id=parent_span_id,
        cost_micros=cost_micros, tokens_in=tokens_in, tokens_out=tokens_out, duration_ms=duration_ms,
    )
    async with session_scope() as s:
        s.add(e)
    frame = {"type": "event", "seq": seq, "event": event_to_dict(e)}
    await bus.publish(project_id, frame)
    if settings.validate_events:
        _validate(type, e.payload)
    return frame["event"]


def emit_sync(**kwargs: Any) -> None:
    """Emit from a worker thread (CrewAI runs in threads). Fire and forget."""
    loop = _loop
    if loop is None or loop.is_closed():
        log.debug("event dropped (no loop): %s", kwargs.get("type"))
        return
    asyncio.run_coroutine_threadsafe(emit(**kwargs), loop)


# ── event payload validation (docs/11 §5: "validated on emit in dev") ────────────────
REQUIRED_PAYLOAD_KEYS: dict[str, tuple[str, ...]] = {
    "project.created": ("project_id", "name"),
    "run.started": ("run_id", "goal"),
    "run.stage.changed": ("run_id", "stage"),
    "org.department.created": ("department_id", "name"),
    "org.squad.created": ("squad_id", "name"),
    "org.agent.hired": ("agent_id", "role", "grade"),
    "org.agent.promoted": ("agent_id", "grade_before", "grade_after"),
    "org.agent.demoted": ("agent_id", "grade_before", "grade_after"),
    "org.agent.probation": ("agent_id",),
    "org.agent.archived": ("agent_id",),
    "task.created": ("task_id", "title"),
    "task.assigned": ("task_id", "agent_id"),
    "task.completed": ("task_id",),
    "task.failed": ("task_id",),
    "task.escalated": ("task_id", "reason"),
    "agent.tool.call": ("tool",),
    "llm.response": ("model",),
    "verify.verdict": ("task_id", "verdict"),
    "reward.settled": ("agent_id", "task_id", "reward"),
    "council.convened": ("session_id", "question"),
    "council.position": ("session_id", "agent_id"),
    "decision.recorded": ("decision_id", "chosen_option"),
    "policy.denied": ("capability",),
    "policy.approval.requested": ("capability",),
    "policy.approval.used": ("capability",),
    "budget.exceeded": ("scope_kind", "scope_id"),
    "security.injection.detected": ("where",),
    "user.steering": ("target_kind", "text"),
}


def _validate(type: str, payload: dict) -> None:  # noqa: A002
    required = REQUIRED_PAYLOAD_KEYS.get(type)
    if not required:
        return
    missing = [k for k in required if k not in payload]
    if missing:
        raise ValueError(f"event {type} missing payload keys: {missing}")


async def replay(project_id: str, since_seq: int, filters: dict | None = None, limit: int = 5000) -> list[dict]:
    async with session_scope() as s:
        stmt = select(Event).where(Event.project_id == project_id, Event.seq > since_seq).order_by(Event.seq).limit(limit)
        rows = (await s.scalars(stmt)).all()
    out = [event_to_dict(e) for e in rows]
    return [e for e in out if _matches(e, filters)] if filters else out


def _matches(e: dict, f: dict) -> bool:
    for key in ("department_id", "squad_id", "agent_id", "task_id", "run_id"):
        want = (f.get("scope") or {}).get(key) or f.get(key)
        if want and e.get(key) != want:
            return False
    types = f.get("types") or []
    if types and not any(_type_match(e["type"], t) for t in types):
        return False
    sev_min = f.get("severity_min")
    if sev_min:
        order = ["debug", "info", "notice", "warning", "error", "critical"]
        if order.index(e["severity"]) < order.index(sev_min):
            return False
    return True


def _type_match(actual: str, pattern: str) -> bool:
    if pattern.endswith(".*"):
        return actual.startswith(pattern[:-1])
    if pattern.endswith("*"):
        return actual.startswith(pattern[:-1])
    return actual == pattern
