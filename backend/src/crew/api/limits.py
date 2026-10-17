"""In-process sliding-window rate limiter (docs/08 §4: "rate limits on auth, on run
creation and on message injection ... to prevent accidental self-DoS").

Deliberately tiny and dependency-free: a dict of stamp lists pruned on access, the way
the login limiter has always worked. One process = one bucket store; multi-worker
deployments would need a shared store, which this release does not claim to have.
"""

from __future__ import annotations

import time

from fastapi import HTTPException, status

_buckets: dict[str, list[float]] = {}
MAX_KEYS = 20_000


def hit(key: str, *, limit: int, window_s: float = 60.0) -> None:
    """Record one event for `key`; raise 429 when the window's budget is exhausted."""
    now = time.monotonic()
    if len(_buckets) > MAX_KEYS:
        # A hostile key space must not grow the dict forever, but clearing it would hand the
        # attacker a reset of every in-flight window (16 October finding): evict the idle
        # entries, then the least recently active ones.
        for key_ in [k for k, stamps_ in _buckets.items() if not stamps_ or now - stamps_[-1] >= window_s]:
            _buckets.pop(key_, None)
        while len(_buckets) > MAX_KEYS:
            _buckets.pop(min(_buckets, key=lambda k: _buckets[k][-1]), None)
    stamps = [t for t in _buckets.get(key, []) if now - t < window_s]
    if len(stamps) >= limit:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS,
                            f"rate limit reached: {limit} per {int(window_s)}s")
    stamps.append(now)
    _buckets[key] = stamps


def reset() -> None:  # pragma: no cover - test helper
    _buckets.clear()
