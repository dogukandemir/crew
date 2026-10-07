# 17 · Agent-system audit — creation, tooling, capabilities, orchestration, management, collaboration, swarm

Written after reading the control/execution layers against docs/02 §2–5, docs/03 §3–6,
docs/04 §4 and docs/08 §4. Every item says what to check and what it turned out to be;
findings carry `file:line`. Four batches came out of it — all committed; each item below
says what it turned out to be and, when it was broken, what fixed it.

## 1. Agent creation (docs/02 §5: how new units are born)

- **Cap + anti-thrash + cheap-by-default** ✓ — `org.hire_agent` enforces `max_agents`,
  refuses a duplicate role laid off without a fresh rationale, and forces WORKER/ANALYST to
  junior. "Recently" is a real window now — the project's `layoff_idle_days` (batch 3): the
  rule expires instead of blocking a rehire forever.
- **Hiring respects a budget** ✗ — `estimate_agent_cost` (`org.py:851`) exists for exactly
  this and is called from nowhere; department envelopes (`per_department_budget_usd`) are
  set at creation and never consulted again. A project at its ceiling can still be staffed
  into the ground by a planner loop. **FIXED (batch 2)** — the breaker refuses hires and a
  staffing plan beyond the headroom is refused before a row is written; a fresh project
  still bootstraps (the cap governs spend, not existence).
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
  **FIXED (batch 1)** — `approval_granted` consumes a GRANTED row (agent + capability +
  task-or-general scope); `policy.approval.used` records it.
- **`escalate` changes nothing** ✗→✓ — the tool used to emit `task.escalated` and return;
  task state, assignee and the run were untouched, and the API served an `escalated_to`
  nobody ever wrote. **FIXED (batch 3)** — the tool persists the reason and `escalated_to`
  (the manager, else the orchestrator); the failure ladder reassigns from the same marker.

## 3. Collaboration (docs/04 §4 `comms.*`)

- **`ask_colleague` is a dead end** ✗ — `h_ask_colleague` (`tools.py:282`) emits
  `agent.message` and tells the model "the recipient answers asynchronously". Nothing
  delivers the question to the recipient; no agent can answer; nothing ever arrives back.
  The floor walks the asker to a colleague's desk for a conversation that cannot happen.
  **FIXED (batch 2)** — `control/inbox.py`: a message IS an `agent.message` event; the
  recipient's next prompt carries the question and `reply_colleague` closes it.
- **`request_decision` is a dead end** ✗ — nothing consumes `council.requested`
  (`tools.py:304`). The tool promises "the orchestrator will convene a council"; no code
  path does. **FIXED (batch 2)** — `_service_decisions` convenes a real session per
  question (never twice) and the decision binds following work.
- **`agent.delegated` does not exist in the backend** ✗ — the frontend and the event
  vocabulary know it; no backend code ever emits it. Delegation between agents is a
  repaint with nothing behind it. **FIXED (batch 2)** — `delegate_task` creates a real
  task (`parent_id`) and emits the event.
- **`report_to_head`** ✓ event-wise (walks up the manager chain on the floor).

## 4. Orchestration (docs/03)

- **Stage machine** ✓ — INTAKE → PLANNING → STAFFING → EXECUTING → VERIFYING → REWARDING
  → LEARNING, with pause/resume/kill and stage events.
- **Waves, concurrency, budget** ✓ — `_execute` runs waves under
  `asyncio.Semaphore(settings.max_concurrent_crews)`, checks `budget.breaker_open` each
  wave, reserves before each task and settles after; `budget.exceeded` fails just that task.
- **Failure ladder**: top rung ✓ — after `MAX_TASK_ATTEMPTS`, `_escalate_failed_task`
  convenes a real council and binds retry/reduce/abort. **Middle rungs** ✗ — docs/03 §5
  says "worker fails → Lead re-plans → Head re-staffs"; a failed task used to simply retry
  with the same assignee at a higher tier. **FIXED (batch 2)** — the first failure returns
  to the producer's lead ("lead re-plans"); the top rung (council) already existed.
