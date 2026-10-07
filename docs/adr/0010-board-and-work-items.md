# ADR 0010 — The board: work items above tasks, and joint work that finishes together

**Status:** accepted · **Related:** docs/03, docs/10, docs/11, docs/17, ADR 0007

## Context

The owner asked for the company to come with a real project-management spine: a backlog
system with kanban/scrum boards the teams own; epic → feature → user story → task
decomposition tied to the selected goal; agents that pick the work up; a colleague who
asks for help getting joined so the work *finishes together*; and agents who find a bug
in the system filing it on the board so the right team fixes it. Everything on one
execution engine that must not be lied to.

## Decision

1. **Planning ≠ execution.** `work_items` (kind: epic | feature | story | bug) is the
   planning record; `tasks` stays the only thing an agent can run. The separation is the
   point: a board full of epics cannot be dispatched, and a task table cannot tell a
   story.
2. **The board cannot disagree with the engine.** Once an item is promoted, its column is
   DERIVED from the task's state on read (`TASK_STATE_TO_COLUMN`), the same way the office
   draws its metre from the atom — one source, no second truth.
3. **The planner writes the hierarchy.** Every run's plan becomes: one **epic** (the goal),
   a **feature** per capability category, and a **story 1:1 with each planned task**,
   linked by `task_id` from birth — linked stories are never re-promoted.
4. **Promotion is the only door.** The orchestrator's board pass promotes READY stories
   and bugs that have no task (`backlog.promote_ready`): a real `Task` row, a
   `board.item.promoted` event, then wave/assign/verify/reward run as usual. A promoted
   item refuses hand-moves (409: "its column follows the task").
5. **Per-team boards.** `/board?department_id=&squad_id=` filters on the item's *effective*
   team — the task's once promoted, the item's own before. A team's board hides the
   run-wide epic: it shows the team's work, not the run's whole story.
6. **Joint work finishes together.** `join_task` puts a colleague into `task.helpers`
   (event + a DM to the assignee). On the first failure the ladder now checks the helpers
   before the lead: a helper who covers the task's skills takes the retry ("helper takes
   over") — being asked to help means finishing it, not being told about it.
7. **Bug intake is a tool.** `report_bug` (capability `board.write`, in every grade's
   ceiling, including trainee) files a bug under the story being worked, in READY, with
   severity → priority; the next wave promotes it to the team that owns the work.
8. **API & UI.** `GET /api/projects/{id}/board`, `POST …/board/items`,
   `PATCH /api/board/items/{id}`; a **Board** tab with columns, team/squad filters, an
   add story/bug form, and move arrows (only on unpromoted items — a promoted card says
   "follows task" and shows attempt count and helpers). The mock serves the same board
   contract so the tab is exercisable with no keys.

## Consequences

- One workflow truth: the board reads the engine; planning never blocks dispatch; bugs
  share the story lane instead of a parallel defect database.
- `board.write` is granted broadly (recording intent, not spending) — no approval gate.
- The backlog service emits events only after its write session closes — emitting inside
  an open write transaction locks SQLite ("database is locked", learned in review).
- Tests (`backend/tests/unit/test_board.py`): hierarchy + linkage + derived column, promote
  exactly once + refusal on hand-move, bug filed under the current story, helper joins and
  takes the first retry.

## Alternatives considered

- **Board columns as an independent state machine** (the board keeps its own state): two
  truths; drift is guaranteed the first time a task fails after being dragged to Done —
  rejected.
- **Tasks-only board** (no `work_items`): a task cannot be an epic, and unplanned bug
  reports would have nowhere to live until someone decided to run them — rejected.
- **Letting agents or users move promoted cards**: a second source of workflow, and the
  first honest disagreement breaks the renderer's "never lie" rule — refused by design.
