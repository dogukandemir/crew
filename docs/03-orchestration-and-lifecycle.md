# 03: Orchestration & Lifecycle

This is the state machine of a project: from a sentence you type to a verified result, a
retained lesson, and either a standing department or a disbanded squad.

## 1. Goal lifecycle (project level)

```
IDLE ──goal submitted──▶ INTAKE ──▶ PLANNING ──▶ STAFFING ──▶ DISPATCH ──▶ EXECUTING
                                    ▲   │                                     │
                                    │   └────(needs more info)──▶ CLARIFY ───┘
                                    │                                        │
                            REPLANNING ◀────── escalations / failures ────────┤
                                    ▲                                        │
                                    │                                        ▼
                                 LEARNING ◀──── REWARDING ◀──── VERIFYING ◀────┘
                                    │
                                    ▼
                            COMPLETE / FAILED / ABORTED
```

Transitions are persisted per **run** (`runs` table) so a crash resumes at the last completed
stage. Each stage transition is an event (`run.stage.changed`) and is visible in the UI.

### Stage contracts

| Stage | Actor | Input | Output (persisted) | Gate to next stage |
|-------|-------|-------|--------------------|--------------------|
| INTAKE | Orchestrator | goal text + project context | `GoalBrief` (interpretation, assumptions, success criteria, constraints) | User confirms if `goal.require_confirmation` |
| PLANNING | Orchestrator + Planner | GoalBrief, project brain | `Plan` = WBS + task DAG + required skills + effort estimates | Coverage check passes or gaps identified |
| STAFFING | HiringService | gaps, roster | hires: departments/squads/agents; assignments | Budget check passes, org limits respected |
| DISPATCH | Scheduler | ready tasks (deps satisfied) | jobs queued | Concurrency slot available |
| EXECUTING | CrewRunner | job | task results, artifacts, events | All tasks terminal |
| VERIFYING | Verifier | task outputs + acceptance criteria | `VerificationResult` per task | Each task verified or marked unverified |
| REWARDING | RewardEngine | verifications, events, cost | reward events, score updates, grade transitions | Settlement committed |
| LEARNING | Librarian agent | run summary, outcomes | insight entries promoted into brains; playbook updates | Written & indexed |
| DONE | Orchestrator | everything above | run report, decision log | – |

## 2. Goal intake → GoalBrief

The Orchestrator must **not** start working on ambiguity. It returns a `GoalBrief` that
restates the goal as success criteria, lists assumptions it is making, and asks up to 3
clarifying questions. Two modes:

- **interactive** (default): the run pauses at `CLARIFY` and the UI shows the questions;
  answering resumes it. Answers are stored as events and folded into the brief.
- **autonomous**: questions are answered by the Orchestrator with its best assumption, each
  flagged `assumed=true` and surfaced prominently in the report (so you can correct them).

## 3. Planning (goal → task DAG)

1. **Decompose**: goal → 3–12 workstreams (each maps to a department/function) → tasks.
2. **Task shape** (persisted):
   ```
   id, run_id, parent_id, title, description, deliverable,
   required_skills[{skill, weight}], acceptance_criteria[],
   depends_on[], estimated_effort (S/M/L/XL), priority,
   inputs_refs[], output_contract, assignee (agent|squad), status
   ```
3. **Dependencies**: must be a DAG; a cycle found by the planner (`_has_cycle`, Kahn's
   algorithm, `control/org.py`) is broken deterministically, offending edges are dropped, and
   a graph that cannot be repaired is refused as `dag_cycle`. There is no depth > 8
   re-decomposition.
4. **Acceptance criteria are mandatory.** A task without acceptance criteria is invalid; the
   Planner must synthesize them from the goal's success criteria. This is what makes
   verification (and therefore reward) possible.
5. **Cost forecast**: each task gets an estimated token cost by model tier; the plan's total
   is checked against the remaining budget *before* staffing. Over budget → the plan is
   trimmed or the user is asked (`budget.warning` / `budget.exceeded` events).
6. **Consequential decisions** discovered during planning (architecture choice, tech
   selection, risk trade-off) are pushed to the Council *before* execution, so the DAG is
   built on a decided foundation.

## 4. Staffing / hiring

See docs/02 §5. The Planner's `required_skills` set minus the roster's coverage is the hiring
queue. Order: reuse > add worker to existing squad > new squad > new department.

