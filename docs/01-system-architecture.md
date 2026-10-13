# 01 — System Architecture

## 1. Layered view

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  FRONTEND — React/TS tabbed control room (frontend/)                         │
│  Tabs = projects · Org chart · Task DAG · Agent timeline · Council debate     │
│  Live via one WebSocket per tab + REST for commands                          │
└───────────────▲───────────────────────────────────────────┬──────────────────┘
                │ WS events (read)                          │ REST commands (write)
┌───────────────┴───────────────────────────────────────────▼──────────────────┐
│  API LAYER (backend/src/crew/api)                                            │
│  FastAPI routers: projects · org · tasks · agents · rewards · events · auth   │
│  WS hub: /ws/projects/{id} (filter by dept/squad/agent, resume from seq)      │
└───────────────┬───────────────────────────────────────────┬──────────────────┘
                │                                           │
┌───────────────▼─────────────────┐        ┌────────────────▼──────────────────┐
│  ORGANIZATION / CONTROL PLANE   │        │  EXECUTION PLANE                  │
│  OrchestratorRuntime            │        │  CrewRunner (CrewAI)              │
│   · goal intake & decomposition │        │   · builds Agent/Task objects     │
│   · capability gap → hire/fire  │        │   · hierarchical or sequential    │
│   · budget & schedule           │        │   · step/task callbacks → events  │
│   · escalation & arbitration    │        │  CouncilRunner (debate → decision)│
│   · council convening           │        │  ToolInvoker (policy + sandbox)   │
│   · reward settlement           │        │  ModelRouter (tier by grade)      │
└───────────────┬─────────────────┘        └────────────────┬──────────────────┘
                │                                           │
┌───────────────▼───────────────────────────────────────────▼──────────────────┐
│  CORE SERVICES                                                               │
│  EventStore (append-only) · EventBus (in-proc → Redis) · BrainService        │
│  RewardEngine · PolicyEngine · CredentialVault · BudgetGuard · AuditChain    │
│  Repositories (SQLAlchemy) · Scheduler (async workers) · TraceService        │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────────────────────────┐
│  STORAGE: SQLite (dev) → Postgres (prod)  ·  Vector index (sqlite-vec/Chroma) │
│           Workspaces on disk  ·  Artifacts on disk  ·  Logs (structlog JSON) │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Hard rule (dependency direction):** `api → control → core → storage`. The execution plane
never writes to the database directly; it emits events and calls core services. The frontend
never talks to CrewAI. Nothing above `core` knows that CrewAI exists except
`execution/` (see ADR 0002).

## 2. Components

| Component | Module | Responsibility |
|-----------|--------|----------------|
| API | `api/main.py`, `api/routers/*` | HTTP surface, auth dependency, validation, error mapping |
| WS Hub | `api/ws.py` | Per-project socket fan-out, topic filters, `since_seq` resume |
| Orchestrator | `control/orchestrator.py` | Executive agent; owns plan, budget, arbitration |
| OrgService | `control/org.py` | Create/mutate project, department, squad, agent; membership |
| HiringService | `control/hiring.py` | Capability gap → role specs → new agents/departments |
| Planner | `control/planner.py` | Goal → WBS → task DAG; dependencies & acceptance criteria |
| CouncilService | `control/council.py` | Convene specialists, run debate rounds, collect positions |
| Decider | `control/decider.py` | Issue final `DecisionRecord` with rationale + confidence |
| Scheduler | `control/scheduler.py` | Async worker pool, concurrency limits, retries, resume |
| CrewRunner | `execution/crew_runner.py` | Translate domain Task/Squad → CrewAI `Agent`/`Task`/`Crew`; run |
| CouncilRunner | `execution/council_runner.py` | CrewAI crew in "debate" shape over a question |
| ToolRegistry | `execution/tools/*` | Built-in tools (web, fs, shell, git, http, python, brain, comms) |
| ToolInvoker | `execution/invoker.py` | Policy check → vault injection → sandbox → audit → result |
| ModelRouter | `execution/models.py` | Grade/tier → LiteLLM model id, params, token caps |
| BrainService | `core/brains.py` | 3-level memory: read scopes, write scopes, retrieval, promotion |
| RewardEngine | `core/rewards.py` | Score outcomes, EWMA update, grade transitions, penalties |
| Verifier | `core/verify.py` | Deterministic checks > test execution > judge model > peer vote |
| PolicyEngine | `core/policy.py` | Capability grants, approvals, egress rules, injection guards |
| CredentialVault | `core/vault.py` | Encrypted secrets, lease-based injection, never in prompts |
| BudgetGuard | `core/budget.py` | Reservation + spend ledger, hard stops, circuit breaker |
| AuditChain | `core/audit.py` | Hash-chained privileged-action log |
| EventStore | `core/events.py` | Append-only events with monotonic `seq` per project |
| EventBus | `core/bus.py` | In-process pub/sub now, Redis Streams later (same interface) |
| Repositories | `core/repo/*` | Async SQLAlchemy access, unit of work |
| TraceService | `core/trace.py` | Span tree assembly, OTEL export (optional) |

