# ADR 0007 — The run pipeline is our own resumable state machine, not a CrewAI Flow

- **Status:** Accepted (supersedes the "Flows drive organisation-level control flow" part of ADR 0005)
- **Date:** 2026-10-06

## Context
ADR 0005 chose CrewAI **Flows** for the run pipeline (`INTAKE → … → DONE`). While implementing
M1–M3 it became clear that a Flow is the wrong container for this pipeline, because the pipeline
needs properties CrewAI Flows do not give us:

1. **Durable resume.** A run must survive a process restart and continue at the last completed
   stage. Flow state lives in the object graph, not in our database; we would be storing it
   ourselves anyway, doubling the model.
2. **Cancellation.** The user must be able to pause or kill a project and have spend stop at the
   next step boundary. That needs a check *between* stages and tasks against our own flags and
   the budget circuit breaker — precisely the points we already control.
3. **Budget pre-flight.** Reserving budget before an LLM call is a cross-cutting gate that must
   wrap dispatch; a Flow hides the dispatch boundary behind its own orchestration.
4. **Async-native concurrency.** Crews run in threads with a semaphore, tasks in one wave run
   concurrently, and the whole thing is driven from the FastAPI event loop. Flow's execution model
   is synchronous and its async story is bolted on.
5. **Observability parity.** Our stages must emit exactly the same events as everything else; with
   a Flow we would be mapping Flow internals onto our event vocabulary, losing fidelity.

## Decision
Implement the run pipeline as an explicit, resumable async state machine
(`control/orchestrator.py::Orchestrator._advance`), where **every stage is a function**, the stage
and status are persisted on the `runs` row, and the loop can be entered at any time (start,
resume after pause, resume after restart, or after a clarification answer).

CrewAI is still used for what it is good at: bounded, multi-agent work inside a wave
(`execution/runner.py::CrewAICrewRunner` builds `Agent`/`Task`/`Crew`). ADR 0002 is unchanged.

## Consequences
- Resume/cancel/budget gates are ours, testable without any LLM (the integration suite proves it).
- Flows remain available if a future sub-pipeline is naturally a graph; nothing forbids using one
  *inside* a stage.
- We maintain the state machine ourselves: the stage contract is documented in docs/03 §1 and each
  stage has exactly one entry and one exit transition.
- ADR 0005 stays on the record for the reasoning it captured; this ADR supersedes only its Flow
  clause.