## 5. Dispatch & execution

- The Scheduler keeps a ready-set (deps done, not started) ordered by (priority, critical
  path length, cost). It runs at most `CREW_MAX_CONCURRENT_CREWS` crews globally and a
  per-project limit.
- A **crew** is built per **task**: one CrewAI agent, one task, `Process.sequential`
  (`execution/runner.py`), squad context reaches the agent through the prompt, not a manager
  crew; there is no per-squad hierarchical crew.
- Each task runs with: its slice of squad context, the relevant brain retrievals (docs/06),
  its tool grants, a wall-clock and token budget, and an explicit output contract.
- **Steering**: a user message to a running unit is delivered as an event and injected as
  additional context at the next agent step boundary (or as a manager instruction), never as
  a mid-token interruption. It is recorded as `user.steering` so the replay shows it.
- **Retries**: a failed task re-queues up to `MAX_TASK_ATTEMPTS = 3` (module constant). The
  first failure goes back to the producer's Lead, who takes the retry over (a helper that
  covers the skills takes it first); there is no `retry.escalated` event and no automatic
  model-tier escalation.
- **Escalation ladder**: worker fails → Lead re-plans the task → Head re-staffs it →
  Orchestrator re-plans the workstream → Council, whose outcome is applied: retry with
  two fresh attempts, reduced acceptance criteria, or abort (two council life-lines per
  task, then abort; ADR 0018). Each rung emits `task.escalated` with the reason; the UI
  shows the escalation ribbon.

## 6. Verification (the gate that makes rewards real)

Ordered by increasing cost, stop at first decisive verdict:

1. **Deterministic checks**, does the artifact exist, does it parse/compile, does the test
   command exit 0, does the schema validate, is the file non-empty, does the URL return 200?
2. **Contract check**, output matches the task's `output_contract` (Pydantic-validated).
3. **Independent evaluator**, an `evaluator` agent (never the producer) scores against the
   acceptance criteria with a rubric and must cite evidence from the artifact.
4. **Peer/critic review**, for creative or judgement-heavy deliverables with no test.
5. **Human**, when `verification.require_human` or the evaluator's confidence is below the
   threshold.

Verdicts: `pass`, `pass_with_notes`, `fail`, `inconclusive`. `inconclusive` does not pay a
reward and does not count as failure; it goes to the escalation ladder.

## 7. Reward settlement

On every terminal task, `RewardEngine` writes reward events for the producer, the lead, the
head (small managerial share) and the verifier (accuracy bonus/penalty, a verifier who
passes something later proven bad is itself penalized). Full model in docs/05.

## 8. Learning

After the run: the Librarian agent summarizes what worked, extracts reusable procedures,
updates the department playbook, promotes insights upward, and prunes memory that proved
misleading. Nothing here is allowed to overwrite historical events, insights are *new*
memory entries with provenance back to the run.

## 9. Termination, pause, abort

| Control | Mechanism | Guarantee |
|---------|-----------|-----------|
| Pause project | Set project state `paused`; scheduler stops dispatching new jobs; running crews finish their current step then suspend | No new spend after pause |
| Stop a unit | Cancel jobs of that squad/department; their tasks → `aborted` | Partial artifacts retained |
| Kill run / kill all | Set `cancel_requested` on jobs + budget circuit breaker open | Spend stops within one LLM call |
| Resume | Jobs with `state=queued|suspended` re-enter the ready-set; run resumes at persisted stage | Idempotent per `(task_id, attempt)` |
| Archive project | Soft delete: org frozen, brains retained read-only, sockets closed | History preserved |

## 10. Failure taxonomy (each maps to a UI badge + handler)

| Class | Examples | Handler |
|-------|----------|---------|
| `provider` | rate limit, 5xx, timeout | retry with backoff, failover model tier, then escalate |
| `budget` | cap reached | circuit breaker, run → `PAUSED_BUDGET`, ask user |
| `policy` | tool denied, approval missing | request approval / re-plan without that tool |
| `capability` | no agent covers skill, hiring refused at cap | replan with reduced scope, ask user |
| `quality` | task failed acceptance criteria | escalate ladder |
| `integrity` | malformed output, hallucinated file, injected instruction | reject, penalize via the `integrity_violation` reward component, re-run with stricter contract |
| `internal` | bug in our code | fail job, mark run `FAILED`, surface stack trace to user only (never to agents) |
