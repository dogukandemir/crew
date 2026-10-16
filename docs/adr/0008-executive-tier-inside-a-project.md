# ADR 0008: The executive tier lives inside a project (C-roles)

**Status:** accepted · **Related:** docs/02 §1–3, docs/17

## Context

The owner asked why the company has no C-level, CEO, CTO, CMO, CPO, and whether it
was a mock gap or a system gap. The answer was: a system gap. The concept existed
nowhere, though the frontend's avatar classifier already matched `chief|director|vp` in
anticipation, and the grade system already had a "chief" tier. The system's top level
was: one orchestrator per project (whose chain entry literally reads *executive*) →
department heads → squad leads → workers.

## Decision

1. **The project remains the company**, and the orchestrator remains its single named
   executive owner (the docs/02 §1 invariant is untouched). No company entity above
   projects in this step, that stays future work and will generalize these roles upward.
2. Four roles join the vocabulary: `cto`, `cmo`, `cpo`, `coo`, grade **CHIEF**, reasoning
   tier, with function-owning capabilities (hire/fire, council convene, decision request,
   budget request, net read).
3. A C-role owns a **function**, a fixed group of department categories:
   technology {engineering, data, security} · market {research, business} ·
   product {design, content, media} · operations {org, meta}.
4. A chief is hired **by the orchestrator** (`staff_gaps`) when a function reaches **two
   active departments**, and the heads of those departments are re-seated to report
   through the chief: the chain reads `orchestrator → chief → head → lead → worker`.
   One chief per function at a time; a laid-off chief can be replaced, a working one is
   never duplicated. New departments in a function with an existing chief report to the
   chief from their first day.
5. Chiefs do not take IC work: excluded from task candidates like heads, and carrying a
   steep assignment penalty if the machinery ever considers them.

## Consequences

- Org trees gain depth only when scale justifies it: a small project with one department
  per function reads exactly as before; a project with engineering + data grows a CTO.
- A refused chief hire (budget breaker) leaves the function headless, the departments
  keep reporting to the orchestrator, a legal chain, just a flatter one.
- **Reward shares for chiefs are deliberately deferred**: the settlement chain still pays
  producer, lead, head and verifier. Add the share when a chief's impact is measurable,
  not because the box now exists.
- Events: `org.function.formed` (function, chief_id, departments) marks the moment; the
  hire itself emits the ordinary `org.agent.hired`.

## Rejected alternatives

- **Renaming heads to C-titles** (cosmetic): the machine would not change; the owner
  asked for the hierarchy, not the label.
- **A C-role per department**: a second head with a fancier name, no new responsibility.
- **Company entity above projects now**: the honest end-state, but a milestone of its
  own (entity, scopes, budgets, UI); building it on top of an in-project tier that has
  proven itself is the safer order.
