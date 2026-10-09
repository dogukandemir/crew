# 16 · System review — production readiness

Reviewed 2026-10-07. Scope: the whole repository — frontend, backend, tooling, docs, and
the office's live behaviour. Every finding carries the evidence that found it. This is the
punch list: fixes land as commits and are struck out here with their hash.

## How this review was done

- Inventoried the repo: 17 specs (00–15 + adr), 97 frontend files (~17k lines), 28 backend
  modules with a test package, plus the in-house atlas generator that produces the sprite art.
- Ran both test suites; ran the app against the dev mock in a real browser and measured the
  live DOM rather than reading the code and hoping.
- Scanned for the operational gaps a stranger hits first: CI, deploy, error handling,
  secrets, self-host instructions, first-run experience.

## P1 · Backend suite — GREEN, and a reporting trap

**Not a defect.** `pytest` runs 54 tests green (exit 0). The confusion was mine: the
project sets `addopts = "-q"`, and adding another `-q` on the command line makes pytest
print the dots and *no summary line at all*, so a grep for "passed" found nothing and the
suite looked broken. Worth knowing: run `pytest` without the extra `-q`, or read the exit
code, which is the signal that cannot lie.

## P2 · No CI — HIGH

No `.github/`. Both suites are hand-run on one machine, so nothing stops a regression from
being merged and nothing proves the suites are green to anyone else.

Action: one workflow, two jobs — frontend (tsc, vitest, build) and backend (pytest).

## P3 · No error boundary in the frontend — HIGH

No `ErrorBoundary` anywhere. Any render error blanks the entire app to white, including
the toolbar you would need to get out of it.

Action: a boundary around the app shell with a recoverable error state.

## P4 · Nobody else can run it — CLOSED, and partly my own misreading

The first scan was wrong about the missing pieces: `.env.example`, `frontend/.env.example`
and a README quick start **already existed**, including a zero-key path
(`CREW_OFFLINE_LLM=true`, the deterministic fake runner). What was genuinely missing:

- **No compose, no Dockerfile of any kind.** Added: `docker-compose.yml` plus small
  backend and frontend images. `docker compose up` boots the pair with the offline runner
  by default, so it needs no keys at all, and `.env` or the environment overrides it.
- **The API mock lived outside the repository**, on one machine, so the one thing a
  stranger could not do was look at the office without the whole stack. It is now
  `dev/mock/server.mjs` (264 lines, zero dependencies) with `dev/mock/README.md` saying
  exactly what it does and does not promise, and a README section showing the two commands.
- `docker compose --profile mock up mock` runs the mock the same way.

## P5 · First run without keys — CLOSED

