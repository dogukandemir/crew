# 02 — Organization & Command Chain

The org is a tree of **org units**. It is data, not code: every unit is a row, every change is
an event. New units appear when the work requires a capability the org does not have.

## 1. Unit types

| Level | Unit | Created by | Lifetime | Owns |
|-------|------|-----------|----------|------|
| −1 | **Company** | User (API) | Until archived | Portfolio: member projects, company budget, CEO + function chiefs (ADR 0009) |
| 0 | **Project** | User | Until archived | Goal, budget, policies, project brain, org tree |
| 1 | **Department** | Orchestrator (hire event) | Persistent while its capability recurs | Domain mission, roster, dept brain, budget envelope, tool grants |
| 2 | **Squad** | Department Head (or Orchestrator) | One workstream; dissolved at completion | Backlog slice, squad lead, working memory, artifacts |
| 3 | **Agent** | Head (or Orchestrator for executives/chiefs) | Until laid off | Role spec, skills, tool grants, personal brain, score, budget |

**Invariants**
- A project always has exactly one **Orchestrator** agent (role `orchestrator`), created with
  the project.
- Every department has exactly one **Head** agent (role `head`), and at least one worker or
  lead while active.
- Every squad has exactly one **Lead**, at least one worker, and belongs to exactly one
  department.
- An agent belongs to exactly one squad *at a time* but may be pooled at department level
  and assigned to squads over its life.
- Deleting a unit is soft (`archived_at`) so history, scores and events stay intact.

## 2. The chain of command

```
                    ┌──────────────────────────┐
                    │  THE CAPTAIN (the owner)  │  ← the human who owns this deployment;
                    │  command desk (ADR 0012)  │    orders · ideas · questions, plain words
                    └────────────┬─────────────┘
                                 │ directives, goals, steering, approvals
                    ┌────────────▼─────────────┐
                    │  ORCHESTRATOR (executive) │  ← plan, hire/fire, allocate budget,
                    │  role: orchestrator       │    arbitrate, settle rewards
                    └───┬──────────────────┬────┘
                        │                  │
        ┌───────────────▼───┐        ┌─────▼───────────────┐
        │ DEPARTMENT HEAD   │  ...   │ DEPARTMENT HEAD     │  ← own backlog, staff squads,
        │ role: head        │        │ role: head          │    resolve intra-dept conflicts
        └───┬───────────┬───┘        └─────────────────────┘
            │           │
   ┌────────▼──┐   ┌────▼──────┐
   │ SQUAD LEAD│   │ COUNCIL   │  ← convened ad hoc by Orchestrator or Head
   │ role: lead│   │ (experts) │    for consequential / ambiguous decisions
   └────┬──────┘   └────┬──────┘
        │               │ positions & arguments
   ┌────▼──────┐        │
   │ WORKERS   │        │
   │ (swarm)   │        │
   └───────────┘        │
                        ▼
                 ┌──────────────┐
                 │ DECIDER      │  ← issues the Decision Record (binding)
                 │ role: decider│
                 └──────────────┘
```

**The Captain** is the one seat above the org: the human who owns this deployment. The
Captain speaks through the **command desk** (ADR 0012) — natural language in, real actions
out, every turn an event on the record. What lands reaches the floor through the
orchestrator as attributed `CAPTAIN DIRECTIVES` (binding); ideas are weighed; questions are
answered and never reach task prompts. Engine seats — the orchestrator, the CEO, the chair
and the board — cannot be dismissed from the desk; that call belongs to the board.

### The executive tier (functions)

Between the orchestrator and the department heads sit optional **function chiefs**
(ADR 0008): one C-role per *function* — a group of departments that share an executive
concern.

| Function | C-role | Departments (by category) |
|----------|--------|---------------------------|
| Technology | `cto` | engineering, data, security |
| Market | `cmo` | research, business |
| Product | `cpo` | design, content, media |
| Operations | `coo` | org, meta |

A chief is hired by the orchestrator when a function reaches **two active departments**;
those departments' heads then report to the chief, and the chain reads
`orchestrator → chief → head → lead → worker`. One chief per function at a time. The
chief chairs the function's councils and arbitration; it does not do IC work.

### The company layer (ADR 0009) and governance (ADR 0011)

