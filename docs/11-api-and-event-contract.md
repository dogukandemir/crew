# 11 — API & Event Contract

Frozen contract between `backend` and `frontend`. Any change here is a breaking change:
bump `X-Crew-Contract` (currently `1`) and update the frontend in the same commit.
Content type `application/json`; errors use RFC 7807 (`application/problem+json`).
Auth: `Authorization: Bearer <jwt>` in `token` mode, cookie/`?token=` on the WS handshake.

## 1. Common shapes

```jsonc
// Money is micro-USD ints; time is UTC ISO-8601 ms.
"cost": 1_240_000            // $1.24

// UnitRef (used for links everywhere)
{"kind":"project|department|squad|agent|task|run|decision|council|brain|artifact",
 "id":"uuid", "name":"Display name"}

// Paged envelope
{"items":[...], "next_cursor":"opaque|null", "total":123}

// Problem
{"type":"https://crew/errors/budget-exceeded","title":"Budget exceeded",
 "status":402,"detail":"needs 1.40 USD, 0.62 available","trace_id":"..."}

// Command envelope (write ops)
POST body: {"payload":{...}, "reason":"optional", "idempotency_key":"optional"}
response: {"accepted":true,"event_seq":4123,"unit":{...UnitRef}}
```

### 1a. Fields the UI binds to (asserted by `test_ui_contract_shapes`)

These left the payloads once while the mock kept serving them — the office, the org
chart and every budget bar rendered empty against the real backend (the fresh-clone
audit). Each row now has a guard: change it and the test goes red, not the product
quiet.

| Surface | Endpoint | Fields the UI reads |
|---------|----------|---------------------|
| Every budget bar & meter | `/api/projects*`, `/api/companies*` | `budget_cap_micros`, `spend_micros` (raw ints, alongside the `*_usd` floats) |
| Breadcrumb upper half | `/api/projects*` rows/detail | `company_id`, `company_name` (always present; `null` when standalone) |
| Getting-started checklist | `/api/projects` rows | `runs` |
| Office floor, Org chart, Agents roster | `/api/projects/{id}/org` | `root` — a tree of `{kind: project\|department\|squad\|agent, id, name, children[]}`, every node carrying `spend_micros` (usd on agents too) |
| Org node drawers | `/api/projects/{id}/org` | agent nodes: `role`, `grade`, `grade_label`, `state`, `score`, `success_rate`, `open_tasks`; dept nodes: `mission`, `head_agent_id`, `budget_envelope_micros`, `open_tasks` |
| Company Brains member index | `/api/companies/{id}/brains` | per-brain `owner_name` (a human name, not an id) |
| Agent drawer — Soul card | `/api/agents/{id}` | `soul` + `soul_md` (the rendered one-page profile; empty object/string for pre-ADR-0016 hires) |

The flat keys (`project`, `orchestrator`, `departments`, `unassigned`) ride along
additively for pre-tree readers; `nodes` is the flat index of `root`.

## 2. REST endpoints

### System & auth
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | liveness + version + contract version |
| GET | `/api/system/status` | db, bus, scheduler, vault, providers health |
| POST | `/api/system/kill` | kill all runs (confirm:true) |
| POST | `/api/auth/login` | `{email,password}` → tokens (token mode) |
| POST | `/api/auth/refresh` | rotate access token |
| POST | `/api/auth/logout` | revoke session |
| GET | `/api/auth/me` | current user |

### Projects
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects` | list (id, name, status, stage, spend, budget, badge) |
| POST | `/api/projects` | create `{name, goal, budget_usd?, company_id?, settings?}` — with `company_id` the project is **born under** that company: report chain wired, `company.project.joined` told (ADR 0015) |
| GET | `/api/projects/{id}` | detail + stage + rollups |
| PATCH | `/api/projects/{id}` | rename, edit goal, settings patch |
| POST | `/api/projects/{id}/pause` \| `/resume` \| `/kill` | lifecycle controls |
| DELETE | `/api/projects/{id}` | soft archive |
| GET | `/api/projects/{id}/metrics` | rollups (see docs/07 §6) |
| GET | `/api/projects/{id}/report` | final run report |

### Runs & goals
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/projects/{id}/runs` | `{goal, mode:interactive\|autonomous}` → start |
| GET | `/api/projects/{id}/runs` | list runs |
| GET | `/api/runs/{run_id}` | run detail (brief, plan, stage, cost) |
| POST | `/api/runs/{run_id}/answer` | answer clarification questions |
| POST | `/api/runs/{run_id}/steer` | inject guidance (also `/tasks/{id}/steer`) |
| POST | `/api/runs/{run_id}/cancel` | cancel run |

