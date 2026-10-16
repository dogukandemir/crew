# ADR 0002: CrewAI as the execution engine, not the orchestrator

- **Status:** Accepted
- **Date:** 2026-10-06

## Context
CrewAI provides `Agent`, `Task`, `Crew` (sequential/hierarchical) and `Flow`. It is natural to
try to express the whole company (departments, hiring, budgets, rewards, policy) as one big
Crew or Flow. That would put organisational rules inside prompt text where they cannot be
enforced, tested or observed reliably.

## Decision
- CrewAI executes **bounded work**: one squad, one workstream, one wave of the task DAG.
- CrewAI **Flows** drive organisation-level control flow (intake → plan → hire → dispatch →
  verify → reward → learn) because it must be deterministic and resumable.
- Everything organisational, org chart, authority, budget, policy, rewards, memory scopes,
  lives in our own control plane and is enforced in Python.
- All CrewAI usage is confined to `backend/src/crew/execution/`, behind `CrewRunner` and
  `CouncilRunner` protocols, so the engine can be swapped or faked.

## Consequences
- Tests run without network using `FakeCrewRunner`; org behaviour is deterministic.
- We own the state machine, so restarts/resume/cancel are ours (CrewAI offers no persistence).
- Upgrading CrewAI touches one folder.
- We accept writing more glue than a pure-CrewAI project would need.
