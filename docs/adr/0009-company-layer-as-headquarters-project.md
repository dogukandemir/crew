# ADR 0009: The company layer: a headquarters project that runs the portfolio

**Status:** accepted · **Related:** docs/02 §1–2, docs/17, ADR 0008

## Context

The owner asked for a company standing above the projects: a CEO, CTO/CMO/CPO/COO,
project executives reporting upward, a portfolio budget, cross-project arbitration.
ADR 0008 put an executive tier *inside* each project; the company level is the layer
above it. The question was how to add a scope to a codebase that reads project-first
everywhere (agents, budgets, brains, events all carry project_id).

## Decision

1. **A company IS a project** (`projects.kind = 'company'`), created like any other and
   carrying the same machinery: budget cap, settings, brains, event stream. This is the
   schema economy: governance reuses agents/budgets/brains/councils/events wholesale
   instead of a parallel org model, and a running dev database needs one `ADD COLUMN`
   (`db._add_missing_columns`), not a migration.
2. The company's executive is the **CEO** (role `ceo`, grade CHIEF), hired at bootstrap
   instead of an orchestrator; ordinary runs never touch a company project.
3. Projects join a company (`projects.company_id`); joining re-points the project
   orchestrator's `manager_id` at the CEO, the report chain becomes
   `CEO → orchestrator → chief? → head → lead → worker`.
4. Company-scope **function chiefs** (ADR 0008's cto/cmo/cpo/coo, one scope up) join on
   demand via the API and report to the CEO.
5. **The review is the working part**: `company.review()` reads every member project's
   books (spend ratio, completed, failed, last activity) and writes one directive event
   into each member's stream; `orchestrator._company_directives` reads them into task
   prompts ("COMPANY DIRECTIVES (from the board; binding)"). Deterministic on purpose:
   every line cites its basis, an LLM garnish can come later, a lie cannot.
6. Verdict rule (v1): `stop` ≥ 95 % spend · `at_risk` ≥ 50 % failures (≥ 3 attempted)
   or ≥ 80 % spend · `no_activity` silent past `review_stale_hours` (72) · else
   `on_track`.

## Consequences

- Companies stay out of `/api/projects` (kind filter); the home screen lists them
  separately. `GET /api/companies` carries roster, members, and the last review's
  verdicts.
- Auto-reviews on a schedule are deliberately not built: a person (or a later cron)
  presses "Review now"; the event trail makes it auditable either way.
- Cross-company relationships and CEO-driven hiring across projects are future work.

## Rejected alternatives

- **Nullable-scope agents** (`Agent.company_id` + nullable `project_id`): a real
  migration on SQLite for a model the codebase reads project-first everywhere; the
  HQ-project holds the same meaning with none of the surgery.
- **A separate `companies` table with parallel org tables**: two org models to keep in
  sync, the exact drift docs/02 exists to prevent.
