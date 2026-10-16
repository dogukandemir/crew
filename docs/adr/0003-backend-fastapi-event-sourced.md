# ADR 0003: Python/FastAPI backend with an event-sourced core

- **Status:** Accepted
- **Date:** 2026-10-06

## Context
The user's other projects use .NET and Next.js, but CrewAI is a Python library. Two options:
a .NET/Node control plane talking to a Python execution service, or one Python backend.

## Decision
One Python backend: FastAPI + Pydantic v2 + async SQLAlchemy, with an append-only `events`
table as the primary record and current-state tables as projections.

## Consequences
- Single runtime, no cross-language IPC for agent execution; crewai is imported directly.
- Frontend gets typed OpenAPI for free; WebSocket is the only live channel (ADR 0006).
- Event sourcing makes replay, audit and per-unit observability cheap: they are queries, not
  features that need separate instrumentation.
- Cost: Python for the whole backend (accepted; the heavy logic is orchestration and I/O).
- Risk: event table growth, mitigated by retention/rollup policy (docs/10 §5).
