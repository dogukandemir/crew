# 07: Observability

You must be able to see the organization think. Observability here is not a logging
afterthought: the **event log is the primary data structure** and the UI is a projection of it.

## 1. The event model

One table, append-only, monotonic `seq` per project:

```
Event
├─ id (uuid4().hex), project_id, seq (bigint, per project, gapless-enough for resume)
├─ ts (UTC ms), type (dotted), severity: debug|info|notice|warning|error|critical
├─ scope: department_id?, squad_id?, agent_id?, task_id?, run_id?, job_id?
├─ trace_id, span_id, parent_span_id
├─ title (human, one line), summary (short), payload (typed JSON per event type)
├─ cost_micros, tokens_in, tokens_out, duration_ms
└─ actor: user | system | agent:<id> | tool:<name>
```

Types are namespaced so the UI can filter and the replay can reconstruct:

| Namespace | Examples |
|-----------|----------|
| `project.*` | `project.created`, `project.paused`, `project.archived`, `project.budget.warning` |
| `run.*` | `run.started`, `run.stage.changed`, `run.completed`, `run.failed` |
| `org.*` | `org.department.created`, `org.agent.hired`, `org.agent.promoted`, `org.squad.disbanded` |
| `task.*` | `task.created`, `task.assigned`, `task.started`, `task.step`, `task.completed`, `task.failed`, `task.escalated` |
| `agent.*` | `agent.thought`, `agent.message`, `agent.tool.call`, `agent.tool.result`, `agent.delegated`, `agent.escalated` |
| `llm.*` | `llm.request`, `llm.response`, `llm.error`, `llm.retry` (tokens + cost + latency); `llm.response` carries the billed buckets: `cached_tokens_in`, `reasoning_tokens`, `peak` |
| `council.*` | `council.convened`, `council.position`, `council.round`, `council.decided` |
| `decision.*` | `decision.recorded`, `decision.overridden` |
| `reward.*` | `reward.settled`, `reward.penalty`, `reward.rolled_up` |
| `brain.*` | `brain.written`, `brain.promoted`, `brain.superseded` |
| `verify.*` | `verify.started`, `verify.check`, `verify.verdict` |
| `policy.*` | `policy.allowed`, `policy.denied`, `policy.approval.requested`, `policy.approval.granted` |
| `security.*` | `security.injection.detected`, `security.egress.blocked`, `security.content.reviewed`, `security.content.quarantined`, `security.content.released`, `security.command.reviewed`, `security.command.allowed`, `security.allow.added`, `security.allow.removed`, `security.sandbox.unavailable`, `security.secret.redaction`, the review gate's trail (ADR 0017); quarantines and releases are audited too |
| `budget.*` | `budget.reserved`, `budget.spent`, `budget.exceeded`, `budget.circuit_open`, `budget.paused` (the numbers behind a pause), `budget.overrun` (a call cost more than its reservation) |
| `user.*` | `user.steering`, `user.approval`, `user.command`, `user.message` |

`agent.thought` and `agent.tool.call` are emitted from CrewAI's `step_callback`/task callbacks;
`llm.*` from a LiteLLM callback wrapper. **No polling anywhere**: if it isn't an event, it
didn't happen as far as the UI is concerned.

## 2. Tracing

Every goal run gets one `trace_id`. The span tree:

```
run (goal)
└── stage: PLANNING
    └── llm.plan  
└── stage: EXECUTING
    ├── task: research-market      (span)
    │   ├── agent step 1 (span) → llm call (span) → tool call (span, child of step)
    │   └── agent step 2 …
    └── task: design-schema
        └── council (span) → position spans → decision (span)
```

- Spans are materialized from events (`parent_span_id`), so the trace view needs no separate
  collector.
- OTEL export is opt-in (`settings.otel.enabled`), spans are already OTEL-shaped
  (`trace_id`, `span_id`, attributes incl. `crew.agent.id`, `crew.cost_usd`), so wiring an
  OTLP exporter later is a small adapter.
