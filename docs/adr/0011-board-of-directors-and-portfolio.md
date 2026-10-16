# ADR 0011: The board of directors, the portfolio call, and the HQ floor

**Status:** accepted · **Related:** docs/01, docs/02, docs/10, docs/11, ADR 0008, ADR 0009, ADR 0010

## Context

The owner asked for a real company: a board of directors above the C-level, several
projects under one company where C-level decides their **alignment, priority and
budgets**, and the whole company visible on one screen, executive offices, the board
room, teams working their projects, hierarchical interaction you can watch. The pieces
before this: functions and C-roles inside a project (ADR 0008), a company project holding
members whose orchestrators report to a CEO (ADR 0009), and a work board per project
(ADR 0010). What was missing: governance above the CEO, money that moves between
projects by decision, and a floor where the company is one screen.

## Decision

1. **The board of directors is real, and it is three seats**: a `chair` (the CEO's
   manager) plus two owners' seats (`board_member`). They are ordinary agents on the
   company project (`projects.settings.chair_id` / `board_ids`), no new table, the same
   schema economy ADR 0009 chose. Seated at company bootstrap; more seats via
   `POST /companies/{id}/board`.
2. **Governance caps are deliberately narrow**: `_BOARD_CAPS` = comms + read + convene +
   bind + request budget. The board never hires into the org it governs, authority
   cannot eat itself. The CEO's `manager_id` points at the chair: the report chain reads
   `chair → CEO → orchestrator → chief? → head → lead → worker`.
3. **A `cfo` joins the C-role family** (fifth function, `finance`): the money chair.
   Function chiefs for technology/market/product/operations keep ADR 0008's automatic
   staffing; the CFO is appointed like the other company-scope chiefs
   (`POST /companies/{id}/chief {function:"finance"}`).
4. **The portfolio call is a decision, not a dashboard.** `company.portfolio()` reads
   each member's books through the SAME verdict helper the review uses
   (`_verdict_of`, the two can never disagree), weights each project by
   `(0.3 + 0.7·success) × verdict-weight`, ranks them, and splits the company's
   remaining headroom. `company.allocate()` **writes the caps**: a `stop` project's cap
   lands exactly on what it has already spent, the decision is "no new money", and the
   ledger says so. One `company.allocation.decided` event carries every line and the
   method that produced it; a decision entry lands in the company brain.
5. **Board sessions run on the council machinery**, one ledger, one decision log.
   `company.board_session(topic)` convenes the chair + members + CEO as the panel with
   fiduciary criteria, and emits `board.convened` (topic + who sat) for the floor to
   animate. Running rounds and deciding use the existing council routes.
6. **The HQ floor** (`GET /companies/{id}/hq`) is the whole company on one screen: the
   executive suites (CEO + the four function chiefs + CFO), the board room and its
   directors, one pod per member project with its teams (departments, heads, counts,
   open tasks, verdict), and the recent governance activity the scene animates from.
   Everything cites the record; nothing is staged that did not happen.
7. **The user assigns work like a PM**: any of epic/feature/story/**task**/bug can be
   created on a project's board (now including `task` as a promotable kind), placed under
   a parent, scoped to a team, and moved to Ready, the next wave's board pass promotes
   it to a real task and the ordinary machinery assigns the team that owns it.

## Consequences

- Money between projects is now a decision with a paper trail (event + brain + caps),
  not a side effect of creation order; a stop verdict is enforceable.
- The board adds 3 agents per company at bootstrap, trivial spend, but tests that
  counted a company's roster had to learn the new truth (they did, in the same commit).
- The HQ scene reads one endpoint; a company without members, board or activity still
  renders (empty seats, honest labels).
- The review/portfolio share one verdict helper: verdict drift between the two was
  designed out, not tested out.

## Alternatives considered

- **A separate `board_members` table**: storage that would immediately need weight,
  tenure, committee columns, and a second place to ask "who is on the board". Agents
  already carry state, score, manager and events; the board is a role, not a schema,
  rejected.
- **Board members as non-agents (user-only reviewers)**: the point is a company that
  runs itself and can be *watched*; seats that cannot sit in a council room or walk the
  floor are scenery, rejected.
- **Hand-set project budgets only**: leaves alignment/priority/budgeting to whoever
  created the projects first; the owner asked for C-level decisions, rejected.
