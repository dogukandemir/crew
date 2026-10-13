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
uv run pytest                    # full suite, no network
uv run pytest -m live            # real provider runs (needs a key, costs cents)
uv run ruff check src tests      # clean
```

`CREW_OFFLINE_LLM=true` swaps `CrewAICrewRunner` for `FakeCrewRunner`: the whole pipeline
(planning, hiring, dispatch, verification, rewards, learning) still runs, deterministically and
without spending money. That is how the test suite and any offline demo work.

## Mutation testing (pytest-gremlins)

Coverage proves a line ran; it never proves the test would notice the line being WRONG.
Mutation testing closes that gap: the tool is **pytest-gremlins** (pytest-native, parallel,
JSON/HTML report, Windows-safe). The default scope lives in `[tool.pytest-gremlins]`
(pyproject): the security spine — the modules where a wrong answer costs the most.

```bash
cd backend && uv run python -m pytest <only the test files covering the target> \
  --gremlins --gremlin-parallel --gremlin-workers 6 --gremlin-clear-cache \
  --gremlin-targets=src/crew/<module>.py --gremlin-report=console,json
# report → coverage/gremlins/gremlins.json (gitignored)
```

Verdicts from the first full pass and after the kill rounds:

| module | mutants | first pass | now | notes |
|---|---|---|---|---|
| `control/security_review.py` | 74 | 46 (62%) | **74 (100%)** | |
| `control/workspaces.py` | 29 | 17 (59%) | **29 (100%)** | |
| `core/security.py` | 124 | 61 (49%) | **121 (98%)** | 3 survivors byte-equivalent (below) |
| `execution/tools.py` | 240 | 47 (20%) | **122 (51%)** | survivors cluster in handler tails: social 33, shell/python_eval 29, brain/artifact 21 — add handler tests as you touch them |

Rules that cost real time on this host:

- **Pass only the covering test files.** Per-mutant cost IS the selected suite; the first
  run passed the entire suite and one mutant idled for 33 minutes.
- **`--gremlin-clear-cache` after ANY test edit** — the cache keys on source, not tests;
  without it you re-read stale verdicts.
- **Def-line mutants get mis-selected tests.** Coverage attributes the `def`/signature line
  to whichever test imported the module first, so e.g. a flipped default argument
  (`use: bool = False`) can be "checked" against a single unrelated test. Chase stragglers
  with `--gremlin-no-coverage-filter` (runs the whole selection per mutant), and diagnose
  with `--gremlin-explain=<gremlin_id>` (prints the covering set vs the selected set).
- **The session DB is shared**: a tamper test must RESTORE the row it broke or every later
  `verify_audit_chain` fails (this poisoned `tests/security` once), and budget tests must
  build their ledger math with real `reserve/settle` calls — seeding `spend_micros` directly
  makes `reconcile` honestly fail.
- **A survivor can be equivalent** — 3 remain in `core/security.py` and are documented, not
  chased: `scope_kind == "x" and scope_id` → `or` only changes paths whose `s.get()` finds
  nothing, and `budget_cap_micros > ceiling` → `>=` rewrites the same value it compared.
- Counting mutants per module: `collect_gremlins` mis-collects — use
  `transform_source` + `get_default_registry` (the numbers above).

### Bugs found by mutation testing

| Bug | Cause | Guard test |
|-----|-------|-----------|
| Every real-provider run died before its first tool call (`NameError: description`) | `build_crewai_tools._make` defined class attributes `description`/`args_schema` that shadowed the closure parameters they read — LOAD_NAME (class scope) never sees the closure | `test_crewai_wrappers_roundtrip` |
| Budget availability math, settle/release bookkeeping, dept/agent clamps: 63 mutants survived | the arithmetic, the strict `>` on reserve, the scope dispatch (`department_id if kind == … else None`) and the settle attribution had no exact-value tests | `test_budget_available_math_boundaries_and_breaker`, `test_budget_department_and_agent_clamps` |
| A granted content-review for ONE url released a DIFFERENT url | `kind != "content_review" or url != url` → `and` in release_for_content/command binds the wrong approval | `test_releases_are_bound_to_the_reviewed_url_and_norm` |
| Audit chain could hash order-dependently / lose the actor | `sort_keys=True` off → canonical form varies with key order; `agent_id or ""` → `and` drops the requester from the audit | `test_canonical_form_ignores_key_order`, `test_approval_request_audits_the_agent_as_actor` |
| A plain secret reveal could mint a lease | `use: bool = False` has a default — only `use=True` may write a `SecretLease`; nothing asserted the negative | `test_vault_reveal_unknown_and_lease_only_on_use` |

## Fixed from the end-user review pass (2026-10)

A live walkthrough (fresh install, full journey) drove this batch — commits `1ff0105`,
`ddc7057`, `355fa78`:

| Finding | Cause | Fix / guard |
|---------|-------|-------------|
| Events showed "2h ago" on rows seconds old; history shifted by the host offset | SQLite returns naive datetimes; browsers parse naive ISO as LOCAL | every wire timestamp goes through `events.utc_iso`; `format.ts` parses naive strings as UTC (tests both sides) |
| The Captain's desk orders never ran ("It runs with the next wave") | `ready_tasks`/`assign_tasks` filtered `Task.run_id == run.id`, so standalone tasks (run_id NULL) were invisible to every wave | both queries include run-less tasks; a wave adopts them into its run on pickup (`_run_task`); the reply says "queued — press Start run" when no run is open |
| "Start run" with an unchanged goal silently re-planned and re-charged everything | no prior-work awareness | Overview asks first when the goal already produced completed tasks (or a run is open) |
| Tasks table showed raw agent-id prefixes; Verification column explained an API path | no roster join; a caption shipped as column content | assignee/department/squad resolve names via the org tree; verdict badge shown when present |
| Success showed 0% for never-worked agents; G1–G4 undefined | zero done ≠ zero success; jargon without legend | "—" + tooltip; grade chips carry class names; score tooltip |
| `weights=NaN` in the reward ledger | `Number({...})` on the weights dict | render only finite numeric components |
| 11 user-visible `(docs/NN)` / API-path strings across 9 panels | copy hygiene | replaced with user language |
| Board cards clipped; the whole board scrolled vertically | column lists had no height constraint (`min-h-0 flex-1 overflow-y-auto` now) | verified live: each column scrolls its own cards |

## Bugs found and fixed during the first session (and the tests that now hold them)

| Bug | Cause | Guard test |
|-----|-------|-----------|
| Dependent tasks stranded in `blocked` | the readiness helper mutated ORM rows inside a read-only session, so *inspecting* a task committed `blocked` | `test_individual_contributors_do_the_work`, integration run |
| Budget ledger disagreed with project spend | reconciliation filtered on `scope_kind='project'` while settlements are attributed to the agent | `test_budget_ledger_reconciles_with_spend` |
| A Trainee could request approval for `net.post` | approval gate was evaluated before the grade capability ceiling | `test_trainee_cannot_use_dangerous_capabilities` |
| Managers absorbed IC work | assignment scored only skills + grade, so leads outranked the workers they manage | `test_individual_contributors_do_the_work` |
| Audit chain unverifiable | timestamps were hashed as aware ISO strings but stored naive by SQLite | `test_audit_chain_verifies_and_detects_tampering` |
| Council produced no positions | a project with one agent has no eligible panellists | `test_council_debate_and_decision` |

## Bugs found and fixed by the fresh-clone audit

The audit cloned the repo into a clean directory, ran it with `CREW_OFFLINE_LLM=true`
against an empty `CREW_DATA_DIR`, and walked the product end to end. The mock had been
flattering the UI: two shapes the frontend and `dev/mock` agreed on were never served
by the real backend.

| Bug | Cause | Guard test |
|-----|-------|-----------|
| Office, Org chart and Agents roster showed "nobody hired" under a completed run | `/org` served `{project, orchestrator, departments[]}` while every reader walks `org.data?.root`; the mock served `{root}` | `test_ui_contract_shapes`, `test_org_tree.py` |
| Every budget bar read "— / —" / "$0.00 / $0.00" | `serialize_project()` shipped only `*_usd`; the UI binds `budget_cap_micros`/`spend_micros` | `test_ui_contract_shapes` |
| First live re-run of the fix crashed `org_tree` | `Squad` has no spend column (mock squads had one) — the empty-project contract test never walked a squad | `test_org_tree_is_a_rooted_tree_with_squads` |
| A brand-new project displayed "on track" | verdict fell through to `on_track` with zero finished work | `test_a_member_with_no_finished_work_is_never_on_track` |
| Company Brains member index showed "person · personal", no names | rollup skipped owner-name resolution | contract test's `owner_name` assertion |
| UI on Vite 5174+ could not reach a dev backend | CORS pinned to `localhost:5173` | dev `allow_origin_regex` in `api/main.py` (any localhost port) |

Contract guard: `docs/11 §1a` lists every field the UI binds per surface, and
`test_ui_contract_shapes` asserts them against the real app — the drift class now
fails a test instead of the product. Also this round: the founding wizard is the only
company creation path, command-desk examples are English, and vitest 3 → 5 cleared
`npm audit` (dev-only advisories).

## Fixed after the first CI observation (2026-10)

The hosted workflows ran for this tree for the first time on 13 October (`cba4531`):
both Windows legs and the Compose job passed, and the ubuntu backend leg failed on two
directory-picker tests.

| Bug | Cause | Guard test |
|-----|-------|-----------|
| `test_pick_directory_returns_the_os_choice` and `test_pick_directory_cancel_and_unsupported` failed on ubuntu-latest | the tests patched `_pick_directory_native` but not `_picker_available`, so on a runner without `zenity` the route answered `supported: false` — correctly — and the assertion failed. A host assumption in the test, not a route defect | the same two tests now pin `_picker_available` (True for the dialog path, then False for the unsupported path) |

The runner condition is reproducible on Windows: `backend/tests/plugins/no_picker.py`
autouse-patches `_picker_available` to `False` for the whole session, so the pickerless
path can be exercised with
`cd backend && PYTHONPATH=tests/plugins uv run pytest -p no_picker -q`
(a Linux-only assertion cannot come back unnoticed).

## The deliverables surface (three scopes) and operating cadence (2026-10)

**Deliverables.** One artifact record, three readable scopes — individual agent, department,
company — with the producing agent's name on every row (and the project name at company
scope). Backend: `GET /api/projects/{id}/artifacts` (`?agent_id`/`?department_id`),
`GET /api/companies/{id}/artifacts` (`?project_id`/`?agent_id`), and
`GET /api/artifacts/{id}/content` — a bounded (256 KB) text read that refuses any file
outside the data directory, saying the reason out loud. Every deliverable ALSO downloads:
`/api/artifacts/{id}/download` (the full file, attachment) and zip packs at project and
company scope (`/artifacts/download`, per-project folders, `_unavailable.txt` for files
that could not ship). UI: a **Deliverables** tab on every workspace (project and company
forms of the same panel; filters + click-to-read + per-row and "Download all" buttons), and
a per-agent section in the agent drawer. The offline runner writes a REAL deliverable file
per simulated task — **byte-exact** (`write_bytes`: text mode would rewrite `\n` to `\r\n`
on Windows and the recorded sha256/bytes would describe a file that does not exist) — a
demo whose deliverables surface is empty would lie.

**Operating cadence.** The answer to "the run ended, now the company just sits there":
`settings.cadence_enabled` + `settings.cadence_max_runs` (1–10, default 3). When a run
COMPLETES, the engine starts one follow-on pass (`Continue: <goal> (follow-on pass n/m)`),
emits `run.cadence.started`, and stops at the cap with `run.cadence.held`. A person's run
resets the streak; failures and pauses never continue. Off by default — the breakpoints are
visible in the record either way.

## Deliberate gaps (not bugs — next session's work)

1. **Alembic migrations** are not generated; dev uses `create_all`. Prod requires a revision.
2. **Embeddings/vector search**: retrieval is lexical + recency + importance + trust. The scoring
   function is one place (`brains.score_entry`) so a vector index drops in behind it.
3. **Docker sandbox**: shell/python run in the container or not at all (ADR 0017) — the dev
   `subprocess` fallback was removed and docker-less environments refuse loudly. Gate logic is
   unit-tested with a stubbed runner; the container path itself is exercised on the dev host
   (docker present) — no CI job pins it yet.
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
