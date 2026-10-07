# 16 · System review — production readiness

Reviewed 2026-10-07. Scope: the whole repository — frontend, backend, tooling, docs, and
the office's live behaviour. Every finding carries the evidence that found it. This is the
punch list: fixes land as commits and are struck out here with their hash.

## How this review was done

- Inventoried the repo: 17 specs (00–15 + adr), 97 frontend files (~17k lines), 28 backend
  modules with a test package, plus the separate spriteforge atlas repo.
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

## Office findings still open (docs/15 plus this review)

- O1 The arrival walk of a newly hired agent has not been measured to their own desk yet.
  The handle is known now: the character's own transform plus its `data-depth` (a world
  coordinate — an existing character read 2216.5), NOT the static `sprite-body` wrapper
  that an earlier probe kept reading. Two attempts still missed the transition: a fresh
  page load seats everyone at once without walking (correct: `rosterReady` gate), and a
  `POST /api/dev/reset` issued while the page was open did not reach the page inside the
  sampling window (the org is re-read on a 10s interval). Next method, written down so it
  is not re-derived: reset while the page is open, then poll for the id to *vanish* for
  thirty seconds or more, and start tracing the moment it reappears.
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
