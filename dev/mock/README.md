# dev/mock — run the UI with no backend

A single-file, zero-dependency stand-in for the backend's REST contract. Its purpose is
the one thing that used to require the whole stack, provider keys and spend: **seeing the
office**.

```bash
node dev/mock/server.mjs          # http://127.0.0.1:8788

# and point the UI at it
cd frontend
echo 'VITE_API_BASE=http://127.0.0.1:8788' > .env.local
npm run dev                       # http://localhost:5173
```

## What it does

- Serves the read endpoints the control room needs (org, tasks, events, metrics,
  leaderboard, brains, approvals) in the shapes of `docs/11`.
- **Grows while you watch.** The org is a function of the clock, evaluated per request:
  at t+12 a second engineer joins an existing department, at t+30 a hire into nothing opens
  the Growth department — a new room on the canvas — and t+48/t+64 grow it further. The
  clock starts on the **first request**, not at boot, so the growth begins when you open
  the page rather than before you looked.
- **A council meets.** At t+40 the escalated publish plan calls a council: the meeting
  room appears on the canvas, the panel walks there and gathers around the table, and
  `council.position` events carry what each of them argues. At t+90 the decision lands —
  the room empties, the publish plan leaves `escalated` for `running`, and the approval
  it was waiting on is granted.
- **The office talks.** From the start Iris whispers to Cleo about the publish plan that
  died twice; from t+48 and t+64 Zoe and Nils take the same worry further ("three mouths,
  one worry"), and at t+90 `gossip.surfaced` marks it as a concern the company has to look
  at. Every whisper carries its `basis` — the rumours only say what the story's own events
  already show — and the floor walks the speaker over to the listener with a coffee-coloured
  bubble. The real backend emits the same contract, mined from live state.
- **The executive tier appears.** At t+78 the Market function (Research + Growth) reaches
  two departments and earns its chief: **Nadia (CMO)** joins with the executive avatar,
  and the story marks the chain the backend builds (ADR 0008): orchestrator → chief →
  head → lead → worker.
- **The board exists.** The Board tab is served for `p1` (ADR 0010): an epic decomposed
  into two features and four stories, one story carrying a live running task with a
  helper (`+1 helping`), one in review, one done — and a **high-severity bug** (`w8`)
  filed by Nils, sitting in Ready for the next wave. `GET /api/projects/p1/board`,
  `?department_id=d1` scopes to Research. `POST …/board/items` adds a story or bug,
  `PATCH /api/board/items/:id` moves an *unpromoted* item — a promoted one refuses,
  exactly as the real backend does, because its column follows the task.
- **The company has a board, a C-suite and three projects (ADR 0011).** Northwind
  Pictures: CEO Vera, five function chiefs (Idris/CTO, Camille/CMO, Selma/CPO,
  Marcus/COO, Ruth/CFO), a board of directors (Eleanor Voss chairs, Priya Raman, Tom
  Okafor) — and three member projects: Market Brief (on_track), Arctic Light
  (at_risk), Moonbase (stop, paused). `GET /api/companies/co1/hq` serves the whole
  floor: executive suites, the board room, one pod per project with its teams, and the
  governance activity the HQ scene animates from — a **board session is live** on load
  (`board.convened` 38 s ago), so the directors take their chairs and the CEO walks in
  with the topic in hand. `POST …/allocate` and `POST …/board-session` answer; the HQ
  buttons (Review / Allocate / Convene board) call them.
- **The command desk is live (ADR 0012).** `GET /api/projects/p1/commands` serves a
  transcript to start from (a status question, an assignment to Ada with its chips);
  `POST` runs the same lexicon the backend speaks — mentions resolve against the live
  roster, "herkese … mola" answers with the break line, a bare "@Ada, …" comes back as
  an assignment with `task.created`/`task.assigned` chips. Deterministic: same words in,
  same actions out, no model needed.
- `POST /api/dev/reset` restarts that clock (the temporary reset-clock button on the
  office floor calls it).
- Notices when you have been staring at it: the events it serves are re-timestamped per
  request, because a snapshot taken at boot ages out of the six-second activity windows
  and makes working features look broken.

## What it is not

- Not a backend. No persistence, no auth, no orchestration — every write answers with a
  generic `ack`.
- Not the contract's source of truth. `docs/11` is; when they disagree, this file is wrong
  and should be fixed or deleted rather than trusted.
- Not for production. It exists so that a reader with no API keys can still see what the
  system does, and so the office can be exercised in a browser without spending anything.
