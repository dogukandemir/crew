# dev/mock — run the UI with no backend

A single-file, zero-dependency stand-in for the backend's REST contract, staged as a
scenario rather than a fixture: **Northwind Pictures**, an independent film studio whose
flagship production you can watch work while you read.

```bash
node dev/mock/server.mjs          # http://127.0.0.1:8788

# and point the UI at it
cd frontend
echo 'VITE_API_BASE=http://127.0.0.1:8788' > .env.local
npm run dev                       # http://localhost:5173
```

## The scenario

**Arctic Light**, a feature documentary on the Tromsø aurora observatory — fifty hours of
16mm reels, three years of interviews, one winter festival circuit. Real names, real
jobs, real work:

- **The studio.** Northwind Pictures: CEO **Vera Lindqvist**, five function chiefs
  (Idris Farah/CTO, Camille Laurent/CMO, Selma Aydın/Chief Production Officer, Marcus
  Whitfield/COO, Ruth Almeida/CFO) and a board of directors (Eleanor Voss chairs, Priya
  Raman, Tom Okafor). Three productions in different health: Arctic Light (**on track**),
  **Moonbase** — kids series S2 (**at risk**), **Harbor House** — limited series
  (**stopped** by the board).
- **The org grows while you watch.** The org is a function of the clock, evaluated per
  request: t+12 assistant editor **Max Bergström** joins Post-Production (an existing
  room gains a desk), t+30 a hire into nothing opens **Festivals & Press** (a new room
  on the canvas), t+48/t+64 grow it further, and t+78 post supervisor **Maria Solberg**
  joins the busiest room. The clock starts on the **first request**, not at boot, so the
  growth begins when you open the page rather than before you looked.
- **A council meets.** At t+40 the escalated **festival submission package** — the mix
  and DCP render are above the post envelope — calls a council: the meeting room appears,
  the panel (Alex, Ada, Bo, Dev, Zoe) walks there and argues *submit the 52' cut now vs
  extend to 58' for the Berlinale window*. At t+90 the decision lands: the room empties,
  the package leaves `escalated` for `running`, the blocked board card moves, and the
  approval it was waiting on (upload to `submissions.sundance.org`) is granted.
- **The office talks.** From the start Iris whispers to Cleo about the festival package
  that failed QC twice; from t+48 and t+64 Zoe and Nils take the same worry further
  ("three mouths, one worry"), and at t+90 `gossip.surfaced` marks it as a concern. Every
  whisper carries its `basis` — the rumours only say what the story's own events already
  show — and the floor walks the speaker to the listener with a coffee-coloured bubble.
- **The history is real too.** Tasks carry day-scale completed work (licences cleared,
  16mm ingested, screening notes from the Doc Lab), runs include a finished assembly
  cycle with lessons, the QC agent sits on **probation** because the reel-3 drift slipped
  past twice — and the board's high-severity bug (audio drift, 24→25 fps) is the same
  story from the back. Leaderboard trends, promotions, brain entries and reward events
  all hang off the same narrative.
- **The command desk is live (ADR 0012).** A transcript to start from — a status
  question, an assignment to Ada, an idea floated in Turkish — and the same lexicon the
  backend speaks: mentions resolve against the live roster, "herkese … mola" answers
  with the break line, a bare "@Cleo, …" comes back as an assignment with
  `task.created`/`task.assigned` chips. Deterministic: same words in, same actions out,
  no model needed.
- **The board is the run's paper trail (ADR 0010).** Epic → workstreams → stories: live
  tasks with helpers (`+1 helping`), a review card, done work, a blocked card that
  unsticks when the council decides — because the column is derived from the task.
  `?department_id=d2` scopes to Post-Production; `POST …/board/items` adds a card;
  `PATCH /api/board/items/:id` moves an *unpromoted* item only.
- **The company floor (ADR 0011) is served whole.** `GET /api/companies/co1/hq`:
  C-suite suites, the board room, one pod per production with its teams, and the
  governance activity the HQ scene animates — a **board session is live** on load
  ("winter slate review"), so the directors take their chairs. The HQ buttons
  (Review / Allocate / Convene board) hit real routes.
- `POST /api/dev/reset` restarts the growth clock (the reset button on the office floor
  calls it). The events are re-timestamped per request: a snapshot taken at boot ages out
  of the seconds-long activity windows and makes working features look broken.

## What it is not

- Not a backend. No persistence, no auth, no orchestration — every unmatched write answers
  with a generic `ack`.
- Not the contract's source of truth. `docs/11` is; when they disagree, this file is wrong
  and should be fixed or deleted rather than trusted.
- Not for production. It exists so that a reader with no API keys can still see what the
  system does, and so the office can be exercised in a browser without spending anything.
