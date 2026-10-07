# 17 · Agent-system audit — creation, tooling, capabilities, orchestration, management, collaboration, swarm

Written after reading the control/execution layers against docs/02 §2–5, docs/03 §3–6,
docs/04 §4 and docs/08 §4. Every item says what to check and what it turned out to be;
findings carry `file:line`. Two batches come out of it — batch 1 is committed with this
file, batch 2 is the next slice.

## 1. Agent creation (docs/02 §5: how new units are born)

- **Cap + anti-thrash + cheap-by-default** ✓ — `org.hire_agent` enforces `max_agents`,
  refuses a duplicate role without a fresh rationale, and forces WORKER/ANALYST to junior.
- **Hiring respects a budget** ✗ — `estimate_agent_cost` (`org.py:851`) exists for exactly
  this and is called from nowhere; department envelopes (`per_department_budget_usd`) are
  set at creation and never consulted again. A project at its ceiling can still be staffed
  into the ground by a planner loop. → batch 2.
- **The roster is re-derivable** ✓ — `org_tree`, `serialize_project`, nodes carry state,
  grade, skills; the floor plan reads the same tree the API serves.

## 2. Tooling (docs/04 §4, docs/08 §4)

- **One choke point** ✓ — every side effect goes through `ToolInvoker.invoke`
  (`execution/tools.py:385`): capability grant → `policy.check` → approval gate → handler →
  redaction → `agent.tool.call` + `agent.tool.result` events.
- **Containment** ✓ — `_jailed` realpath containment; shell in a docker sandbox with
  `--network none` where available; `python_eval` uses `-I -S`; untrusted content marked.
- **The approval loop did not close** ✗ — `request_approval` ✓ and `decide_approval` ✓
  exist, but `policy.check` (`core/security.py:94`) never consults a GRANTED approval: the
  human approves and the retried tool call is answered `approval_required` again, forever.
  → batch 1 (fix).
- **`escalate` changes nothing** ✗ — the tool emits `task.escalated` and returns; task
  state, assignee and the run are untouched. The UI shows the ribbon; the machinery does
  not move. → batch 2 (with the ladder below).

## 3. Collaboration (docs/04 §4 `comms.*`)

- **`ask_colleague` is a dead end** ✗ — `h_ask_colleague` (`tools.py:282`) emits
  `agent.message` and tells the model "the recipient answers asynchronously". Nothing
  delivers the question to the recipient; no agent can answer; nothing ever arrives back.
  The floor walks the asker to a colleague's desk for a conversation that cannot happen.
  → batch 2: an event-sourced inbox + answer loop (the pattern `_steering` already uses).
- **`request_decision` is a dead end** ✗ — nothing consumes `council.requested`
  (`tools.py:304`). The tool promises "the orchestrator will convene a council"; no code
  path does. → batch 2.
- **`agent.delegated` does not exist in the backend** ✗ — the frontend and the event
  vocabulary know it; no backend code ever emits it. Delegation between agents is a
  repaint with nothing behind it. → batch 2, together with the inbox.
- **`report_to_head`** ✓ event-wise (walks up the manager chain on the floor).

## 4. Orchestration (docs/03)

- **Stage machine** ✓ — INTAKE → PLANNING → STAFFING → EXECUTING → VERIFYING → REWARDING
  → LEARNING, with pause/resume/kill and stage events.
- **Waves, concurrency, budget** ✓ — `_execute` runs waves under
  `asyncio.Semaphore(settings.max_concurrent_crews)`, checks `budget.breaker_open` each
  wave, reserves before each task and settles after; `budget.exceeded` fails just that task.
- **Failure ladder**: top rung ✓ — after `MAX_TASK_ATTEMPTS`, `_escalate_failed_task`
  convenes a real council and binds retry/reduce/abort. **Middle rungs** ✗ — docs/03 §5
  says "worker fails → Lead re-plans → Head re-staffs"; today a failed task simply retries
  with the same assignee at a higher tier. → batch 2.
- **Context assembly** ✓ — three-level brain context pack, council decision constraints,
  steering notes (event-sourced) and the capability list are all in the prompt.

## 5. Management (docs/02 §2: managers manage)

- **Managers do not absorb the backlog** ✓ — `ROLE_ASSIGNMENT_PENALTY` (`org.py:72`)
  keeps leads/heads out of IC work unless nobody else can take it.
- **The manager chain is real** ✓ — `manager_id` from the tree drives reports, escalation
  targets, reward shares (lead/head get a share in `reward_engine.settle_task`).
- **No busy state** ✗ — `"busy"` is in `ALLOWED_TRANSITIONS` and in the assignment filter
  (`org.py:708`), but no code ever sets an agent busy. The filter excludes a state that
  never exists; one agent can be handed several concurrent tasks. → batch 1 (fix).

## 6. Swarm behaviour

- **Fan-out exists** ✓ — ready tasks for a wave run concurrently under the semaphore;
  squads group workers; `pairAnchor` on the floor shows squad-mates working together.
- **Per-agent concurrency** ✗ — the semaphore is global; nothing caps how many tasks one
  agent runs at once, and nothing stops re-assignment onto an agent mid-task (see §5).
  → batch 1 (the busy fix is also the swarm fix).

## 7. Matching (docs/03 §5, docs/02 §4)

- **Zero-coverage assignment** ✗ — `assign_tasks` picks `best_score > 0` where the score
  is `Σ w×prof + 0.05·(grade/5) − 0.001·tasks_done − penalty`. A junior with NONE of the
  required skills scores `+0.01` on grade alone and wins over parking the task. The doc's
  coverage rule (≥ 0.75 at org level) is not a floor here. → batch 1 (fix).

## 8. Verification and reward (docs/03 §6, docs/05)

- **Independent verifier** ✓ — `pick_verifier` excludes the producer and prefers a
  different squad; deterministic checks run before the judge; contradiction and
  tool-error-rate feed the settlement.
- **Reward shares** ✓ — producer, lead, head, verifier all settle on one task.

## 9. Memory (docs/06)

- **Three levels** ✓ — personal/department/project brains; `brain_search`/`brain_write`
  tools guarded by capability; context pack scores trust and recency.

## 10. Observability (docs/07)

- **Everything emits** ✓ — stages, tasks, tools, policy decisions, security events,
  steering, councils, decisions, rewards. The office floor reads the same stream the
  Events panel does.

## 11. Office gossip (batch 2, the user's ask)

Gossip is a first-class signal, not decoration (`control/gossip.py`):

- every item is **mined from real state** — budget burn, failed tasks, blocked work,
  people on probation — and carries `basis` (the rows it is retold from), so the
  office can only repeat what the books already say. No invention;
- `agent.gossip` names both mouths (the floor can animate them);
- when the same topic is heard from ≥ 3 distinct agents, `gossip.surfaced` fires once
  and the concern lands in the project brain — a rumour becomes a problem the
  company has to look at.

Open: nothing in the frontend renders `agent.gossip`/`agent.delegated` yet, and the
mock tells no gossip stories yet — both are presentation work on a live contract.

## Batch plan

**Batch 1 (`a1efce3`):** approval consumption, zero-coverage matching, the busy state.

**Batch 2 (this commit):** the collaboration loops — inbox + answer for `ask_colleague`
(a message IS an `agent.message` event; the recipient's next prompt carries the open
question and `reply_colleague` closes it), the `council.requested` consumer
(`_service_decisions`; the decision binds following work), `delegate_task` (a real
task + `agent.delegated`), the lead re-plan rung in `_requeue_retries`, the hiring
gate (breaker refuses hires; a staffing plan exceeding the headroom is refused before
a row is written) — and the gossip layer above.