## 3. Stack decisions

| Concern | Choice | Why |
|---------|--------|-----|
| Language (backend) | Python 3.13 | CrewAI is Python; keeps one runtime for agents (crewai 1.15.27 itself caps below 3.14) |
| Web framework | FastAPI + Pydantic v2 | Async, typed, generates OpenAPI for the frontend |
| ORM | SQLAlchemy 2.x async + Alembic | Mature, switchable between SQLite/Postgres |
| Agent runtime | CrewAI (+ crewai-tools) | Agents/Tasks/Crews/Flows + memory + guardrails |
| Model access | LiteLLM (via CrewAI) | One interface, many providers, cost/token metadata |
| Vector store | sqlite-vec (dev) → pgvector (prod) | No extra service in dev |
| Frontend | React 19 + TS + Vite | Fast dev loop, tabbed SPA, matches existing projects |
| Client state | TanStack Query (server) + Zustand (UI) | Commands vs. socket-fed caches cleanly separated |
| Graph viz | React Flow (org chart, task DAG) | Interactive, layout-friendly |
| Live channel | WebSocket | Bidirectional, ordered, supports resume; ADR 0006 |
| Logging | structlog → JSON | Correlate by `trace_id`/`project_id` |
| Tests | pytest + httpx AsyncClient; vitest + RTL | Backend behaviour and frontend components |

## 4. Runtime model

### 4.1 Process layout (dev)
One `uvicorn` process serves the API and hosts the scheduler. Crews run in a
`ThreadPoolExecutor` because CrewAI is synchronous; each crew gets a thread, each project has
a semaphore (`CREW_MAX_CONCURRENT_CREWS`). Events are emitted from those threads into an
`asyncio` queue via `loop.call_soon_threadsafe`.

### 4.2 Process layout (prod, later)
`api` (stateless, N replicas) + `scheduler` (leader-elected, M replicas) + `crew-worker`
(pool, cancellable) + Redis Streams bus + Postgres. Same code, different entrypoints —
enabled by the bus/repository interfaces, not by a rewrite.

### 4.3 Concurrency & cancellation
- Every run is a **job** row (`jobs` table) with `state`, `attempt`, `heartbeat_at`, so a
  restart resumes or fails-forward instead of silently losing work.
- Cancellation: a `cancel_requested` flag on the job; runners check it in
  `step_callback` and between tasks and raise `TaskAborted`. Hard interrupt kills the thread
  only after the current LLM/tool call returns (CrewAI offers no preemption).
- Timeouts: per task wall-clock, per LLM call, per tool call; all enforced.

### 4.4 Determinism & replay
Events are the source of truth for the UI and for replay. Business tables are the current
projection. A `Rebuilder` can replay the event log to reconstruct derived state (scores,
rollups) — used in tests and after a bug fix.

## 5. How CrewAI is embedded (ADR 0002 summary)

- **Crews** execute bounded work: one squad, one workstream, one wave of the DAG. Hierarchical
  process when the squad has a distinct manager; sequential when work is a pipeline.
- **Flows** drive the *organization-level* control flow (intake → plan → hire → dispatch →
  verify → reward → learn), because it must be deterministic, resumable and inspectable —
  which is exactly what `@start/@listen/@router` gives us.
- CrewAI never decides the org chart, budget or policy. Those live in our control plane.
- We wrap CrewAI behind `execution/` interfaces (`CrewRunner`, `CouncilRunner`) so a future
  engine swap (e.g. LangGraph, custom loop) touches one folder. Tests use a
  `FakeCrewRunner` and never hit a network.
- CrewAI callbacks (`step_callback`, `task_callback`, tool hooks) are the *only* sanctioned
  observation points; they emit our domain events.

## 6. Cross-cutting concerns

| Concern | Mechanism |
|---------|-----------|
| Correlation | `trace_id` (one per goal run) + `span_id` + `parent_span_id` on every event/LLM/tool call |
| Idempotency | All mutating endpoints accept `Idempotency-Key`; jobs keyed by `(task_id, attempt)` |
| Config | `pydantic-settings`, one `Settings` object, env-driven, validated at boot |
| Errors | Typed `CrewError` tree → HTTP problem+json; agent-visible errors are sanitized (no stack traces to models) |
| Migrations | Alembic autogenerate, one head, checked in CI |
| Feature flags | `settings` table per project (e.g. `council.enabled`, `hiring.auto`) |
