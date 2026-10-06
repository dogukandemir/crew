# ADR 0001 — Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-10-06

## Context
This project has a very large design surface (org model, rewards, memory, security,
observability) and will be built over many sessions. Decisions made in conversation are lost.

## Decision
Every decision that is expensive to reverse gets an ADR in `docs/adr/`, numbered, with
Context / Decision / Consequences. Code may only contradict an ADR if the ADR is superseded in
the same commit.

## Consequences
- Slight overhead per decision.
- Future sessions and contributors can see *why*, not just *what*.
- `docs/README.md` indexes the ADRs; an ADR is never edited, only superseded.
