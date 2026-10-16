# 0014: Agent growth: skills, company knowledge, tenure

Status: accepted · Relates to: 0005 (reward engine), docs/04 (agent model), docs/05 (rewards)

## Context

The reward engine already moved three things when verified work landed: score (EWMA),
grade (promotion / probation rules) and skill proficiency
(`p ← p + α·(reward − expected(p))`). What it could not express was everything
*cumulative* about a person: how long they have been with this company, and how much of
the company they actually know. Two agents with the same skills and grade reasoned
identically on their first day and in their twentieth week.

That gap had three symptoms:

- the prompt had no tenure signal, so a veteran asked the same questions as a hire;
- skill growth happened silently (`adjust_skills` wrote rows, emitted nothing), so the
  feature was invisible on the record, unverifiable by the very audit trail we sell;
- the demo (dev/mock) could not show growth at all, because there was no field to show.

## Decision

**Growth is verified work, made visible.**

- `agents.company_knowledge` (float 0..1; added via `_add_missing_columns`, the ADR 0004
  dev-schema rule): `0.05` on hire, the handbook, not the codebase, plus
  `0.02 × effort_weight` per **verified** task, capped at `0.95`. Only settlement grows
  it; never prompt words, never wall-clock alone.
- Tenure is not stored: it is `now − created_at`, computed wherever it is shown
  (`tenure_days`).
- The reward engine's skill step grows up to a rename: `RewardEngine.grow()` replaces
  `adjust_skills()` and now (1) updates proficiency exactly as before, (2) accrues
  company knowledge, (3) emits **one** `agent.grew` event per task carrying the skill
  deltas and the knowledge move, `payload: {agent_id, task_id, skills_grown[],
  company_knowledge: {before, after}, effort_weight}`.
- The prompt builder adds a `TENURE:` line to the identity section when knowledge is
  passed: "N day(s) with this company; company knowledge X/1.00 (new | working | deep) …"
, with the honesty clause attached: lean on it, but re-verify when the record is thin.
  Familiarity is never certainty, and the `0.95` cap says so too.
- The org views follow: `agent_dict` and the leaderboard expose `company_knowledge` and
  `tenure_days`; the agent drawer shows both next to the grade.

## Consequences

- Score says "how well, right now"; knowledge says "how much of this place has soaked
  in." Promotion rules stay score/evidence-based (docs/05 §4), knowledge is context, not
  a gate yet; if it ever gates something, that belongs in a new ADR.
- `agent.grew` is registered in `REQUIRED_PAYLOAD_KEYS`, so a malformed growth event
  fails on emit in dev instead of landing half-shaped.
- The mock mirrors the same field, the same event and the same bands, so the demo and the
  product describe one mechanism, not two.