- **Context assembly** ✓ — three-level brain context pack, council decision constraints,
  steering notes (event-sourced) and the capability list are all in the prompt.

## 5. Management (docs/02 §2: managers manage)

- **Managers do not absorb the backlog** ✓ — `ROLE_ASSIGNMENT_PENALTY` (`org.py:72`)
  keeps leads/heads out of IC work unless nobody else can take it.
- **The manager chain is real** ✓ — `manager_id` from the tree drives reports, escalation
  targets, reward shares (lead/head get a share in `reward_engine.settle_task`).
- **No busy state** ✗ — `"busy"` is in `ALLOWED_TRANSITIONS` and in the assignment filter
  (`org.py:708`), but no code ever sets an agent busy. The filter excludes a state that
  never exists; one agent can be handed several concurrent tasks. **FIXED (batch 1)** — an
  atomic claim in `_run_task`, a release on every end path, a reaper at each wave head.

## 6. Swarm behaviour

- **Fan-out exists** ✓ — ready tasks for a wave run concurrently under the semaphore;
  squads group workers; `pairAnchor` on the floor shows squad-mates working together.
- **Per-agent concurrency** ✗→✓ — the semaphore is global; nothing capped how many tasks
  one agent runs at once, and nothing stopped re-assignment onto an agent mid-task (see §5).
  **FIXED (batch 1)** — the busy claim is also the swarm fix.

## 7. Matching (docs/03 §5, docs/02 §4)

- **Zero-coverage assignment** ✗ — `assign_tasks` picks `best_score > 0` where the score
  is `Σ w×prof + 0.05·(grade/5) − 0.001·tasks_done − penalty`. A junior with NONE of the
  required skills scores `+0.01` on grade alone and wins over parking the task. The doc's
  coverage rule (≥ 0.75 at org level) is not a floor here. **FIXED (batch 1)** —
  zero-coverage candidates are skipped; `coverage` rides in `task.assigned`.

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

The mock tells the gossip story (three mouths + a surfaced concern); the real backend
emits the same contract from mined state (`control/gossip.py`). The floor reads
`agent.gossip` (whisper bubble, walk-to-peer) and `agent.delegated`; `gossip.surfaced`
shows in the log.

And it is **served**: `_service_decisions` turns a surfaced concern into a council
session with topic-shaped options (batch 4) — the debate is about what to DO — and the
decision binds following work like any other. The rumour genuinely reaches the agenda.

## Batch plan

**Batch 1 (`a1efce3`):** approval consumption, zero-coverage matching, the busy state.

**Batch 2 (this commit):** the collaboration loops — inbox + answer for `ask_colleague`
(a message IS an `agent.message` event; the recipient's next prompt carries the open
question and `reply_colleague` closes it), the `council.requested` consumer
(`_service_decisions`; the decision binds following work), `delegate_task` (a real
task + `agent.delegated`), the lead re-plan rung in `_requeue_retries`, the hiring
gate (breaker refuses hires; a staffing plan exceeding the headroom is refused before
a row is written) — and the gossip layer above.

**Batch 3 (this commit):** the leftover doors — `h_escalate` persists `escalation_reason`
+ `escalated_to` (batch 2 covered the failure ladder; this covers the agent's own ask),
and the anti-thrash rule gets its window (`layoff_idle_days`): a layoff expires instead
of blocking a rehire forever.

**Batch 4 (this commit):** surfaced concerns reach the council — `_service_decisions`
serves `gossip.surfaced` with topic-shaped options (budget / failing_work / blocked_work
/ struggling_agent), announced once per topic, the outcome binding through the same
decision-constraint channel as every other council.

## Left deliberately open

- Frontend gesture for `agent.delegated` on the floor (the event renders; no dedicated
  walk/hand-off animation yet).
- Real-engine runs still need provider keys (offline runner covers every test).