### Org
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects/{id}/org` | org tree with live stats |
| POST | `/api/projects/{id}/departments` | create department `{name, mission, budget_usd}` |
| GET | `/api/departments/{id}` | detail + roster + KPIs |
| PATCH | `/api/departments/{id}` | mission/budget/capabilities |
| POST | `/api/departments/{id}/archive` | close department |
| POST | `/api/departments/{id}/squads` | create squad `{name, mission, lead_agent_id?}` |
| POST | `/api/squads/{id}/close` | disband (reassign strategy: `{reassign_to}`) |
| POST | `/api/projects/{id}/agents` | hire `{role, grade?, department_id?, skills?, mission?}` |
| GET | `/api/agents/{id}` | full agent detail |
| PATCH | `/api/agents/{id}` | mission, tools, limits (audited) |
| POST | `/api/agents/{id}/promote` \| `/demote` \| `/probation` | manual transition (reason required) |
| POST | `/api/agents/{id}/fire` | archive |
| POST | `/api/agents/{id}/message` | steering DM (delivered at next step) |

### Tasks
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects/{id}/tasks` | filter: state, dept, squad, agent, run |
| POST | `/api/projects/{id}/tasks` | create task manually `{title, description, acceptance_criteria, required_skills, depends_on}` |
| GET | `/api/tasks/{id}` | detail + verification + rewards + artifacts |
| POST | `/api/tasks/{id}/retry` \| `/cancel` \| `/reassign` \| `/escalate` | controls |
| GET | `/api/tasks/{id}/artifacts` | artifact list |

### Boards (ADR 0010)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects/{id}/board` | kanban view: columns with derived states; `?department_id=`/`?squad_id=` scope to a team |
| POST | `/api/projects/{id}/board/items` | create `{kind: epic\|feature\|story\|bug, title, body?, acceptance?, parent_id?, severity?, department_id?, squad_id?, priority?}` (starts in Backlog) |
| PATCH | `/api/board/items/{id}` | move an **unpromoted** item `{state}`; promoted items answer 409 (`its column follows the task`) |

Events: `board.item.created`, `board.item.moved`, `board.item.promoted` (carry `item_id`,
`kind`, and on promotion `task_id`), `task.helper.joined` (`task_id`, `agent_id`).

### Governance (ADR 0011)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/companies/{id}/hq` | the whole company for one floor: executives, board, member pods with teams, governance activity |
| GET | `/api/companies/{id}/portfolio` | the ranked portfolio view: verdicts, weights, shares, proposed caps |
| POST | `/api/companies/{id}/allocate` | the CEO's portfolio call — **writes the member caps**; a `stop` verdict funds nothing new |
| POST | `/api/companies/{id}/board-session` | convene the board of directors `{topic, options?}` (council machinery; `board.convened`) |
| POST | `/api/companies/{id}/board` | seat another director `{role: chair\|board_member}` |
| GET | `/api/companies/{id}/brains` | the umbrella memory page (ADR 0015): the company brain (+ entry count) and a per-member index of where memory lives — read-only; entries open on `GET /api/brains/{id}/entries` |
| POST | `/api/found` | **found a company** `{name, mission, budget_usd, project_name, project_goal, project_budget_usd, workspace_path, mode, start_run}` → the company, its first project born under it, and (optionally) its first run, in one call; seeds the company brain with the mission (ADR 0015). `workspace_path` (absolute) picks the company's workspace root — empty → the default `~/crew/workspace/{company}/{project}` tree (ADR 0017) |

