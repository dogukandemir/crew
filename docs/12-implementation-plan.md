# 12: Implementation Plan

Milestones are ordered so that each one produces something runnable and testable. "Exit"
means the criteria are demonstrated by tests or by a manual run recorded in the PR.

## Status legend
yes done · 🟡 partial · ⬜ not started

| # | Milestone | Status | Evidence / what is left |
|---|-----------|:------:|-------------------------|
| M0 | **Foundation**, repo, docs, toolchain, crewai, health endpoint | yes | `crew serve` boots (skills seeded=63); `/api/health` → version+contract; crewai 1.15.27 imports; docs + ADRs committed |
| M1 | **Core**, settings, DB, domain model, event store, bus, repos | yes | 30+ tables created, every mutation emits an event, `seq` gapless per project (tested); schema applies through the forward-only migrator (`core/migrations.py`) |
| M2 | **Execution slice**, crewai run end-to-end with live events | yes | `CrewAICrewRunner` + `FakeCrewRunner`; `agent.thought`/`agent.tool.*`/`llm.response` stream over WS with tokens and cost. *Left: one live provider run with real keys (`pytest -m live`)* |
| M3 | **Org engine**, intake → plan → hiring → dispatch | yes | goal → plan (LLM or deterministic) → capability gap → departments/squads/agents hired → task DAG executed in waves; cycle detection tested |
| M4 | **Council & decider**, debate, positions, DecisionRecord, override | yes | convene → panel (hires a critic/decider when the org is too small) → positions → tally/model ruling → decision + dissent preserved; override audited |
| M5 | **Rewards**, verification, reward events, EWMA scores, grades | yes | verdict → reward ledger → score → transition → model tier & spend caps change; `recompute()` matches stored scores |
| M6 | **Observability**, events, WS filters/resume, traces, metrics, dossier | 🟡 | event API + WS (replay/resume/filters/coalescing) + trace tree + cost rollups + dossier export all tested. *Left: frontend replay scrubber* |
| M7 | **Security**, auth, vault, policy, sandbox, egress, budget, audit | 🟡 | policy matrix, SSRF/egress, injection corpus, redaction, audit chain, budget cap enforcement, and the content/command security review gate with the always-allow list (ADR 0017) all tested. Mutation-tested with pytest-gremlins: `security_review.py` 74/74, `workspaces.py` 29/29, `core/security.py` 121/124 (3 byte-equivalent, documented); `execution/tools.py` (240 mutants) is the next frontier, its handler tails still lack direct tests. *Left: docker sandbox path not exercised in CI (verified on the dev host); `token` auth mode implemented but not integration-tested* |
| M8 | **Brains**, 4-level memory, retrieval scoring, promotion, Librarian | 🟡 | scoped reads/writes with rights checks, explainable retrieval scores, promotion/supersession, lessons written by the learning stage. *Left: vector embeddings (retrieval is lexical today)* |
| M9 | **Frontend**, tabbed control room | 🟡 | build in progress (see `frontend/`); contract frozen in docs/11 |
| M10 | **Hardening & packaging**, Postgres/Redis, docker compose, CI, backups | 🟡 | compose distribution, CI and pre-upgrade backups (`core/migrations.py`) exist. *Left: Postgres/Redis, multi-worker* |

## Build order detail (M1–M3, the critical path)

1. `core/settings.py`, `Settings` (pydantic-settings), validated at boot; `local` auth
   requires a loopback listener (a non-loopback bind refuses to start; containers use
   `CREW_CONTAINER_LOCAL_AUTH`).
2. `core/db.py`, async engine/session, SQLite WAL, `create_all` in dev only.
3. `domain/`, enums (`Grade`, `AgentState`, `TaskState`, `RunStage`, `Verdict`…),
   `catalog.py` (role templates, the 63-skill catalog, capability tables), `soul.py` (ADR 0016).
4. `core/events.py`, `EventStore.append()` (transactional seq), `EventBus` (asyncio queues +
   thread-safe emit), `TraceService`.
5. `core/models.py` + `core/db.py`, the ORM rows and the async session (all project-scoped).
6. `execution/models.py`, `ModelRouter` (tier → LiteLLM id, caps, price table).
7. `execution/runner.py`, domain → CrewAI `Agent`/`Task`/`Crew`; callbacks → events;
   returns structured result. `FakeCrewRunner` for tests.
8. `control/orchestrator.py`, the run state machine (docs/03 §1), resumable per stage.
9. `control/org.py` (planning/staffing) + `control/hiring.py`, WBS/DAG + capability-gap hiring.
10. `core/reward.py` + `control/verify.py`, verdicts and reward ledger.
11. `api/*` + `api/ws.py`, REST + socket per docs/11.
12. `frontend/*`, per docs/09 MVP scope.

## Testing strategy

| Level | What | Where |
|-------|------|-------|
| Unit | domain rules, grade tables, reward math, DAG validation, policy matrix | `backend/tests/unit` |
| Contract | every REST endpoint shape vs. docs/11; every event type validated on emit | `backend/tests/api/test_api.py` (`test_ui_contract_shapes`) |
| Integration | orchestrator with `FakeLLM`/`FakeCrewRunner`: goal → plan → hire → run → verify → reward (no network) | `backend/tests/integration` |
| Security | docs/08 §11 suite | `backend/tests/security` |
| Frontend | components + socket reducer + tab store | `frontend/src/**/*.test.tsx` |
| Smoke | one real provider run, marked `@pytest.mark.live`, excluded from CI default | `backend/tests/live` |

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| CrewAI API churn (1.x moving fast) | all CrewAI use confined to `execution/`; pinned version; `FakeCrewRunner` keeps tests stable (ADR 0002) |
| Cost blowups from autonomous hiring | grade-gated cheap defaults, pre-flight budget reservation, `auto_hire` on by default with hire caps and budget gates |
| Runaway swarms / thrash | org limits, hire anti-thrash rule, concurrency semaphores, circuit breaker |
| Observability overhead | coalesced WS frames, body-free event payloads (hashes + artifact refs), payload caps |
| Scope creep into a SaaS | docs/00 §4 out-of-scope list; v1 is local-first single-user |
| Verifier rubber-stamping | independent assignment + verifier accuracy scoring + random second opinion (docs/05 §6) |

## Definition of done for v1

A user can: create a project in a tab, state a goal, watch an org form itself, see the council
debate a real decision, watch tasks execute with live per-agent telemetry, read the reward
ledger and grade changes, approve a risky action, kill the run under budget, and replay the
whole thing, with the security suite green and nothing secret ever leaving the vault.
