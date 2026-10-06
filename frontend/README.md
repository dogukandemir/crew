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

**Project workspace** — Office, Overview, Org, Tasks, Agents, Brains, Reward, Events, Settings.

- **Office** (the default tab) — the organization as an office building seen isometrically. Departments
  are real rooms with partition walls, hanging signs and a floor in their own accent colour; agents are
  **cute SVG characters** with chibi proportions, generated from their agent id (build, skin tone, hair,
  dress code, accessories) so the same person always looks the same — and the *same* person the 3D
  office draws, since both renderers read one identity and one pose table. Verticals stay vertical, so
  people **stand up** and the furniture has real height: desks, monitors, chairs, plants, a coffee bar,
  lamps and whiteboards are all drawn as volumes with a lit top face and shaded sides. They **walk the
  corridors between departments** rather than teleporting, and work: typing, tool calls, thinking,
  blocked, celebrating. Movement is a projection of real state — escalation walks to the orchestrator,
  verification walks to the shared review table, a task owned by another department walks you across the
  floor to it, a long idle spell wanders to the coffee corner, and a new hire walks in from the entrance.
- **Talking is visible.** A character with something to say shows a **speech bubble carrying the real
  words from the event**, and its colour says what kind of exchange it is: work conversation is white,
  **water-cooler gossip is amber** (a message between colleagues who are not working on anything), a
  report to a manager is green with an `↑`, a directive coming down is violet with a `↓`, a hand-off is
  blue with a `→`, and an escalation is red. The walk goes with it: report to your manager and you
  actually walk to their desk, ask a colleague and you walk over and turn to face them, and when a task
  is assigned to a squad the juniors gather at the senior's desk until it ends. A dashed route appears on
  the floor while somebody is working in another department.
- **Each department reports what it is doing.** Its board carries the department name and mission, a
  pulsing **producing** marker when someone in it is mid-output, a **shipped** count with the newest
  deliverable by name (`✓ 2 shipped · Market scan`), seat/working/stuck counts, and a **new** flag when
  the org has just opened that department. The toolbar totals the floor: seats, working, thinking,
  shipped, and who needs you.
- Zoom, pan, click a character for their live thinking stream, output and scorecard. A **3D office**
  button switches to the WebGL view of the same cast.
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
  app/         Shell, header, socket provider, query client, hooks, useSceneFrame
  api/         client.ts (the one typed client) + types.ts (contract types)
  sim/         the simulation: pure, framework-free, unit-tested (see below)
  features/    office3d/ office/ projects/ overview/ org/ tasks/ agents/ brains/ rewards/ events/ approvals/
  components/  ui/ primitives (button, badge, chip, card, drawer, table, sparkline, …)
  lib/         socket.ts (resume + coalesce + backoff), events.ts (reducer), format.ts
  stores/      zustand slices (tabs, event log, connection, ui)
```

`src/sim/` holds the simulation and imports neither React nor three.js, so the same code can run in
a browser tab today and in a cloud scene worker later. It is pure and unit-tested:

```
floorplan.ts  org tree  → rooms, desks, doors, corridor network   (+ test)
paths.ts      rooms     → corridor routes between them            (+ test)
walkers.ts    a route   → position, facing, "still walking?"      (+ test)
targets.ts    domain    → where each agent should be standing     (+ test)
activity.ts   events    → the pose and sentence for each agent    (+ test)
scene.ts      everything→ one serialisable frame (SceneState)     (+ test)
geometry.ts   the floor plane helpers
```

Two renderers consume that frame, and neither owns simulation state:

- `features/office3d/` — the WebGL office: `characters.ts` (deterministic procedural people),
  `assets.ts` (shared geometry + a material cache), `poses.ts` (the pose table and the walk cycle,
  pure and tested), `Character.tsx` (the rig), `scenery.tsx` (procedural textures, rooms, desks),
  `Office3D.tsx` (camera, lights, HUD) and `OfficeTab.tsx` (WebGL probe + renderer switch).
- `features/office/` — the 2D floor plan: `camera.ts`, `viewport.ts`, `OfficeFloor.tsx` and friends.

The design, the wire plan for the hosted version and the known limits are in
[`docs/14-realtime-office-renderer.md`](../docs/14-realtime-office-renderer.md).

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

The simulation carries the bulk of it — activities, targets, corridor routing, walkers, the floor
plan, the scene projection, character generation and the pose table — because that is where the
interesting behaviour lives and where a bug is invisible until it is on screen. The three.js layer
is deliberately thin and is verified by driving the real app in a browser.
