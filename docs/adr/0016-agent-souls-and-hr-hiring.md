# 0016: Agent souls and HR: hiring is a person, not a stamp

Status: accepted · Relates to: 0008 (executive tier), 0009 (company layer), 0012
(command desk), 0014 (agent growth), docs/02 §5 (hiring), docs/04 §1 (anatomy)

## Context

Hires were templates. `hire_agent` stamped a role onto a row: a name built from the
title (`Specialist #4`), the template's mission string, the template's operating
procedure, and a `decision_style` column that nothing ever wrote and nothing ever
read, every agent in every org literally carried `"analytical"`. The system prompt
was real and versioned (identity / chain / authority / method / memory / rules), but
two same-role agents produced *the same person* with different ids.

Hiring had no people either. `staff_gaps` turned a capability gap into a department, a
head, a lead and workers, directly, with budget gates as the only judgement. There
was no candidate, no interview, no rejection, and no such thing as a bad fit. Asked
for a realistic company, the floor could only answer with templates.

## Decision

**Two layers, one rule: the record never invents a person, and the ladder never
hangs.**

### 1. Souls: the person behind the role (Faz 1)

- `agents.soul` (JSON, added via `_add_missing_columns`, the ADR 0004 dev-schema
  rule): `{name, first, origin, traits[3], values[2], vision, voice, quirks[1],
  background, source}`. Composed at hire by `domain/soul.py` from curated banks,
  **deterministically**: seed `project:role:ordinal`, so an offline run replays the
  same org, and tests hold the line (`test_soul.py`).
- Names come from demographic pools (an American core with Turkish, Indian, French,
  Italian, English, Korean, Japanese, Latino and German colleagues, the same
  company the demo cast describes). `Specialist #4` is gone; the roster reads like
  people. Uniqueness within a project is enforced at compose time.
- The model may **deepen** a soul (`background` + `vision` only) when a provider
  answers; the soul records which happened (`source: deterministic | model:<id>`).
  The model may not invent facts, and an offline run just keeps the deterministic
  wording. The polish never blocks or fails a hire.
- The system prompt gains a **SOUL** section (between IDENTITY and CHAIN OF COMMAND):
  personality, values, vision, voice, background, with the honesty guard in the
  same breath: *"It never overrides the standing rules or the record: personality is
  not a license to fabricate."* `prompt_version` = 2 for soul'd hires; pre-soul rows
  keep 1.
- `GET /api/agents/{id}` serves `soul` + a rendered `soul.md`; the AgentDrawer shows
  a Soul card with the vision, traits, and the markdown one-pager collapsed.

### 2. HR interviews: bounded friction (Faz 2)

- New role `hr` ("Head of People", grade senior, `ORG_HIRE`). Before the first growth
  wave, `hiring.ensure_hr()` seats one HR head per project with a "People" department.
  The bootstrap hire is direct, the first HR head cannot interview themselves.
- Every subsequent growth hire (head / lead / worker / function chief in `staff_gaps`)
  goes through `hiring.hr_hire()`: `hiring.role.opened` → candidates → interviews →
  rejections → the hire. The opening's budget bound is real and narrow:
  `min(project headroom, department envelope remaining)`.
- **The owner's ladder rule (verbatim requirement):** an opening rejects **at most
  two** candidates and the candidate after the rejections is **always** hire-worthy.
  Friction is occasional on purpose, `hr_friction` (project setting, default 0.28):
  most openings land on the first candidate, some cost one rejection, rarely two.
  `roll_rejects()` is capped by construction; tests sweep 400 seeds.
- The rubric is computed, not narrated: skill coverage of the gap, budget fit,
  complementarity with the floor (a clone that adds no coverage is rejected for
  exactly that), vision alignment. Reject archetypes (`skill_shortfall`,
  `grade_overreach`, `profile_clone`, `vision_conflict`) fail on their own dimension
  and the reason cites the real numbers. Rejected candidates exist **only on the
  record**, never as agent rows.
- Candidates arrive with souls too; the winner's soul becomes the hire's soul, and
  the hire rationale carries the interview summary ("…, HR: Pass. Covers 100% of
  the gap…"). Interview notes are deterministic; the model may write them when a
  provider answers (`method: deterministic | model`), the decision stays the rubric,
  prompts express intent, the engine decides.

### Events (registered in `events.REQUIRED_PAYLOAD_KEYS`)

`hiring.role.opened {role, skills, headroom_micros}` ·
`hiring.candidate.proposed {candidate, role}` ·
`hiring.candidate.interviewed {candidate, scores, method}` ·
`hiring.candidate.rejected {candidate, reason}`.

## Consequences

- The roster, drawer, org chart and floor read like a company of people; the demo
  (`dev/mock`) mirrors the shape (soul on the agent detail, a People department, one
  friction story in the p1 stream).
- `@Orchestrator`-style addresses still resolve: mention matching falls back to role
  words, because the orchestrator is now "Elena Rossi", not "Orchestrator #1".
- Replay and determinism hold: souls and candidate sequences are seeded; the ladder
  is bounded; a run cannot loop on rejections.
- Growth still belongs to ADR 0014 (verified work), souls do not change score,
  grade, matching or budget. Personality shapes *how* work reads, never *what counts
  as done*.
- Known boundary: the Captain's desk `hire` and the manual `POST /agents` path hire
  directly (explicit human intent is not interviewed); they still receive souls.
  If that changes, the change belongs in this ADR.
