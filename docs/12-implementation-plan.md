# 12 — Implementation Plan

Milestones are ordered so that each one produces something runnable and testable. "Exit"
means the criteria are demonstrated by tests or by a manual run recorded in the PR.

## Status legend
✅ done · 🟡 partial · ⬜ not started

| # | Milestone | Status | Exit criteria |
|---|-----------|:------:|---------------|
| M0 | **Foundation** — repo, docs, toolchain, crewai, health endpoint | ✅ | `uv run uvicorn crew.api.main:app` boots, `/api/health` returns version+contract, crewai imports, docs committed |
| M1 | **Core** — settings, DB + migrations, domain model, event store, bus, repos | 🟡 | create/list projects + agents via REST, every mutation emits an event, seq gapless per project, unit tests green |
| M2 | **Execution slice** — one real crewai run end-to-end with live events | 🟡 | a task executes through CrewRunner, `agent.*`/`llm.*` events stream over WS, cost recorded, artifact stored, FakeLLM test + one real provider run |
| M3 | **Org engine** — Orchestrator: intake → plan → hiring → dispatch | 🟡 | goal in → departments/squads/agents created from capability gaps → tasks dispatched; DAG validated |
| M4 | **Council & decider** — debate, positions, DecisionRecord, override | ⬜ | a high-impact decision produces a Council session with ≥3 positions and a binding decision linked to tasks |
| M5 | **Rewards** — verification, reward events, EWMA scores, grades | 🟡 | verdict → reward ledger → score → grade transition → model tier & caps change; recompute matches stored scores |
| M6 | **Observability** — WS filters/resume, metrics rollups, trace view, replay API | 🟡 | UI sees live events for one project; `since_seq` resume works; trace tree assembled from events |
| M7 | **Security** — auth, vault, policy engine, sandbox, egress, budget guard, audit chain | 🟡 | security test suite (docs/08 §11) passes; budget cap cannot be exceeded; secrets never in events |
| M8 | **Brains** — 3-level memory, retrieval scoring, promotion, Librarian job | 🟡 | writes scoped correctly, retrieval returns provenance, promotion blocked without rights |
| M9 | **Frontend** — tabbed control room: overview, org, tasks, agents, rewards, events | 🟡 | multiple projects in tabs, live updates, agent drawer with timeline, approval tray |
| M10 | **Hardening & packaging** — Postgres/Redis option, docker compose, CI, backups, docs pass | ⬜ | docker compose up runs the stack; CI green (lint, type, unit, security); backup/restore round-trip test |

## Build order detail (M1–M3, the critical path)

1. `core/settings.py` — `Settings` (pydantic-settings), validated at boot; refuses `local`
   auth mode outside dev.
2. `core/db.py` — async engine/session, SQLite WAL, `create_all` in dev only.
3. `domain/` — enums (`Grade`, `AgentState`, `TaskState`, `RunStage`, `Verdict`…),
   `roles.py` (role templates), `skills.py` (catalog), `grades.py` (capability/limit table).
4. `core/events.py` — `EventStore.append()` (transactional seq), `EventBus` (asyncio queues +
   thread-safe emit), `TraceService`.
5. `core/repo/*` — project, agent, task, run, reward, event repositories (all project-scoped).
6. `execution/models.py` — `ModelRouter` (tier → LiteLLM id, caps, price table).
7. `execution/crew_runner.py` — domain → CrewAI `Agent`/`Task`/`Crew`; callbacks → events;
   returns structured result. `FakeCrewRunner` for tests.
8. `control/orchestrator.py` — the run state machine (docs/03 §1), resumable per stage.
9. `control/planner.py` + `control/hiring.py` — WBS/DAG + capability-gap hiring.
10. `core/reward.py` + `core/verify.py` — verdicts and reward ledger.
11. `api/*` + `api/ws.py` — REST + socket per docs/11.
12. `frontend/*` — per docs/09 MVP scope.

## Testing strategy

| Level | What | Where |
|-------|------|-------|
| Unit | domain rules, grade tables, reward math, DAG validation, policy matrix | `backend/tests/unit` |
| Contract | every REST endpoint shape vs. docs/11; every event type validated on emit | `backend/tests/contract` |
| Integration | orchestrator with `FakeLLM`/`FakeCrewRunner`: goal → plan → hire → run → verify → reward (no network) | `backend/tests/integration` |
| Security | docs/08 §11 suite | `backend/tests/security` |
| Frontend | components + socket reducer + tab store | `frontend/src/**/*.test.tsx` |
| Smoke | one real provider run, marked `@pytest.mark.live`, excluded from CI default | `backend/tests/live` |

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| CrewAI API churn (1.x moving fast) | all CrewAI use confined to `execution/`; pinned version; `FakeCrewRunner` keeps tests stable (ADR 0002) |
| Cost blowups from autonomous hiring | grade-gated cheap defaults, pre-flight budget reservation, hire caps, `auto_hire` off by default in new projects until you enable it |
| Runaway swarms / thrash | org limits, hire anti-thrash rule, concurrency semaphores, circuit breaker |
| Observability overhead | coalesced WS frames, body-free event payloads (hashes + artifact refs), payload caps |
| Scope creep into a SaaS | docs/00 §4 out-of-scope list; v1 is local-first single-user |
| Verifier rubber-stamping | independent assignment + verifier accuracy scoring + random second opinion (docs/05 §6) |

## Definition of done for v1

A user can: create a project in a tab, state a goal, watch an org form itself, see the council
debate a real decision, watch tasks execute with live per-agent telemetry, read the reward
ledger and grade changes, approve a risky action, kill the run under budget, and replay the
whole thing — with the security suite green and nothing secret ever leaving the vault.
