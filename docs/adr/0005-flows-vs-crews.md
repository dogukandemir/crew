# ADR 0005 — Flows for org control flow, Crews for swarm work

- **Status:** Accepted
- **Date:** 2026-10-06

## Context
We need both flexibility (agents deciding how to do work) and determinism (a run that can be
paused, resumed, audited and reasoned about). A single hierarchical Crew with a manager agent
gives flexibility but no reliable state machine and no clean resume.

## Decision
Split by scope:
- **CrewAI Flow** implements the run pipeline: `INTAKE → PLANNING → STAFFING → DISPATCH →
  EXECUTING → VERIFYING → REWARDING → LEARNING → DONE`, with `@router` for replan/branch and
  persisted state so a run resumes at the last completed stage.
- **CrewAI Crews** implement the work inside one stage wave, since inside a wave the LLM should
  be free to organise itself (hierarchical when a lead manages, sequential for a straight line).

## Consequences
- Deterministic, inspectable, resumable pipeline; agents keep autonomy where it pays off.
- Two mental models to document and teach (this doc + docs/03).
- Flow state is persisted by us (not CrewAI's in-memory state) so restarts are safe.
