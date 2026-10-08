# 09 — UI/UX Spec

Frontend: React 19 + TypeScript + Vite, TanStack Query (server state), Zustand (UI state),
Tailwind + Radix primitives (shadcn-style), React Flow (org chart, DAG), Recharts (metrics).

## 1. Shell & navigation

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Crew            [＋ New project]                     ● connected   ⏸ Kill all │
├───────────────────────────────────────────────────────────────────────────────┤
│ ‹ tab ›  Market-brief │ tab ›  Research-agent-bench │ tab › +     │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│                         PROJECT WORKSPACE (per tab)                           │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

- **Tabs = projects.** Each tab keeps its own route, filter state, scroll position and socket
  subscription. Closing a tab does not stop the project (runs continue server-side); a tab
  badge shows unread events / pending approvals.
- Tab strip shows a live status dot per project (running / paused / needs-attention / done)
  and a cost counter.
- A project can be opened in **two tabs** (e.g. org chart + agent timeline side by side) —
  identities are `project_id + viewKey`.
- Global header: connection state, global kill switch (double-confirm), global budget meter.

## 2. Project workspace layout

```
┌ Project header ───────────────────────────────────────────────────────────────┐
│ Name │ Goal (editable) │ Stage: EXECUTING ▸ │ ▓▓▓▓▓░░ budget $3.80/$10 │ ⋯    │
├ Tabs inside the project ─────────────────────────────────────────────────────┤
│ Overview │ Org │ Tasks │ Agents │ Council │ Brains │ Rewards │ Events │ Settings│
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Overview
- Goal brief (interpretation, assumptions — with a "correct this" affordance).
- Live stage stepper (INTAKE → PLANNING → …), with the elapsed time per stage.
- Mission control cards: tasks done/total, org size, spend, success rate, open escalations,
  pending approvals, decisions taken.
- Activity ticker (last 50 events, humanized, clickable → jumps to the unit).
- Run report when complete (deliverables, verification summary, what it learned, cost).

### 2.2 Org (org chart)
- React Flow tree, node = unit. Node shows: name, role badge, grade, score chip, state dot,
  cost, open tasks. Departments collapse; squads are groups; archived units hidden by default.
- Click → side drawer with full unit detail + jump to its own view.
- Edges show reporting lines; hovering shows the last interaction (delegation/escalation).
- Overlay toggles: "hear the org" (activity pulses), "show cost" (node size by spend),
  "show health" (color by failure rate).
- Controls: hire (manual), fire, promote/demote (audited), open a department, convene council.

### 2.3 Tasks
- Two modes: **DAG** (React Flow, deps as edges, critical path highlighted, node state colors)
  and **table** (sortable: state, assignee, effort, cost, retries, verification).
- Task detail: description, acceptance criteria, required skills with coverage, assignee(s),
  inputs, output contract, artifacts, verification result with evidence, reward breakdown.
- Bulk: retry, reassign, cancel, escalate manually.

### 2.4 Agents
- Table + filters (department, grade, state, score range, skill). Columns: name, role, grade,
  score+trend, state, current task, cost today, success rate, skills count.
- Leaderboard / "most improved" / "at risk" views.
- Agent detail drawer = §3.3 of docs/07 (timeline, context inspector, scorecard, controls).

### 2.5 Council
- List of sessions with question, status, panel, rounds, outcome.
- Session view: the question card, options as columns, each member's position (claim,
  reasoning, evidence, risks, confidence) side by side, round-2 critiques threaded under the
  position they attack, and the Decision Record at the bottom with rationale + preserved
  dissent + confidence + reversibility.
- Controls: convene (with question + options), invite/remove panelist, extend a round, ask the
  decider to explain, override (Orchestrator/user, reason required).

### 2.6 Brains
- Tree by scope (project / departments / agents) with entry counts and last activity.
- Entry viewer: body, provenance (run/task/agent/url), trust badge, importance, usage, decay.
- Promotion feed ("Research promoted 'rate-limit playbook' to the project brain"),
  supersession history, and a search box that shows the retrieval score breakdown — the same
  numbers the agents get.
- Actions: edit (marks entry `human_edited`), supersede, archive, export.

### 2.7 Rewards
- Leaderboard with score/grade/cost/success; click → reward ledger (every event with its
  components and the task it came from).
- Grade-transition log (promotions, probations, demotions, layoffs) with the rule that fired.
- Weight editor (`reward.weights`) with a live "what-if" preview on recent events.
- Anti-gaming panel: integrity violations, unverified claims, duplicated work, verifier
  accuracy.

### 2.8 Events (the firehose)
- Virtualized, filterable (scope, type namespace, severity, agent, task, time range), with
  saved filters. Row → JSON payload + trace link.
- **Replay mode**: a time scrubber; the whole workspace re-renders at that moment; play/pause
  at 1×/2×/10×/"as fast as possible".
- Export selection as JSON.

### 2.9 Settings
- Budget: project cap, per-department envelopes, warning thresholds, kill switch.
- Autonomy: `goal.require_confirmation`, `verification.require_human`,
  `autonomous` vs `interactive` intake, approval rules and thresholds.
- Org limits: max agents, max departments, max senior ratio, auto-hire on/off, layoff policy.
- Reward weights, retention, egress allowlist editor (with a "what the org tried to reach"
  log), tool policy per capability, model tier → provider/model mapping (with a test button).
- Danger zone: pause, archive, forget (typed confirmation), audit verify, backup/restore.

## 3. Interaction & feel

- **Streaming first**: skeletons never block; panels fill as events arrive.
- **Never lie**: unknown = "—", stale = a "stale" chip with the reason, disconnected = a banner
  plus a resume action (`since_seq`).
- **One-click depth**: any name anywhere is a link to that unit's view; any cost is a link to
  the ledger; any claim is a link to its evidence.
- Keyboard: `⌘K` command palette (jump to unit, run command, convene council), `T` task DAG,
  `O` org, `Space` pause/play in replay.
- Accessibility: full keyboard traversal in the DAG/org views (React Flow a11y), contrast-checked
  palette, reduced-motion honored (pulses become static badges).
- Approvals and escalations show as a persistent notification tray — they are the two things
  that need *you*.

## 4. Frontend architecture

```
frontend/src/
  app/            routing, tab store, providers, socket provider
  api/            typed client generated from OpenAPI + hand-written event types
  features/
    projects/     tab strip, project header, settings
    overview/     mission control
    org/          org chart, unit drawer, hire/fire dialogs
    tasks/        DAG + table + detail
    agents/       table, detail drawer, timeline, context inspector, scorecard
    council/      session list + debate view + decision record
    brains/       scope tree, entry viewer, promotion feed
    rewards/      leaderboard, ledger, transitions, weights editor
    events/       firehose, filters, replay controller
  components/     ui primitives (button, badge, chip, drawer, table, sparkline)
  lib/            socket client (resume, coalesce), formatters (money, tokens, time), a11y
  stores/         zustand slices (tabs, filters, replay, notifications)
```

- Events are the only live source: the socket provider pushes into a normalized cache keyed by
  scope; components subscribe to slices (no prop-drilling, no refetch storms).
- Optimistic UI only for user commands (pause, approve, rename) — never for agent state.
- Every panel has an empty state that teaches (e.g. Tasks empty → "Ask the Orchestrator to
  plan" with a one-click action).

## 5. MVP vs. later

- **MVP (M9-lite)**: shell + tabs, Overview, Org (chart + drawer), Tasks (table), Agents
  (table + drawer with timeline), Brains (list), Rewards (leaderboard), Events (filterable,
  live), Settings (budget + limits). Approval tray. Live via WS.
- **Later**: replay scrubber, council debate view polish, DAG mode, cost/size overlays,
  what-if reward weights, command palette, run diffing, export dossiers.
