# 04 — Agent Model & Skills

## 1. Anatomy of an agent

An agent is a row plus a generated prompt. Nothing about it is hand-written per agent —
the HiringService composes a `RoleSpec` and the PromptBuilder renders it.

```
Agent
├─ identity      id, name (auto, unique, human-readable), role, grade, avatar seed
├─ soul          the person behind the role (ADR 0016): traits[], values[], vision,
│                voice, quirks[], background, source (deterministic | model:<id>)
├─ org           project_id, department_id, squad_id?, manager_id, reports_to
├─ profile       mission (1 sentence), responsibilities[], expertise[], tone,
│                decision_style (analytical | pragmatic | cautious | creative)
├─ skills        [{skill_id, proficiency 0..1, evidence_count}]  ← grows via rewards
├─ tools         granted capabilities[] (never "all tools")
├─ model         tier (reasoning|standard|fast), provider/model, params, token caps
├─ memory        brain scope (agent brain id), working-set policy, retrieval k
├─ autonomy      level: supervised | bounded | autonomous ; approval_rules[]
├─ economics     spend_limit_usd_per_run, spend_limit_usd_per_day, cost_to_date
├─ performance   score (EWMA), tasks_done, success_rate, penalties[], grade_progress
└─ state         active | idle | busy | probation | suspended | archived
```

### Prompt composition (PromptBuilder)

System prompt sections, in order (kept under a hard token budget per tier):

1. **Identity** — name, role, grade, one-line mission.
2. **Soul** — the person (ADR 0016): personality traits, values, vision, voice and
   background, with the honesty guard attached: *it shapes HOW work is done and written,
   never what counts as true*. Present only when the agent has a soul (`prompt_version`
   2); absent for pre-soul hires.
3. **Chain of command** — who I report to, who reports to me, when to escalate, the exact
   escalation contract (what to include: what I tried, evidence, what I need).
4. **Authority** — what I may decide alone; what needs approval; where the policy engine will
   physically stop me (so the agent does not waste turns attempting denied actions).
5. **Method** — role-specific operating procedure (e.g. analyst: source before claim; critic:
   attack the strongest version; decider: weigh evidence, preserve dissent).
6. **Deliverable contract** — the exact output schema required for the task.
7. **Context pack** — retrieved brain entries, labelled with provenance and trust level
   (`trusted` = internal, `untrusted` = from the internet).
8. **Standing rules** — untrusted-content handling, no fabricated evidence, cite sources,
   report blockers early rather than guessing.

The prompt is versioned (`prompt_version` on the agent) and stored with the run so the replay
shows exactly what an agent saw.

## 2. Grades & model tiers

| Grade | Index | Default tier | Max tokens/step | Spend/run (USD) | Autonomy default |
|-------|:-----:|--------------|-----------------|-----------------|------------------|
| Trainee | 0 | fast | 2k | 0.10 | supervised |
| Junior | 1 | fast | 4k | 0.50 | supervised |
| Mid | 2 | standard | 8k | 1.50 | bounded |
| Senior | 3 | reasoning (fallback standard) | 16k | 5.00 | bounded |
| Principal | 4 | reasoning | 32k | 15.00 | autonomous |
| Chief | 5 | reasoning (+ extended thinking) | 64k | 40.00 | autonomous |

Grade determines the *defaults*; the project may override per department (e.g. a
"cheap-research" department pins `standard`). The ModelRouter resolves
`(tier, capability)` → concrete LiteLLM model id via settings, so swapping providers is
config-only. Escalation on retry may jump one tier regardless of grade.

**Also tiered:** embeddings/retrieval use `fast`/`embed` tier; critic and decider **must** be
at least `reasoning` — a policy check (`decider.min_tier`) refuses a Chief decision from a
cheap model, preventing "gaming the decider" with an under-powered agent.

## 3. Skill registry

- Catalog in `skills` table, seeded from `backend/src/crew/domain/catalog.py` (~60 skills
  covering research, engineering, data, design, media, writing, ops, security, domain
  verticals).
