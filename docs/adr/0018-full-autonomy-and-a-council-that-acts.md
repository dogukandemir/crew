# 0018: Full autonomy (YOLO) and a council that acts

Status: accepted · Relates to: 0007 (pipeline), 0011 (governance), 0012 (command desk),
0017 (security review), docs/03 §5, docs/08

## Context

The first two live runs (KaffeKlip launch pack, 14 October 2026) delivered four of five
tasks and then stalled, twice, on the same two design gaps:

1. **Human gates stalled unattended runs.** `python_eval` under a supervised agent filed
   an approval per call with a two-hour TTL. An unattended evening became hours of
   blocked tasks and a tray of expired requests. The owner asked for a mode where agents
   decide everything themselves.
2. **The council's outcomes did not act.** All three options of a failure council ended
   as `aborted` tasks. "Retry with a higher model tier" parked the task for an operator
   action that does not exist in the interface; "reduce scope" demanded an approval
   nobody could give. Re-running from scratch was the only path out, at real cost.
3. **The verifier read every attempt at once.** Artifacts from earlier attempts stayed in
   the packet, so a "fits on one page" criterion failed because three guide versions were
   concatenated as one deliverable.

## Decision

**YOLO mode is a project setting (`settings.yolo = true`).** The PolicyEngine keeps every
deny above the gates (paused project, tool policy, capability ceilings, per-agent grants)
and returns ALLOW in place of any "requires human approval". The tool invoker and the two
security review gates (fetched content, risky commands) honour it, and every call a human
would have been asked to approve is written to the hash-chained audit log and emitted as
`policy.yolo`. Nothing else changes: workspaces stay jailed, the sandbox stays fail-
closed, budgets keep their breaker, and the verifier still gates rewards.

**A council's outcome is applied, in both modes.** `retry_more_budget` puts the task back
to READY with two fresh attempts. `reduce_scope` rewrites the acceptance criteria to a
smaller set (model-written when a key is configured, the first two otherwise) and
requeues. `abort_task` aborts. Each application emits `task.council.retry`. A task may
take two council life-lines; a third failure aborts it.

**Verification scopes to the final attempt.** `artifact_publish` stamps the task's attempt
number on the artifact row; the verifier (deterministic checks, contract and evaluator)
reads only the newest attempt's publications. Earlier attempts remain on disk as
evidence.

## Consequences

- A YOLO run has no human checkpoints by design. The audit log is the record; the switch
  lives in Settings → Autonomy, and it is per project.
- The council is now an actor, not a suggestion box: its decisions requeue work and
  rewrite criteria on the record. The operator reviews outcomes, not requests.
- A retry cap of two keeps a hard task from burning the envelope in a loop.
- The owner's rule stands: what a mode removes in asking, it must record. YOLO logs what
  it skips.