- **Cost attribution** rides the same tree: `llm.*` events carry tokens + `cost_micros`,
  rollups are computed by scope. "Which department burned $3.20 and on what?" is a query.

## 3. The three live views (explicitly requested)

### 3.1 By project
- Mission control: goal, run stage, progress (tasks done/total), burn-down of budget, org
  count, live activity ticker, open decisions & approvals, escalations.
- Task DAG with per-node state; click a node to jump to its agent/trace.
- Org chart (React Flow) with live status badges and score/cost per unit.
- Health: failure taxonomy breakdown, stuck jobs (heartbeat stale), rate-limit pressure.

### 3.2 By department / group
- Roster table: agent, grade, score, state, cost, tasks, last action, sortable, clickable.
- Backlog: tasks owned, in-flight, blocked (and *why* they're blocked).
- Department brain activity: recent writes, promotions, supersessions.
- Department KPIs: success rate, rework rate, avg cost per task, escalations to/from.
- Department timeline: swimlane of its squads and tasks over time.

### 3.3 By individual agent
- Live timeline of thoughts, tool calls (request + result, truncated), messages, escalations,
  with per-step latency and cost.
- Context inspector: exactly what was retrieved from memory for the current step (with
  provenance), the prompt hash/version, and the token budget used, this is the single most
  useful debugging surface in the whole product.
- Score card: reputation + trend, per-skill proficiency bars, reward ledger, penalties,
  promotions, grade progress.
- Controls: message/steer, pause, reassign, promote/demote (manual override, audited), fire.

## 4. Real-time transport

- `ws://…/ws/projects/{project_id}`, sends `{type:"event", seq, …}` frames.
- Client sends `{action:"subscribe", filters:{department_id|squad_id|agent_id, types[]}, since_seq}`;
  the hub honors filters server-side (no client-side firehose).
- Resume: reconnect with `since_seq` → server replays from the store then streams live
  (bounded replay window, `replay.max_events`).
- Backpressure: per-socket queue with drop-oldest + a `gaps:[{from,to}]` notice, so the UI can
  show "N events skipped" instead of lying.
- Coalescing: high-frequency types (`llm.request`, `agent.thought`) are batched into 100 ms
  frames per socket.

## 5. Replay

Because events carry `seq`, scope and payload, the UI can:
- scrub a timeline and see the org state at any point (projection rebuilt in the client),
- step through a single agent's run ("how did it get here?"),
- diff two runs of the same project,
- export a run as a self-contained JSON dossier (events + decisions + rewards + artifacts
  manifest) for post-mortems or sharing.

Server-side, `GET /api/projects/{id}/events?from_seq&to_seq&filters` serves the same data for
replay mode (`Rebuilder.replay()` is used in tests to prove the projection is derivable).

## 6. Metrics & alerting

Computed rollups (materialized every N seconds, plus on demand):

| Metric | Scope | Use |
|--------|-------|-----|
| `cost_usd`, `tokens` | agent/dept/project/run | burn-down, budget bars |
| `task_success_rate`, `rework_rate` | agent/dept | quality |
| `escalation_rate` | dept/project | org friction signal |
| `avg_task_latency`, `p95` | dept | performance |
| `tool_error_rate` | tool/agent | flaky tools |
| `verification_confidence` | task/run | trust in results |
| `hire_rate`, `layoff_rate` | project | org stability (thrash detection) |
| `injection_attempts_blocked` | project | security posture |

Thresholds raise `*.warning` events and surface as UI badges; a project-level
`notify.webhook` (optional) can push them to the user.

## 7. Log correlation

Every log line carries `project_id`, `trace_id`, `span_id`, `agent_id`, `task_id`, so
`structlog` output joins cleanly with the event store. Agent-visible errors are sanitized;
the raw exception goes to logs and the audit trail only (never into a model's context).