Events: `board.seated`, `board.convened` (`session_id`, `topic`, `members`),
`company.allocation.decided` (`company_id`, `allocations`, `headroom_micros`, `method`).

### The command desk (ADR 0012)
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/projects/{id}/commands` | the Captain writes `{text}` — parsed (TR/EN lexicon; model fallback only when unsure and configured), executed against the real services, answered with citations |
| GET | `/api/projects/{id}/commands` | the desk transcript, straight from the record (`?limit=`) |

Events: `command.message` (`text`, `mode`, `intent`, `mentions`), `command.reply` (`text`,
`ok`, `executed`, `in_reply_to`, `actions[]`), `task.reassigned` (`task_id`, `to_agent_id`,
`from_agent_id`), `agent.break.started` (`agent_id`, `until`). Attribution: message
`actor=user:{id}`, reply `system:orchestrator`. Modes: `order` binds the floor (prompt block
`CAPTAIN DIRECTIVES`), `idea` is weighed, `question` is answered and never reaches task
prompts. `executed` is the honesty gate at the prompt boundary: only messages whose reply
says they landed are read back into task prompts (`orchestrator._captain_notes`).

### Onboarding (ADR 0013)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/onboarding/state` | first-run state: `needed`, `provider`/`model` of the standard tier, `offline_llm`, `vault`, and `providers[]` — the picker roster (DeepSeek/OpenAI/Anthropic/OpenRouter + local Ollama, each with `kind` and a `configured` flag) |
| POST | `/api/onboarding/key` | `{provider, key}` — verified against the provider's models endpoint (401/403 refuses the save; network trouble saves unverified; local Ollama is verified by reaching `{key}/api/tags` and refuses when nothing answers), stored in the vault as `provider:<name>`, **tiers re-pointed via the provider's presets** and persisted to `data/provider.json`, effective in-process, never returned |

Audited (`secret.created`); no domain events. Boot restores vault keys into the process
(`onboarding.load_vault_provider_keys`), and `run.recovered` (`run_id`,
`interrupted_tasks`) marks a run resumed after a server restart.

### Council & decisions
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/projects/{id}/councils` | convene `{question, options[], criteria[], panel?}` |
| GET | `/api/councils/{id}` | session + positions + rounds |
| POST | `/api/councils/{id}/round` | run next round |
| POST | `/api/councils/{id}/decide` | force decision (decider) |
| GET | `/api/decisions?project_id=` | decision log |
| POST | `/api/decisions/{id}/override` | `{reason}` (Orchestrator/user only) |

### Brains
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects/{id}/brains` | tree of scopes with counts |
| GET | `/api/brains/{brain_id}/entries` | list (filter kind, tag, q) |
| POST | `/api/brains/{brain_id}/entries` | manual write |
| GET | `/api/entries/{id}` | entry + links + history |
| POST | `/api/entries/{id}/supersede` | `{new_entry_id, reason}` |
| POST | `/api/entries/{id}/promote` | `{to_brain_id, rationale}` |
| POST | `/api/projects/{id}/brains/search` | debug retrieval: query → scored hits |

### Rewards
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects/{id}/leaderboard` | agents by score |
| GET | `/api/agents/{id}/rewards` | reward ledger |
| GET | `/api/projects/{id}/reward-transitions` | promotions/demotions/layoffs |
| PUT | `/api/projects/{id}/reward-weights` | update weights (audited) |
| POST | `/api/projects/{id}/reward-preview` | what-if on recent events |

Events: `reward.settled` (`agent_id`, `task_id`, `reward`); growth is its own event —
`agent.grew` (`agent_id`, `skills_grown[]`, `company_knowledge {before, after}`,
`effort_weight`), one per verified task, so tenure actually learned is on the record
(ADR 0014).

### Events & observability
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects/{id}/events` | `from_seq,to_seq,type,scope,severity,limit,cursor` |
| GET | `/api/projects/{id}/events/stream` | SSE fallback for WS-hostile environments |
| GET | `/api/traces/{trace_id}` | span tree |
| GET | `/api/runs/{run_id}/dossier` | export run as JSON dossier |
| GET | `/api/projects/{id}/agents/{agent_id}/context` | last step's context pack (debug) |

