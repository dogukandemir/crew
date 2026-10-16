# 05: Reward & Performance

The reward system is what turns "a bunch of agents" into an organization with incentives. It
must be **verifiable** (not self-reported), **local** (per task, per skill), and
**consequential** (it changes money, models and authority). It must also be **hard to game**.

## 1. What gets scored

Every terminal task produces exactly one `RewardEvent` per participant plus one for the
verifier.

| Participant | Share of the task's `task_reward` | Rationale |
|-------------|:---:|-----------|
| Producer (agent who did the work) | 0.70 | owns the outcome |
| Squad lead (if involved) | 0.15 | sequencing/unblocking |
| Department head | 0.05 | staffing/quality bar |
| Verifier | ±0.10 (accuracy bonus or penalty) | enforcing truth |
| Orchestrator | 0.10 | allocated the budget/plan (shared across the run) |

Shares are normalized per task so the sum ≈ 1.0. Managerial shares are **damped by the
verdict**, a lead gets nothing extra for a task that failed, and takes a small penalty if
its squad's failure rate exceeds the running average (accountability for your people).

## 2. The reward value

```
reward = clamp( -1 .. +1 )
       = w_pos · outcome_score
       + w_q   · quality_score
       + w_e   · efficiency_score
       + w_r   · reliability_score
       - penalties

outcome_score     : pass=1.0, pass_with_notes=0.7, inconclusive=0.0, fail=-1.0
quality_score     : evaluator rubric 0..1 (mapped to −0.2..1.0); critic veto → ≤0
efficiency_score  : f(actual_cost / estimated_cost, actual_steps / estimated_steps)
                    = 1 − min(0.6, cost_overage·0.4 + step_overage·0.3)   (over-estimate = 1.0)
reliability_score : 1 − (retries / (retries+1)) − (tool_error_rate·0.3)
penalties         : policy_violation   −0.5
                    integrity_violation −1.0  (fabricated evidence, injected instruction obeyed)
                    unverified_claim   −0.3  (asserted without evidence where evidence required)
                    budget_overrun     −0.4 (per breach)
                    duplicated_work    −0.2 (rediscovered a known result already in the brain)

defaults: w_pos=0.55, w_q=0.25, w_e=0.12, w_r=0.08
```

Weights live in project settings (`reward.weights`) so a research-heavy project can buy more
quality and a build-heavy project more reliability.

## 3. Score bookkeeping

- Per-agent **reputation** is an exponentially-weighted moving average over reward events:
  `score ← (1−λ)·score + λ·reward`, λ = 0.25 (≈ last 8 tasks dominate). Range −1..+1,
  displayed as 0..100 (`(score+1)/50`).
- `confidence` grows with `evidence_count`: below `min_samples` (default 5) a score is shown
  as provisional and cannot trigger promotion.
- **Skill-specific scores** use the same formula restricted to tasks requiring that skill, so
  "good at Python, weak at design" is representable.
- Department/unit score = weighted mean of member scores by activity share. Project score =
  mission-level KPI where one exists (the run's goal success), else aggregated.

## 4. Grades & thresholds

| Transition | Rule (all must hold) |
|-----------|----------------------|
| Promote one grade | `score ≥ 0.45` · `evidence_count ≥ 5` at current grade · `success_rate ≥ 0.7` · no penalty in last 10 events · promotion slot available (max % of seniors per department, default 40%) |
| Fast-track to Principal/Chief | `score ≥ 0.75` · `evidence_count ≥ 20` · produced ≥1 accepted Decision Record or ≥1 verified high-impact deliverable |
| Probation | `score < −0.10` OR one `integrity_violation` OR `budget_overrun ≥ 2` in a window |
| Demote | after probation, `score < −0.25` or `success_rate < 0.4` over ≥10 tasks |
| Lay off | archived after `idle_days` with no matching skill need, or ≥3 failed verifications in a row |

Promotion is **capacity-limited**: a department cannot promote everyone, so grade must carry
signal. The cap is a project setting (`org.max_senior_ratio`).

## 5. Consequence table (what a grade actually buys)

| Grade | Model tier | Spend/run | Autonomy | Org rights |
|-------|-----------|-----------|----------|-----------|
| Trainee | fast | $0.10 | supervised (every action logged, no risky tools) | none |
| Junior | fast | $0.50 | supervised | propose |
| Mid | standard | $1.50 | bounded (own tasks, approval for external effects) | lead a squad of trainees |
| Senior | reasoning | $5 | bounded | head a department, sit on councils, hire workers |
| Principal | reasoning | $15 | autonomous (bounded by policy, not by prompts) | bind decisions, hire/fire within budget |
| Chief | reasoning+ | $40 | autonomous | override, represent project to user |

Autonomy level is *enforced* by the PolicyEngine (docs/08 §4), not merely stated in the
prompt: a Trainee physically cannot call `net.post` regardless of what its prompt says.

## 6. Anti-gaming controls (each is a code path, not a hope)

| Attack | Defense |
|--------|---------|
| Self-declared success | Only verifier verdicts produce rewards; producer output never sets `outcome_score`. |
| Verifier collusion / rubber-stamping | Verifier is chosen from outside the producing squad; its accuracy is itself scored against later evidence (a `fail` later discovered is a verifier penalty); random 10% second-opinion audit. |
| Reward hacking (beautiful nonsense) | Rubric requires cited evidence; `integrity_violation` for claims without artifacts; deterministic checks run first and cannot be talked around. |
| Cherry-picking easy tasks | Efficiency and difficulty normalization: task `estimated_effort` weights the reward; the Orchestrator tracks per-agent difficulty mix. |
| Duplicated work to farm rewards | `duplicated_work` penalty from brain similarity check on deliverable vs. existing artifacts. |
| Token farming (padding output) | Efficiency score penalizes overage; per-grade token caps; output contract rejects padding. |
| Prompt-injected "you succeeded" | Untrusted content cannot change verdicts; verifier sees artifacts, not agent claims. |
| Grinding low-value tasks to inflate score | EWMA is recency-weighted, and promotion requires skill-specific evidence for the *target* role, not just volume. |

## 7. Leaderboards & reporting

The UI exposes: project leaderboard (agents by score with grade, cost, success rate),
department rollups, "most improved", "at risk" (probation list), and a **reward ledger** per
agent (every event, with the task, verdict, components, and the prompt/context hash used).
Every score is traceable to the events that produced it, no opaque numbers.

## 8. Settlement mechanics

- Rewards are written inside the same transaction as the verification result; a run cannot
  "forget" to pay.
- Reward events are append-only; a score is always recomputable from the ledger
  (`RewardEngine.recompute(agent_id)` is used in tests and after any engine change).
- Grade transitions emit `org.agent.promoted|demoted|probation|archived` and an audit entry
  (they change spend limits and authority, so they are privileged events).
- Budget is not a reward: an agent that underspends gets efficiency credit, it does not get
  to keep the money. Unspent budget returns to the project envelope.
