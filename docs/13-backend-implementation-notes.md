# 13 — Backend implementation notes (what exists, and what is deliberately missing)

Written at the end of the first implementation session (M0–M8, see docs/12 for status). This is
the map a future session needs before touching code.

## Module map (as built)

```
backend/src/crew/
  __main__.py            CLI: serve · db init|seed|drop · auth create-user · audit verify ·
                         brains list|search · run --project --goal · status
  domain/
    enums.py             the shared vocabulary (Grade, Role, TaskState, Capability, Verdict, …)
    catalog.py           GRADE_LIMITS · GRADE_CAPABILITY_CEILING · ALWAYS_APPROVAL · role
                         templates · 63-skill catalog · RoleSpec
  core/
    settings.py          Settings (pydantic-settings, CREW_* env); refuses `local` auth outside dev
    db.py                async engine, session_scope (the unit of work), create_all bootstrap
    models.py            every table of docs/10 (JSON settings column on projects — see docs/10 note)
    events.py            EventStore (gapless seq per project) + in-process bus + emit()/emit_sync()
                         + payload validation for the documented event types
    security.py          PolicyEngine · CredentialVault (Fernet) · SecretRedactor · BudgetGuard
                         (reserve/settle/release + ledger + circuit breaker) · audited hash chain ·
                         injection scanner · approval helpers · egress allowlist + SSRF guard
    reward.py            compute_reward() (pure) · RewardEngine.settle_task/apply/maybe_transition ·
                         skill proficiency updates · leaderboard
    brains.py            three-level memory: ensure_brain, scoped read/write rights, explainable
                         retrieval scoring, promote, supersede, context pack rendering
  execution/
    models.py            ModelRouter: grade → tier → model id, price table (micro-USD/token),
                         pre-flight reservation estimates
    prompt.py            system/task prompt composition (identity, chain of command, authority,
                         method, memory with trust labels, standing rules)
    tools.py             ToolSpec registry (web_search, http_get, fs_*, shell_run, python_eval,
                         brain_*, artifact_publish, comms) + ToolInvoker (the choke point:
                         capability check → approval → sandbox → redaction → events) +
                         CrewAI BaseTool adapter
    runner.py            CrewAICrewRunner (real) · FakeCrewRunner (offline/tests) · snapshots
  control/
    org.py               project/department/squad/agent lifecycle · hiring with caps & anti-thrash ·
                         heuristic + LLM planning with DAG validation · capability-gap analysis ·
                         assignment (IC-first) · org tree projection · ready_tasks/revive_blocked
    verify.py            deterministic checks → contract → independent evaluator; verdicts
    council.py           convene (hire a panel if the org is too small) → rounds → positions →
                         decide → DecisionRecord with dissent; decision constraints for planning
    orchestrator.py      Orchestrator: start_run · advance (the resumable stage machine, ADR 0007) ·
                         per-task execution with budget reservation, verification and reward ·
                         escalation ladder → council · learning stage · pause/resume/kill/steer
  api/
    auth.py              local mode + HS256 tokens; scrypt (or argon2 if installed) passwords
    routes.py            the REST surface of docs/11
    ws.py                /ws/projects/{id}: hello, replay, filters, coalescing, ping/pong, steer
    main.py              app wiring, lifespan (init_db + seed skills), CORS, error mapping
```

## How to run

```bash
cd backend
uv sync
cp ../.env.example .env          # add a provider key for real runs
uv run python -m crew serve      # or: uv run uvicorn crew.api.main:app --port 8787
uv run pytest                    # 54 tests, no network
uv run pytest -m live            # (not written yet) real provider runs
uv run ruff check src tests      # clean
```

`CREW_OFFLINE_LLM=true` swaps `CrewAICrewRunner` for `FakeCrewRunner`: the whole pipeline
(planning, hiring, dispatch, verification, rewards, learning) still runs, deterministically and
without spending money. That is how the test suite and any offline demo work.

## Bugs found and fixed during the first session (and the tests that now hold them)

| Bug | Cause | Guard test |
|-----|-------|-----------|
| Dependent tasks stranded in `blocked` | the readiness helper mutated ORM rows inside a read-only session, so *inspecting* a task committed `blocked` | `test_individual_contributors_do_the_work`, integration run |
| Budget ledger disagreed with project spend | reconciliation filtered on `scope_kind='project'` while settlements are attributed to the agent | `test_budget_ledger_reconciles_with_spend` |
| A Trainee could request approval for `net.post` | approval gate was evaluated before the grade capability ceiling | `test_trainee_cannot_use_dangerous_capabilities` |
| Managers absorbed IC work | assignment scored only skills + grade, so leads outranked the workers they manage | `test_individual_contributors_do_the_work` |
| Audit chain unverifiable | timestamps were hashed as aware ISO strings but stored naive by SQLite | `test_audit_chain_verifies_and_detects_tampering` |
| Council produced no positions | a project with one agent has no eligible panellists | `test_council_debate_and_decision` |

## Deliberate gaps (not bugs — next session's work)

1. **Alembic migrations** are not generated; dev uses `create_all`. Prod requires a revision.
2. **Embeddings/vector search**: retrieval is lexical + recency + importance + trust. The scoring
   function is one place (`brains.score_entry`) so a vector index drops in behind it.
3. **Docker sandbox** path is implemented but untested here (falls back to `subprocess` in dev;
   prod refuses to run without docker).
4. **`token` auth mode** is implemented and unit-level, but no integration test drives the
   login → bearer → WS handshake flow yet. `local` mode is the tested default.
5. **Replay** exists server-side (`GET /events?from_seq&to_seq`, dossier export); the UI scrubber
   is frontend work.
6. **Live provider runs**: the CrewAI path is exercised through construction + callbacks, but a
   real end-to-end run with a provider key is still pending (needs the user's key).
7. **Concurrency**: crews run in a thread pool with a global semaphore; there is no per-project
   fairness scheduler or job resumption across process restarts beyond the stage machine.
8. **Tool breadth**: `net.post`, `git.push`, `data.sql` are catalogued and policy-gated but not
   implemented — an agent requesting them gets a clear "not granted/approval required" answer.