### Approvals, policy, admin
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects/{id}/approvals` | pending/all |
| POST | `/api/approvals/{id}/grant` \| `/deny` | `{reason, ttl_minutes?, always?}` — `always: true` on a command review also writes the always-allow entry (audited, revocable) |
| GET | `/api/projects/{id}/command-allows` | the owner's always-allow list (ADR 0017) |
| DELETE | `/api/command-allows/{id}` | revoke an allow entry (audited) |
| GET | `/api/projects/{id}/audit` | audit entries (paginated) |
| POST | `/api/system/audit/verify` | verify hash chain |
| GET | `/api/secrets` | handles + metadata (never values) |
| POST | `/api/secrets` | create `{name, value, scope}` (write-only) |
| POST | `/api/secrets/{id}/rotate` | new value |
| GET | `/api/tools` | capability catalog + which are enabled |
| GET | `/api/projects/{id}/egress` | allowlist + blocked attempts |
| POST | `/api/system/backup` \| `/api/system/restore` | backup/restore |

## 3. WebSocket protocol

**Connect:** `GET /ws/projects/{project_id}?token=…&since_seq=0`

**Client → server**
```jsonc
{"action":"subscribe","filters":{"scope":{"department_id":null,"squad_id":null,"agent_id":null,
 "task_id":null},"types":["task.*","agent.tool.*"],"severity_min":"info"}}
{"action":"unsubscribe"}
{"action":"ping","ts":1234567890123}
{"action":"steer","target":{"kind":"agent","id":"…"},"text":"…"}
```

**Server → client**
```jsonc
{"type":"hello","project_id":"…","seq_head":4123,"contract":1,"server_time":"…"}
{"type":"event","seq":4124,"event":{ /* Event row, see docs/10 */ }}
{"type":"events","events":[…]}                       // coalesced batch (100ms window)
{"type":"gap","from":4100,"to":4120,"reason":"backpressure"}
{"type":"replay.complete","up_to":4210}
{"type":"stage","run_id":"…","stage":"EXECUTING","progress":{"done":3,"total":11}}
{"type":"metrics","scope":{…},"metrics":{"cost_usd":1.24,"success_rate":0.8}}
{"type":"pong","ts":1234567890999}
{"type":"error","code":"filter_invalid","detail":"…"}
```

Rules:
- `seq` is the resume cursor; the client persists the highest seen per project in
  `localStorage` and reconnects with `since_seq`, receiving `replay.complete` when caught up.
- Filters are applied server-side; a socket may narrow but never widen its project scope.
- Frames are ≤ 64 KB; oversized payloads are truncated with `{"truncated":true,"ref":…}`.
- Heartbeat: server sends `{"type":"pong"}` every 30 s; client `ping` every 20 s; 90 s of
  silence → the client shows a disconnected banner and retries with backoff.

## 4. Error codes (stable, documented for the UI)

| Code | HTTP | Meaning / UI action |
|------|------|---------------------|
| `budget_exceeded` | 402 | show top-up prompt with required amount |
| `policy_denied` | 403 | show capability + who can approve |
| `approval_required` | 409 | open the approval drawer |
| `capability_gap` | 409 | offer to enable auto-hire or widen limits |
| `org_limit_reached` | 409 | offer to raise `max_agents` / `max_departments` |
| `dag_cycle` | 422 | show the cycle for the Planners/User to fix |
| `not_found`, `conflict`, `validation_error` | 404/409/422 | standard |
| `provider_error` | 502 | show provider + retry/failover state |
| `internal_error` | 500 | trace_id shown for support; details only in logs |

## 5. Versioning & compatibility

- Contract version in `/api/health` and the WS `hello` frame; the frontend refuses to run
  against a mismatched major version.
- Additive fields are allowed any time; removing/renaming requires a contract bump.
- Event `payload` schemas are documented per event type in `backend/src/crew/events/schema.py`
  and validated on emit in dev (`CREW_VALIDATE_EVENTS=true`).
