# Crew — frontend

The control room for **Crew**, the autonomous agent organization platform. React 19 +
TypeScript + Vite, talking to the Crew backend over the frozen contract in
[`docs/11-api-and-event-contract.md`](../docs/11-api-and-event-contract.md). The UI/UX
behaviour it implements is specified in [`docs/09-ui-ux-spec.md`](../docs/09-ui-ux-spec.md)
(MVP scope).

## Run it

```bash
cd frontend
cp .env.example .env      # VITE_API_BASE=http://127.0.0.1:8787
npm install
npm run dev               # http://localhost:5173
```

The backend must be running (default `http://127.0.0.1:8787`). If it is not, the app does
not pretend otherwise: a **backend unreachable** banner appears and every panel shows its
own honest error state with a retry.

```bash
npm run build      # tsc --noEmit && vite build  → dist/
npm run test       # vitest run
npm run typecheck  # tsc --noEmit
```

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `VITE_API_BASE` | `http://127.0.0.1:8787` | Backend origin; the WS URL is derived from it (`http`→`ws`). |
| `VITE_AUTH_TOKEN` | *(empty)* | Optional bearer token (backend `token` mode). Local single-user mode needs none. |

See [`.env.example`](./.env.example).

## What's in the MVP

**Shell** — a tab strip where **each tab is a project** (`project_id + viewKey`, so one
project can be open twice, e.g. org chart next to an agent timeline). Per-tab internal
route, filters and scroll position survive tab switches and reloads (zustand + localStorage).
Tab dots show live status and a cost counter; badges count unread events and pending
approvals. The header carries the connection indicator, a global budget meter and a
**kill switch** (`POST /api/system/kill`, double-confirm).

**Project workspace** — Overview, Org, Tasks, Agents, Brains, Reward, Events, Settings.

- **Overview** — mission-control cards (tasks done/total, org size, spend vs budget, success
  rate, pending approvals), a live budget-burn chart (recharts) built from real event costs,
  the activity ticker (click a row to jump to that agent/task) and the start-run form
  (`POST /api/projects/{id}/runs` with `{goal, mode}`).
- **Org** — React Flow org chart from `GET /api/projects/{id}/org`. Nodes show
  name/role/grade/state/score/cost/open tasks; overlays for *hide archived*, *show cost*
  (node size by spend) and *hear the org* (pulses on units active in the last 30 s). Click
  opens the unit drawer (detail + promote/demote/fire with a required, audited reason).
- **Tasks** — sortable table from `GET /api/projects/{id}/tasks` with state chips, assignee,
  effort, cost and attempts. A row opens the task drawer: acceptance criteria, required
  skills, verification with evidence, artifacts, reward breakdown and the
  retry/cancel/reassign/escalate controls.
- **Agents** — roster table with score trend sparkline, department/state/risk filters, and a
  drawer containing the live event timeline (thoughts, tool calls, messages), the scorecard,
  the reward ledger (`GET /api/agents/{id}/rewards`), the context inspector and a steering
  box (`POST /api/agents/{id}/message`).
- **Brains** — scope tree with entry counts, entry viewer with provenance/trust/decay, and
  the retrieval-score debug (`POST /api/projects/{id}/brains/search`).
- **Reward** — leaderboard (`/leaderboard`) and the grade-transition log
  (`/reward-transitions`).
- **Events** — a virtualized, filterable firehose fed by the WebSocket: namespace,
  severity, agent and task filters, free text, a JSON payload viewer on row click, JSON
  export, and an explicit **gap notice** when the server reports dropped events. The client
  persists the highest `seq` per project in `localStorage` and reconnects with `since_seq`;
  a dead socket shows a disconnected banner with a *Resume* button.
- **Settings** — budget cap and warning threshold, org limits (max agents/departments, auto-
  hire, layoff idle days), autonomy toggles, egress allowlist editor, model tier mapping and
  the danger zone (pause/resume/archive, audit-chain verify).

**Approval tray** — pending approvals per open project with grant/deny
(`POST /api/approvals/{id}/grant|deny`), always visible, never silently empty: if the
backend is down it says so rather than showing "nothing to approve".

## Architecture

```
src/
  app/         Shell, header, socket provider, query client, hooks
  api/         client.ts (the one typed client) + types.ts (contract types)
  features/    projects/ overview/ org/ tasks/ agents/ brains/ rewards/ events/ approvals/
  components/  ui/ primitives (button, badge, chip, card, drawer, table, sparkline, …)
  lib/         socket.ts (resume + coalesce + backoff), events.ts (reducer), format.ts
  stores/      zustand slices (tabs, event log, connection, ui)
```

- **One typed client.** Every request goes through `src/api/client.ts`; RFC 7807 problems
  become `ApiError` carrying a stable `code` (`budget_exceeded`, `policy_denied`,
  `capability_gap`, `dag_cycle`, … — docs/11 §4). No component calls `fetch`.
- **Events are the only live source.** The socket provider keeps one `CrewSocket` per open
  project, coalesces frames into ~100 ms batches, and pushes them through the pure reducer
  in `src/lib/events.ts` into a normalized store keyed by project. Panels subscribe to the
  slice they need; nothing is polled.
- **No fabricated success paths.** Unknown values render as `—` with a reason; stale and
  disconnected states are labelled; commands report their server error verbatim.

## Tests

```bash
npx vitest run
```

Covers the event reducer (`src/lib/events.test.ts`: dedupe by `seq`, ordering, bounded
window + eviction count, gap notices, frame decoding, filtering) and the money/token
formatters (`src/lib/format.test.ts`: micro-USD ↔ USD, precision rules, `k`/`M`/`B`
compaction, durations, relative time, budget fraction).
