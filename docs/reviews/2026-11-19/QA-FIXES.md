# QA fixes — 19 November 2026

Source: end-user pass on a clean token-mode Compose installation (Chromium
1280×900 and 390×844, Lighthouse, API probes). Every item below is a finding
from that pass; the checkbox is closed only when the fix is in the tree and the
verification step has passed.

## P0 — goal confirmation is a dead end

- [x] Frontend shows the pending brief and an approve/stop control when a run is
      `pending_confirmation` or `pending_clarification`.
- [x] Approving calls the existing `answerRun` path and the run proceeds.
- [x] Backend records the confirmation so `_intake` does not re-request it.
- [x] Rejecting/stopping leaves the run aborted and the record intact.
- [x] Backend regression test for the confirm → continue → no second prompt path.
- [x] Frontend test for the pending gate card.

## P1 — mobile office is not usable

- [x] At 390 px the office selects (`Inspect an agent`, `Focus a room`, character
      size) are reachable, not clipped.
- [x] Status bar, tabs and the bottom hint do not overlap the approvals bar.
- [x] Office remains legible or explicitly scrollable at phone width.
- [x] Browser re-test at 390×844, including DOM overflow measurement.

## P1 — accessibility

- [x] `StatusDot` no longer puts `aria-label` on a role-less span.
- [x] Project tablist contains only `role="tab"` children; the new-project
      control moves outside it.
- [x] Contrast failures flagged by Lighthouse are fixed.
- [x] Home control's accessible name matches its visible text.
- [x] Lighthouse accessibility ≥ 95 on desktop and mobile.

## P2 — SEO

- [x] `frontend/index.html` has a meta description.
- [x] `frontend/public/robots.txt` is valid and served as `text/plain`, not the
      SPA fallback.
- [x] Lighthouse SEO ≥ 95.

## P2 — demo plan does not reflect the goal

- [x] The UI says the offline Demo uses a fixed simulated plan, so a repeat run
      with a new goal is not mistaken for goal-specific planning.

## P3 — consistency and small accessibility gaps

- [x] Pending-confirmation runs are counted in the "needs you"/pending metric.
- [x] Tab status and run status do not contradict each other while a run is
      starting.
- [x] Settings number inputs expose a sensible `max`, not `valuemax=0`.
- [x] Security-header expectations (CSP/HSTS at the TLS proxy) are documented.

## Verification record

- Backend: `ruff check .` clean; **435 passed, 1 skipped, 1 deselected**.
- Frontend: `tsc --noEmit` clean; **362 tests across 54 files**; production build
  clean.
- Browser: first-run, standalone project, goal-confirmation gate, approve,
  kill-all, token login/logout, and full-stack restart persistence all exercised
  on the built images.
- Goal confirmation: exactly one `run.confirmation.requested`, one
  `run.confirmation.answered`, and one `run.completed`; the run ended
  `completed/DONE`.
- Mobile 390×844: `.office-selects` and `.office-statusbar` measure 378 px inside
  a 390 px viewport; only the pannable SVG floor extends beyond the viewport.
- Lighthouse (snapshot, desktop and mobile): Accessibility **100**, Best
  Practices **100**, SEO **100**.
- `robots.txt` is served as `text/plain`; the meta description is present in the
  built shell.
- CI: the full gate (frontend, backend, Compose, CodeQL, dependency security,
  secret scanning) runs on the pushed commit; its Actions run is the record.

## Separate workstream — one-click deploy

- [x] Provider research (separate agent; Cloudflare was one example among many).
- [ ] User selects the providers to support.
- [ ] Implementation in a separate agent session, after selection.
