# 0015 — Company-first navigation and the four brain levels

Status: accepted (2026-10)

The platform grew project-first; the company layer (ADR 0009, ADR 0011) arrived later and
the UI squeezed both levels into one flat tab set. Every consequence was a small lie at
once: a member project's "HQ" tab hit `GET /companies/{id}/hq` with a project id and got
a 404 (`kind != 'company'` raises), while a company tab offered Office/Org/Tasks views
that belong to members. Projects were born free-floating, and attaching to a company was
an afterthought in a side panel — so the hierarchy the data model had was invisible in
the product.

## Decision

1. **Scope picks the views.** A tab knows its kind:
   - a company shows `HQ · Projects · Brains · Events · Settings`;
   - a member project shows `Office · Overview · Org · Tasks · Board · Agents · Brains ·
     Rewards · Events · Settings` — **no HQ**; the company is one breadcrumb up.
   A remembered view that is out of scope (e.g. `hq` persisted on a member from before
   this ADR) falls back to the scope's default (`hq` / `office`) and the tab store heals
   itself. `WORKSPACE_TABS` shrinks to the union; `PROJECT_TABS`/`COMPANY_TABS` own the
   scopes (`workspaceTabsFor(kind)`).
2. **The floor keeps governance.** Review / Allocate / Board session stay under HQ where
   the scene animates them; they are not a separate tab.
3. **Two new company views.** *Projects* — the portfolio as cards (verdict, books, teams,
   directive, open-office door, `＋ New project here` born under the company). *Brains* —
   the umbrella brain plus a per-member memory index (where the portfolio's knowledge
   lives, read-only; a member's entries open from its own tab).
4. **The breadcrumb is the way up.** A member's header leads `⌂ Company › Project`; the
   tab strip groups members with their company and prefixes them `⌂`. Nothing else
   pretends to be HQ.
5. **Projects are born under companies.** The founding wizard (`POST /api/found`) creates
   the company, its first project under it and the first run in one call; the new-project
   dialog offers `Company ▾` (preselected when any company exists) and standalone stays
   possible — company-first is the guided default, not a schema constraint. The welcome
   screen leads with *Found a company* and carries a four-step getting-started checklist
   that reads the record (provider → company → project → first run).
6. **The company brain is the fourth level.** `BrainScope` gains `COMPANY`:
   - it lives on the company's own row (a company IS a project row);
   - the mission seeds it at founding; every portfolio review and allocation writes its
     decision into it; the CEO/chair write, members read;
   - `brains_for_agent` includes it for every member project, and retrieval is scoped by
     **brain id** (not by row), so a directive written once reaches the whole portfolio.
   Pre-existing companies that kept their memory in a project-scope brain are flipped to
   the company scope on first touch — entries are never stranded.
   The Brains views group the four levels by owner name (company, project, departments,
   individuals), resolved server-side.

## Consequences

- `GET /projects/{id}` ships `company_name` (the breadcrumb's upper half); the project
  list ships `runs` (the checklist reads it honestly — a skipped card never marks a step done).
- The mock serves the same shapes: `/api/found` and `POST /api/projects` write real
  session rows; companies created there get an honest empty floor, not borrowed pods.
- docs/06 level model updated to four levels; docs/09 §1/§2 describe the scopes; docs/11
  lists the new endpoints.
