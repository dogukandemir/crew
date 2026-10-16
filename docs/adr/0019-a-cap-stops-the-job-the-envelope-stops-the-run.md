# 0019: A cap stops the job, the envelope stops the run

Status: accepted · Relates to: 0007 (pipeline), 0018 (autonomy), docs/03 §5, docs/07, docs/08 §8

## Context

The Launch project's third live run (16 October 2026, goal: the KaffeKlip pilot launch pack)
ended `paused_budget` with the project envelope half full, cap $6.00, spent $2.99, reserved
$0.00, available $3.01. Four of its five deliverable tasks had failed verification, the wave
re-planned them, and the run stopped for good: no wave could heal it. The pause was a latch in
process memory (`BudgetGuard._breaker_open`), not a reading of the ledger, so raising the cap
left the project stopped until a restart.

Reading the rows back showed three separate defects, all on the same path:

1. **The breaker latched on ANY refused reservation.** `reserve()` called `open_breaker()`
   whenever `amount > available`, and `available` is the minimum of the three scopes. One
   worker touching its own per-run cap, or a department envelope running dry, therefore
   stopped every other agent in the project, and the run moved to `PAUSED_BUDGET` with an
   empty `error` field: no cause, no numbers, no way out. docs/08 §8 has said all along that
   a refused reservation fails *the job*.
2. **An over-priced call latched the project too.** `_call_model` opened the breaker whenever
   a completed call cost more than its reservation (`charged > amount`). One under-estimated
   call, whose actual cost the ledger books correctly, stopped the run.
3. **A file written into the workspace was invisible to the verifier.** Four tasks failed
   deterministic verification with "0 registered artifact(s)" and "0 chars" at 13:11-13:13
   UTC while their files sat on disk (`landing_page_da.md`, 12,197 bytes, written 13:12 UTC):
   `fs_write` wrote the bytes and recorded nothing, so the judge read an empty packet.

## Decision

**The circuit breaker guards the project envelope, and only that.** `BudgetGuard.reserve`
raises `BudgetExceeded` for every refusal, and calls `open_breaker()` only when the project
(plus its parent company) envelope is actually exhausted. A scope refusal fails the job and
leaves the run to its other agents.

**An overspend is booked, not a stop.** A call that costs more than its reservation emits
`budget.overrun` (model, call id, reserved, charged) and settles its actual cost; the next
reservation reads its availability from the ledger.

**A pause names its cause and can heal.** `Orchestrator._budget_stop_stands` re-reads the
envelope at each wave head and clears a stale latch when headroom exists; `_pause_for_budget`
writes the numbers and the way out into `run.error` and emits `budget.paused` with
`cap_micros`/`spend_micros`/`reserved_micros`/`available_micros`.

**A file written into the workspace is a deliverable.** `fs_write` writes bytes (text mode
would rewrite `\n` to `\r\n` on Windows and the digest would describe a file that does not
exist) and registers the artifact with the producer's attempt stamp, so the verifier reads the
producer's work.

**A four-deliverable plan runs four wide.** `CREW_MAX_CONCURRENT_CREWS` defaults to 4; the
provider-call gate shares the same number.

## Consequences

- Agents are no longer stopped by each other's caps: an agent that hits its own limit fails
  its task, and the wave continues with the rest of it.
- A pause is actionable from the record alone (run row plus `budget.paused`), and it clears
  when the operator raises the cap or the budget day rolls over, without a restart.
- The breaker keeps its teeth where they matter: an exhausted envelope still stops dispatch,
  refuses hires and stops in-flight crews at the next step boundary. The kill switch still
  opens it deliberately.
- `budget.paused` and `budget.overrun` are registered payload types, so their payloads are
  validated in dev like every other event.
- Guard tests: `backend/tests/unit/test_efficiency_fixes.py` (workspace write registers the
  deliverable; a scope refusal does not latch; an exhausted envelope pauses with its cause and
  heals when the cap moves).
