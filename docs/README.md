# Crew: Refinement Documentation

This directory is the specification of the system. Code follows the docs; when reality
disagrees with a doc, the doc and an ADR get updated in the same commit as the code.

## Reading order

1. **[00, Vision & Scope](00-vision-and-scope.md)**. The product in one page, plus the
   explicit non-goals that keep the project buildable.
2. **[01, System Architecture](01-system-architecture.md)**. Layers, components, stack,
   runtime model, how CrewAI is embedded.
3. **[02, Organization & Command Chain](02-organization-and-command-chain.md)**, Project →
   Department → Squad → Agent, authority, promotion rules, how new units are spawned.
4. **[03, Orchestration & Lifecycle](03-orchestration-and-lifecycle.md)**. The state
   machine from user goal to verified result and disband.
5. **[04, Agent Model & Skills](04-agent-model-and-skills.md)**. Role specs, skill
   registry, tools, model tiers.
6. **[05, Reward & Performance](05-reward-and-performance.md)**. Reward signals, scoring,
   grades, anti-gaming.
7. **[06, Memory & Brains](06-memory-and-brains.md)**. The four brain levels, scoping,
   retrieval, insight promotion.
8. **[07, Observability](07-observability.md)**. Event model, tracing, the three live
   views, replay, metrics.
9. **[08, Security & Governance](08-security-and-governance.md)**. Auth, vault, capability
   policy, sandbox, egress, prompt-injection defense, budget kill-switch, audit chain.
10. **[09, UI/UX Spec](09-ui-ux-spec.md)**. Tabbed control room, every panel and control.
11. **[10, Data Model](10-data-model.md)**. Tables, columns, invariants, retention.
12. **[11, API & Event Contract](11-api-and-event-contract.md)**, REST endpoints and
    WebSocket envelopes (frozen contract for the frontend).
13. **[12, Implementation Plan](12-implementation-plan.md)**. Milestones M0–M10, exit
    criteria, current status.
14. **[13, Backend implementation notes](13-backend-implementation-notes.md)**. The map of what
    was built, how to run it, the bugs found and fixed, and the deliberate gaps.
15. **[14, Realtime office renderer](14-realtime-office-renderer.md)**. The 2.5D renderer's
    contract: simulation → scene → pixels, and why there is exactly one renderer.
16. **[15, The office's visual audit](15-office-visual-audit.md)**. The pixel-level defect
    log that produced the current floor.
17. **[16, System review](16-system-review.md)**. A point-in-time production-readiness
    review (2026-10-07); the living status is docs/12.
18. **[17, Agent-system audit](17-agent-system-audit.md)**. The audit behind the social
    layer, grants, occupancy, and the executive tier.

## ADRs

Decisions that were expensive to make and would be expensive to reverse:

- [0001, Record architecture decisions](adr/0001-record-architecture-decisions.md)
- [0002, CrewAI as the execution engine, not the orchestrator](adr/0002-crewai-as-execution-engine.md)
- [0003, Python/FastAPI backend + event-sourced core](adr/0003-backend-fastapi-event-sourced.md)
- [0004, SQLite now, Postgres later](adr/0004-sqlite-now-postgres-later.md)
- [0005, CrewAI Flows for org control flow, Crews for swarm work](adr/0005-flows-vs-crews.md) *(Flows half superseded by 0007; Crews half stands)*
- [0006, WebSocket event stream as the only live channel](adr/0006-websocket-event-stream.md)
- [0007, The run pipeline is our own resumable state machine, not a Flow](adr/0007-run-pipeline-as-own-state-machine.md)
- [0008, The executive tier lives inside a project (C-roles)](adr/0008-executive-tier-inside-a-project.md)
- [0009, The company layer: a headquarters project that runs the portfolio](adr/0009-company-layer-as-headquarters-project.md)
- [0010, The board: work items above tasks, and joint work that finishes together](adr/0010-board-and-work-items.md)
- [0011, The board of directors, the portfolio call, and the HQ floor](adr/0011-board-of-directors-and-portfolio.md)
- [0012, The command desk: the Captain speaks, the orchestrator answers](adr/0012-command-desk.md)
- [0013, First-run onboarding: one key, stored in the vault](adr/0013-first-run-onboarding.md)
- [0014, Agent growth: grades, promotions and demotions on evidence](adr/0014-agent-growth.md)
- [0015, Company-first navigation: the company owns HQ, projects are members](adr/0015-company-first-navigation.md)
- [0016, Agent souls and the HR hiring ladder](adr/0016-agent-souls-and-hr-hiring.md)
- [0017, Workspaces, egress and the security review gate](adr/0017-workspaces-and-security-review.md)
- [0018, Full autonomy (YOLO) and a council that acts](adr/0018-full-autonomy-and-a-council-that-acts.md)
- [0019, A cap stops the job, the envelope stops the run](adr/0019-a-cap-stops-the-job-the-envelope-stops-the-run.md)

## Conventions

- Every mutation of meaningful state emits exactly one **domain event** (docs/07) and one
  **audit entry** if privileged (docs/08).
- Identifiers are `uuid4().hex` strings (32-char, not sortable); timestamps are UTC ISO-8601
  with milliseconds.
- Money is stored as **micro-USD integers** (`cost_micros`) to avoid float drift.
- Docs use "must" for invariants enforced by code/tests, "should" for defaults that config
  may override.