- Each skill has: `id`, `label`, `description`, `category`, `typical_tools[]`, `related[]`.
- Proficiency is **evidence-based**: seeded on hire from the role spec, then updated from
  reward events scoped to tasks that required the skill
  (`p ← p + α·(reward − expected(p))`), α default 0.15. Skills decay slowly toward the
  catalog prior if unused for a long time (prevents a lucky early success from defining an
  agent forever).
- `agent_skills.evidence_count` gates promotion: a grade requires *n* verified tasks in the
  skills it is being promoted for.
- Growth is not only skills (ADR 0014). Verified work also accrues **company knowledge**
  (`agents.company_knowledge`, 0..1): `0.05` on hire, `+0.02 × effort_weight` per verified
  task, capped at `0.95`. Tenure is `now − created_at` (`tenure_days`). Both feed the
  system prompt's `TENURE:` line, so a veteran reasons with more context than a first-day
  hire — and every movement lands on the record as one `agent.grew` event, never inferred
  from two snapshots.

## 4. Tools & capability grants

Tools are grouped into **capabilities**; agents are granted capabilities, never tools
directly (docs/08 §4 has the enforcement detail).

| Capability | Underlying tools | Default grant |
|-----------|------------------|---------------|
| `brain.read` / `brain.write` | memory search/write over permitted scopes | all agents |
| `comms.*` | `ask_colleague`, `escalate`, `request_decision`, `report_to_head` | all agents |
| `net.search` | web search (allowlisted provider); results pass the security review gate (ADR 0017) | analyst, worker (read-only roles) |
| `net.fetch` | HTTP GET through egress proxy, untrusted-content marking; results pass the security review gate (ADR 0017) | analyst, worker |
| `net.post` | outbound writes (forms, APIs) | ❌ default; needs approval |
| `fs.workspace` | read/write inside the project workspace (jailed) | worker, lead |
| `shell.sandbox` | command execution in the sandbox (docker only); risky commands gated by the security review / always-allow list (ADR 0017) | engineering workers, lead |
| `code.python` | sandboxed Python eval (same container; reviewed like a command) | engineering, data |
| `git.local` | init/add/commit/branch in workspace | engineering |
| `git.push` | push to a remote branch (never main) | ❌ default → approval |
| `data.sql` | read-only query on project DBs | data, analyst |
| `artifact.publish` | write an artifact into the project store | all |
| `budget.request` | ask for more budget | lead+ |
| `org.hire` | create agents/squads | head+ |
| `org.fire` | archive agents | head+ |
| `council.convene` | start a debate | lead+ |
| `decision.bind` | issue a binding Decision Record | decider only |
| `human.approve` | raise an approval request to the user | all |

Tool results are **always** structured (`{ok, data|error, cost, meta}`), truncated to a
per-tool byte cap, and marked `untrusted=true` when they came from outside the org. The
agent's context labels them accordingly (docs/08 §6).

## 5. Agent state machine

```
created ─▶ probation? ─▶ idle ─▶ busy ─▶ idle ─▶ ... ─▶ archived
              ▲            ▲        │
              │            └────────┘ (task terminal)
              └── penalty / failed verification ── probation ──▶ demoted | archived
```

`busy` agents are never assigned a second task; the Scheduler respects squad-level and
agent-level occupancy so a swarm does not self-contend.

## 6. Workforce economics

Every agent has a cost ledger. The Orchestrator's staffing decisions are explicitly
cost-aware: for each gap it compares (a) hire a Junior + cheap model, (b) reuse an idle Mid,
(c) call a Principal once. The heuristic — cheap for well-specified, repetitive work; senior
for ambiguous, high-impact or irreversible work — is stated in the HiringService prompt and
recorded on the hire event (`rationale`), so you can audit whether the org is spending
sensibly.

## 7. Determinism & testability

Agents are constructed through `AgentFactory` from data only; LLM calls go through
`ModelRouter` which the tests replace with a scripted `FakeLLM` (fixed JSON responses). That
makes org behaviour (hiring, escalation, reward) testable without network and without
non-determinism.
