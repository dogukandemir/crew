# Crew — Refinement Documentation

This directory is the specification of the system. Code follows the docs; when reality
disagrees with a doc, the doc and an ADR get updated in the same commit as the code.

## Reading order

1. **[00 — Vision & Scope](00-vision-and-scope.md)** — the product in one page, plus the
   explicit non-goals that keep the project buildable.
2. **[01 — System Architecture](01-system-architecture.md)** — layers, components, stack,
   runtime model, how CrewAI is embedded.
3. **[02 — Organization & Command Chain](02-organization-and-command-chain.md)** — Project →
   Department → Squad → Agent, authority, promotion rules, how new units are spawned.
4. **[03 — Orchestration & Lifecycle](03-orchestration-and-lifecycle.md)** — the state
   machine from user goal to verified result and disband.
5. **[04 — Agent Model & Skills](04-agent-model-and-skills.md)** — role specs, skill
   registry, tools, model tiers.
6. **[05 — Reward & Performance](05-reward-and-performance.md)** — reward signals, scoring,
   grades, anti-gaming.
7. **[06 — Memory & Brains](06-memory-and-brains.md)** — the three brain levels, scoping,
   retrieval, insight promotion.
8. **[07 — Observability](07-observability.md)** — event model, tracing, the three live
   views, replay, metrics.
9. **[08 — Security & Governance](08-security-and-governance.md)** — auth, vault, capability
   policy, sandbox, egress, prompt-injection defense, budget kill-switch, audit chain.
10. **[09 — UI/UX Spec](09-ui-ux-spec.md)** — tabbed control room, every panel and control.
11. **[10 — Data Model](10-data-model.md)** — tables, columns, invariants, retention.
12. **[11 — API & Event Contract](11-api-and-event-contract.md)** — REST endpoints and
    WebSocket envelopes (frozen contract for the frontend).
13. **[12 — Implementation Plan](12-implementation-plan.md)** — milestones M0–M10, exit
    criteria, current status.

## ADRs

Decisions that were expensive to make and would be expensive to reverse:

- [0001 — Record architecture decisions](adr/0001-record-architecture-decisions.md)
- [0002 — CrewAI as the execution engine, not the orchestrator](adr/0002-crewai-as-execution-engine.md)
- [0003 — Python/FastAPI backend + event-sourced core](adr/0003-backend-fastapi-event-sourced.md)
- [0004 — SQLite now, Postgres later](adr/0004-sqlite-now-postgres-later.md)
- [0005 — CrewAI Flows for org control flow, Crews for swarm work](adr/0005-flows-vs-crews.md)
- [0006 — WebSocket event stream as the only live channel](adr/0006-websocket-event-stream.md)

## Conventions

- Every mutation of meaningful state emits exactly one **domain event** (docs/07) and one
  **audit entry** if privileged (docs/08).
- Identifiers are `uuid7`/ULID strings; timestamps are UTC ISO-8601 with milliseconds.
- Money is stored as **micro-USD integers** (`cost_micros`) to avoid float drift.
- Docs use "must" for invariants enforced by code/tests, "should" for defaults that config
  may override.
