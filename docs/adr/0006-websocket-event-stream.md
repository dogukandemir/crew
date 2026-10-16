# ADR 0006: WebSocket event stream as the only live channel

- **Status:** Accepted
- **Date:** 2026-10-06

## Context
Live observability (per project, department, agent) is a core requirement. Polling REST wastes
budget on the server and cannot deliver per-step agent telemetry.

## Decision
- One WebSocket per project per UI tab: `/ws/projects/{id}`.
- The stream carries **domain events only** (plus small control frames: hello, gap, stage,
  metrics, pong). Commands always travel over REST.
- Server-side filtering by scope and type; `seq`-based resume (`since_seq`) with bounded
  replay; 100 ms coalescing of high-frequency types; backpressure drops oldest with an explicit
  `gap` frame.
- An SSE endpoint exists as a documented fallback, same envelope.

## Consequences
- The UI has exactly one live source of truth; panels are projections of the event stream.
- Because events are also persisted, the same code path serves live view and replay.
- We must handle reconnection, resume and gaps explicitly (specified in docs/11 §3).
- No push of full objects on subscribe, the UI bootstraps from REST, then applies deltas:
  keeps frames small and logic simple.