The zero-key path existed (the README's `CREW_OFFLINE_LLM=true`) but nothing on the screen
said so, so an empty office looked like a broken app. The office's empty state now names
the setting: set a provider key, or run the backend with `CREW_OFFLINE_LLM=true` for the
same pipeline against the deterministic fake runner — and the mock in `dev/mock/` needs no
backend at all.

## FIXED · The desk screens lied about who was working

Reported: on some computers the machine looked busy with nobody at it, and at
others it looked idle under somebody who was working. One cause, two directions:
the screen was lit from `activity` — `typing`/`tool` — which says what a person is
doing, never where they are. A researcher with a live task works at the lab bench,
the junior of a squad pair works at the senior's desk, somebody on another
department's task stands in that department; in all three the desk at home burned
with an empty chair, and where the person actually was had no screen at all.

How it was found, because the method is the point: the desk sprite's two states
(`prop.desk` vs `prop.desk.busy`) were told apart in the live DOM by decoding the
clip rect and the image offset back into an atlas cell origin, and each desk was
then compared against the person nearest it. Live proof of the bug: Max, given a
task whose title is research vocabulary, walked to the lab bench and typed there —
his home desk was lit and empty the whole time.

The fix is `deskInUse` (sim/targets.ts): the screen is on only when its owner is
seated at its own desk, working — and not mid-walk (the target says "seated" the
moment somebody is on their way, and after the floor re-grids that walk can be
long). Desks also now carry `data-desk`/`data-busy`, so the next report of this
kind can be measured instead of guessed at.

Verified live, 100 seconds spanning a clock reset and every beat (hire, new
department, two more hires, all the re-grids that follow): Max at the bench in
35/35 samples with his own screen lit 0 times; busy screens observed 36 times
(the run is not vacuous); zero lit-and-abandoned desks. The only two mismatch
samples were single 2-second frames where somebody had just sat down and the
desk had not re-rendered yet.

Tests: `src/sim/desk-screen.test.ts`. 213 frontend tests.

## The meeting room, and the log that never updated

Two features' worth of finding, one of them not a feature at all.

- **A council now has a room.** `sim/meeting.ts` reads the sitting off the event log
  (`council.convened` opens it, members are whoever emitted `council.position`, a
  `decision.recorded` after it closes it); `buildOffice` opens a meeting room on demand
  and keeps it thereafter; `meetingLayout` places the table and its eight chairs for
  both the renderer and the simulation, so a chair and its sitter cannot drift apart.
  Verified live: the room appeared at t+40, the panel walked across the floor, sat down
  and talked; after the decision they dispersed and the publish plan left `escalated`.
- **The event log was frozen at page-open.** `SocketProvider` backfills history once and
  then relies on a socket — and the dev mock has no socket, so the office's whole
  activity layer, the meeting room included, never saw anything that happened after the
  page loaded. A ten-second poll of the latest page now stands in where the socket is
  silent (the ingest dedupes, so it is a no-op when the socket delivers).
- **The mock was re-numbering its own events.** Dropping the council's positions after
  the decision shifted every id after them; the log's id-based dedupe then read the
  decision as a duplicate and silently discarded it. Events now age instead of
  disappearing, and the approval/escalation events age with the decision that resolved
  them.

## Office findings still open (docs/15 plus this review)

- O1 The arrival walk: the ARRIVAL is proven, and the walk MECHANISM is real — a
  position traced changing over ~30 s on the desk→bench route, written per frame by a
  live tick. Re-verified today: a hired agent vanished at t+7.5 and reappeared at t+27.5
  with a real transform and a real depth (2311.18). What is still not frame-traced is one
  specific sequence — entrance → a brand-new desk — and that is the same machinery on a
  different route, not a different machinery.
- O9 RESOLVED as a measurement artifact. `data-depth` appeared frozen at 0 for a live
  arrival, and "frozen" was true — of the measuring tab, not the product: that page was
  running a stale module graph, with a dead walker loop (nothing moved, no trails, no
  depths). In a healthy instance the same agent's depth at reappearance reads 2311.18.
  The distinction now takes one look, because the tick keeps a dev probe —
  `window.__office` with ticks/walkers/sprites — which separates "dead rAF", "empty
  walker map" and "empty sprite map", three states that look identical from outside.
  Ops note for the same reason: when the dev server's watcher misses a change, a hard
  reload is what settles it; several "defects" this session were one.
- O2 `.is-new` room animation still unverified, for a related reason: the marker is
  transient and by the time it was inspected it had expired (`class=""`, `animation-name:
  none`). It has to be observed in the same breath as the arrival.
- O3 A department whose roster is entirely archived keeps its room standing.
- O4 The `belt` category is drawn as a rail, not a sprite (may be by design; undecided).
- O5 Dead `@keyframes speech-pop` left in office2d.css.
- O6 The side-view character cells carry hair across the face — a documented trap.
- O7 The wall clock sprite exists in the atlas and nothing places it.
- O8 Three sprites seen once outside the building, never reproduced.

## Fixed while doing this review

- **Ctrl+wheel zoomed the browser page instead of the floor.** The wheel guard compared
  against a frame captured at mount, which was still null; every wheel was rejected and the
  browser took the gesture. Found by making the handler report itself
  (`window.__officeWheel`), not by another guess. `c818e64`
- **Bubbles flickered.** A keyframe pop replayed whenever the depth layer re-appended a
  person, and re-inserting an element restarts its descendants' animations. Measured:
  computed opacity hit 0 on every character; a re-append produced a new animation object at
  currentTime 0. Now a content-driven transition that cannot snap back to invisible.
  `f466957`
- **Tags and bubbles blinked at the far-zoom threshold.** Hysteresis instead of a single
  cut-off. `5abefe6`
- **The lab bench was stretched, not tiled.** `scaleForWidth` scales both axes, so a 2 m
  bench asked to span 4 m was drawn 1.7 m tall — the pale slab on the floor. `c57a450`

## Confirmed good, so the list is not a rumour

- `frontend/src/api/client.ts` has real error handling: typed `ApiError`, network status 0,
  problem+json codes, retry classification.
- Backend settings are a single validated object with auth modes, vault key, provider keys,
  budget caps, sandbox and egress controls — not scattered `os.environ` reads.
- No `TODO`/`FIXME`/`HACK` markers anywhere in either source tree.
- Frontend: 206 tests, tsc clean, build clean.