Above projects sits the optional **company**: a project with `kind='company'` whose
agents are the **CEO** (hired at bootstrap) and, on demand, the same function chiefs one
scope up (`cto`/`cmo`/`cpo`/`coo`/`cfo`). A member project's orchestrator reports to the
CEO; `company.review()` reads every member's books and writes one grounded directive
into each member's event stream, and orchestrators read directives into their task
prompts as binding work — "COMPANY DIRECTIVES (from the board)".

Seated with the CEO are the **board of directors**: a `chair` (the CEO's manager) and
two `board_member` seats (`projects.settings.chair_id` / `board_ids`). The chain reads
`chair → CEO → orchestrator → chief? → head → lead → worker`. The board convenes
sessions on the council machinery (`board.convened`) and its caps are deliberately
narrow: it reads, convenes, binds and asks for money — it never hires into the org it
governs. **Money between projects is a decision**: `company.portfolio()` ranks members
by their record (shared verdict helper with the review) and `company.allocate()` writes
the caps — a `stop` project's cap lands exactly on its spend, so "no new money" is
enforceable, and `company.allocation.decided` carries every line with its basis. The
whole company renders on one floor (`GET /companies/{id}/hq`): executive suites, the
board room, one pod per member project with its teams.

### Authority matrix

| Action | Orchestrator | Head | Lead | Worker | Decider |
|--------|:---:|:---:|:---:|:---:|:---:|
| Create/close department | ✅ | – | – | – | – |
| Hire/fire agents | ✅ (any) | ✅ (own dept) | propose | – | – |
| Allocate budget | ✅ | ✅ (within envelope) | request | – | – |
| Create tasks in a dept | ✅ | ✅ | within squad | – | – |
| Execute a task | – | – | ✅ | ✅ | – |
| Reassign a task | ✅ | ✅ | own squad | – | – |
| Convene council | ✅ | ✅ (own scope) | – | – | – |
| Bind a decision | – | – | – | – | ✅ |
| Override a decision | ✅ (logged, reason required) | – | – | – | – |
| Request human approval | ✅ | ✅ | ✅ | ✅ | ✅ |
| Terminate a run | ✅ | own dept | own squad | – | – |

Everything in the matrix is enforced in `control/org.py` + `core/policy.py`, not by prompt
text. Prompts express the *intent*; the policy engine expresses the *law*.

## 3. Roles (canonical set)

| Role | Purpose | Typical grade | Model tier |
|------|---------|---------------|-----------|
| `orchestrator` | Executive: decompose goals, hire, arbitrate, settle rewards | Principal | reasoning |
| `ceo` | Executive: the portfolio — which projects run, at what budget, what stops | Chief | reasoning |
| `chair` | Governance: chairs the board of directors; the CEO's manager | Chief | reasoning |
| `board_member` | Governance: an owners' seat — challenges direction, votes the record | Chief | reasoning |
| `cfo` | Executive: the money function — envelopes, allocation truth, the ledger | Chief | reasoning |
| `cto` | Executive: the technology function (engineering, data, security) | Chief | reasoning |
| `cmo` | Executive: the market function (research, business) | Chief | reasoning |
| `cpo` | Executive: the product function (design, content, media) | Chief | reasoning |
| `coo` | Executive: the operations function (org, meta) | Chief | reasoning |
| `head` | Department manager: staffing, planning within domain, quality bar | Senior | reasoning |
| `lead` | Squad manager: sequencing, unblocking, integration | Senior | standard |
| `worker` | Does the work with tools | Junior→Senior | fast/standard |
| `specialist` | Deep domain expert (e.g. `security`, `finance`, `legal`, `data`) | Senior | reasoning |
| `critic` | Adversarial reviewer: finds flaws, red-teams outputs | Senior | reasoning |
| `analyst` | Research, evidence gathering, synthesis | Mid | standard |
| `architect` | Designs structure/approach, owns interfaces | Principal | reasoning |
| `decider` | Final binding ruling on a contested decision | Principal→Chief | reasoning |
| `evaluator` | Scores results independently (never the producer) | Senior | standard |
| `librarian` | Curates brains, promotes insight, prunes memory | Mid | fast |

Roles are templates; a role has a **capability profile** (list of skill ids) rather than a
hard-coded prompt. Role specs live in `backend/src/crew/domain/roles.py` and are data so the
HiringService can compose new ones (see §5).

## 4. Skills & capability matching

- **Skill** = a normalized capability id (`python`, `web-research`, `sql-design`,
  `video-editing`, `prompt-engineering`, `unit-testing`, `security-review`, …) with a
  description and the tool grants normally needed to exercise it.
- `skills` table holds the catalog; `agent_skills` holds per-agent proficiency
  (`0..1`, seeded on hire, updated by reward events — skill-specific scores).
- Every task carries `required_skills[]` with weights. Covering a task requires:
  `Σ (w_s × min(1, best available proficiency)) ≥ coverage_threshold` (default 0.75).
- Uncovered requirement → **capability gap** → hiring event.

## 5. How new units are born (the "self-organizing" mechanism)

Trigger: a task (or the goal itself) has a capability gap or a size gap (`estimated_effort`
above a squad's capacity), **or** the Orchestrator's plan names a function that does not
exist in the org.

```
gap detected
  ├─ matching skill exists in an existing department?
  │     └─ yes → transfer/reuse agent, or add a worker to that department
  ├─ no department covers the skill, but the skill is a variant of one that does?
  │     └─ yes → create SQUAD inside that department, staff it with a new role spec
  └─ the skill belongs to a new function entirely
        └─ create DEPARTMENT (mission, budget envelope, tool grants)
             └─ hire HEAD (grade >= Senior, reasoning tier)
                  └─ Head drafts the department mission charter + first squad
                       └─ Orchestrator approves (auto-approve if under threshold)
```

Guardrails on spawning (all enforced in code, see docs/08):
- `max_agents_per_project` (default 24) and `max_departments` (default 6).
- Each hire costs budget; a hire that would breach the project envelope is refused and the
  Orchestrator must re-plan with what it has (or ask the user).
- New agents start at the **lowest grade that can plausibly do the job** (`Trainee`/`Junior`)
  with `autonomy_level = supervised` and cheap models — promotion is earned (docs/05). This
  keeps the cost curve sane and makes the reward system load-bearing.
- Anti-thrash: a hire is rejected if an identical role spec was laid off in the last N events
  without materially different requirements.
- Every spawn emits `org.unit.created` + `audit` entry with the gap that justified it.

## 6. Council & decision protocol

Convened when **any** of: the Orchestrator flags a decision as consequential
(`impact ≥ high`), the council policy threshold in project settings matches, two departments
disagree, a task has failed twice, or a human asks for a debate.

```
1. QUESTION    CouncilService turns the issue into: question, options (≥2), decision
               criteria, constraints, deadline (rounds), and the evidence pack (brain hits).
2. INVITE      Panel of 3–5 specialists chosen by relevance (skill overlap with question),
               ensuring at least one `critic` and one `specialist` unrelated to the proposer
               (independence). Members may be pulled from any department.
3. ROUNDS      Each member writes a position: claim, reasoning, evidence, risks, confidence.
               Round 2 must address the strongest counter-argument (round-robin critique).
               Bounded: max 3 rounds, max N tokens, then forced decision.
4. DECIDER     The highest-reputation eligible `decider` (never a round-1 advocate of the
               winning option unless it is the only decider) reviews positions and issues a
               Decision Record: chosen option, rationale, dissents preserved, confidence,
               reversibility, follow-up checks.
5. BIND        Decision becomes a constraint for planning; tasks referencing it link to it.
               Overriding is possible only for the Orchestrator or the user, with a reason.
```

`DecisionRecord` is stored with all positions; the UI shows the debate transcript
(docs/09). Decisions are retrieved as authoritative context by the brains (docs/06).

## 7. Promotion, demotion, layoff

| Transition | Trigger | Effect |
|-----------|---------|--------|
| Promote | EWMA score ≥ threshold for grade, ≥ min sample size, no active penalties | Grade ↑, model tier ↑, budget cap ↑, autonomy ↑ |
| Probation | score drop below floor, or a policy violation | Autonomy ↓ to supervised, spend cap halved |
| Demote | sustained probation without recovery | Grade ↓, model tier ↓ |
| Lay off | `idle` beyond `layoff_after` and no role need, or repeated failure | Archived, brain retained read-only, skills returned to catalog |
| Rehire | new gap matches an archived agent with high score | Revive archived row (history preserved) |

Scores, grades and their thresholds are specified in docs/05; the org consequences of a
transition are implemented in `control/org.py::apply_grade_transition`.

## 8. Org chart projection

`GET /api/projects/{id}/org` returns the tree with per-unit live stats (status, score, cost,
open tasks, model tier). The UI renders it as an interactive chart; clicking a node opens
that unit's own view. The projection is rebuilt from tables + the last N events, never from
in-memory state, so it survives restarts.
