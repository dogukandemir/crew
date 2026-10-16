# ADR 0005: Flows for org control flow, Crews for swarm work

- **Status:** **Superseded by ADR 0007** (the Crews half stands; the Flows half was replaced by
  an explicit resumable state machine once durability, cancellation and budget pre-flight landed).
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

## Superseded (2026-10-06)
The Flows half did not survive first contact with durability, cancellation, budget pre-flight and
async concurrency requirements, see **ADR 0007**. What the code actually does: an explicit,
resumable async state machine per run (`control/orchestrator.py`), with CrewAI **Crews** executing
each wave of work inside a stage. The Crews half of this ADR stands unchanged.
