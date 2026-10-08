# dev/mock — run the UI with no backend

A single-file, zero-dependency stand-in for the backend's REST contract, staged as a
scenario rather than a fixture: **Northwind Labs**, a software company whose flagship
launch you can watch ship while you read.

```bash
node dev/mock/server.mjs          # http://127.0.0.1:8788

# and point the UI at it
cd frontend
echo 'VITE_API_BASE=http://127.0.0.1:8788' > .env.local
npm run dev                       # http://localhost:5173
```

## The scenario

**Atlas 2.0**, a customer data platform's public launch — new SDKs, a zero-downtime
migration, and a date that has to hold without breaking anyone already in production.

- **The company.** Northwind Labs: CEO **Katherine Brooks**, five function chiefs
  (Arjun Mehta/CTO, Margot Lefèvre/CMO, Selin Yıldız/CPO, Oliver Ashworth/COO, Grace
  Kim/CFO) and a board of directors (Rebecca Sterling chairs, Rajiv Menon, Henri
  Delacroix). Three products in different health: Atlas (**on track**), **Nimbus** —
  mobile app (**at risk**), **Forge** — design system (**stopped** by the board).
- **The disciplines are the classic trio** — Product, Development, Design — with the
  cast of a real American company, not five guys named Dave: Turkish, Indian, French,
  Italian, English, Korean, Japanese and Latino names around an American core
  (Anika Rao, Elena Rossi, Zeynep Arslan, Ravi Iyer, Giulia Romano, Deniz Kaya, …).
- **The org grows while you watch.** The org is a function of the clock, evaluated per
  request: t+12 software engineer **Karan Shah** joins Development (an existing room
  gains a desk), t+30 a hire into nothing opens **Platform** (a new room on the
  canvas), t+48/t+64 Platform grows, and t+78 engineering manager **Miguel Torres**
  joins Development. The clock starts on the **first request**, not at boot, so the
  growth begins when you open the page rather than before you looked.
- **A council meets.** At t+40 the escalated **zero-downtime migration** — the
  dual-run infrastructure is above the development envelope — calls a council: the
  meeting room appears, the panel (Alex, Anika, Deniz, Ravi, Zeynep) argues *ship now
  on the current pipeline vs slip two weeks for the migration*, and at t+90 the
  decision lands: the room empties, the migration leaves `escalated` for `running`,
  the blocked board card moves, and the production-deploy approval is granted.
- **Agents grow (ADR 0014).** Every agent carries `company_knowledge` (earned by
  verified work — 0.05 at hire, plus 0.02 × effort per verified task) and `tenure_days`;
  the tape shows both the numbers and the event — `agent.grew: Elena Rossi grew:
  ci-cd 0.85 → 0.87 · company knowledge 0.73 → 0.78`. Ravi sits on **probation**
  because the webhook race slipped past twice, and the same story is the board's
  high-severity bug. Leaderboard trends, promotions, brain entries and reward events
  all hang off the same narrative.
- **The office talks.** Giulia whispers to Elena about the migration that keeps
  failing verification; from t+48 and t+64 Zeynep and Ivy take the worry further
  ("three mouths, one worry"), and at t+90 `gossip.surfaced` marks it as a concern.
  Every whisper carries its `basis`; the floor walks the speaker to the listener.
- **The command desk is live (ADR 0012).** A transcript to start from — a status
  question, an assignment to Anika, an idea floated in Turkish that is exactly the
  council's own question — and the same lexicon the backend speaks: mentions resolve
  against the live roster, "herkese … mola" answers with the break line, a bare
  "@Elena, …" comes back as an assignment with `task.created`/`task.assigned` chips.
- **The board is the run's paper trail (ADR 0010).** Epic → workstreams → stories:
  live tasks with helpers (`+1 helping`), a review card, done work, a blocked card
  that unsticks when the council decides — because the column is derived from the
  task. `?department_id=d2` scopes to Development; `POST …/board/items` adds a card;
  `PATCH /api/board/items/:id` moves an *unpromoted* item only.
- **The company floor (ADR 0011) is served whole.** `GET /api/companies/co1/hq`:
  C-suite suites, the board room, one pod per product with its teams, and the
  governance activity the HQ scene animates — a **board session is live** on load
  ("launch readiness review"). The HQ buttons (Review / Allocate / Convene board)
  hit real routes, and each product chip opens that project's tab — the switcher,
  the company card and the ⇄ menu in the project header all use the same tab store.
- `POST /api/dev/reset` restarts the growth clock (the reset button on the office
  floor calls it). The events are re-timestamped per request: a snapshot taken at boot
  ages out of the seconds-long activity windows and makes working features look broken.

## What it is not

- Not a backend. No persistence, no auth, no orchestration — every unmatched write
  answers with a generic `ack`.
- Not the contract's source of truth. `docs/11` is; when they disagree, this file is
  wrong and should be fixed or deleted rather than trusted.
- Not for production. It exists so that a reader with no API keys can still see what
  the system does, and so the office can be exercised in a browser without spending
  anything.
