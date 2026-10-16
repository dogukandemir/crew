# 00: Vision & Scope

## 1. One-paragraph vision

Crew is a **company simulator for autonomous AI work**. You open a tab, name a project, and
state a goal. A top-level orchestrator agent analyses the goal, works out which skills are
required, and, because the people it needs do not exist yet, **hires them**: it creates
departments, squads and individual agents with the right roles, tools and models. The
resulting organization executes the work, debates the hard decisions, picks a solution
through a designated senior decider, verifies the result, and **pays out rewards** that
determine each agent's reputation, budget and autonomy for the next round. You watch all of
it live, by project, by department, by individual agent, and you can interrupt, steer,
approve or kill anything at any time. You are **the Captain**, the deployment's owner,
and your word travels the chain through the command desk (ADR 0012) as attributed orders,
ideas and questions.

## 2. The five things that make this different

1. **The org chart is a runtime artifact.** Departments and agents are not hard-coded
   configuration; they are generated from the goal's capability requirements, and they can
   be dissolved or rebuilt as the project's needs change.
2. **A real command chain.** Authority is explicit: an executive orchestrator allocates
   budget and arbitrates; department heads own their backlog and their people; leads run
   squads; workers execute. Escalation and delegation both follow the chain.
3. **Rewards with teeth.** Agents are scored on verified outcomes, cost efficiency and
   quality. Reputation is not decoration: it gates model tier, spend limits, autonomy level
   and promotion into senior roles (including the decider role).
4. **Three-level cognition.** Project brain, department brain, agent brain, separate memory
   scopes with controlled read/write and upward "insight promotion", so the org gets smarter
   without every agent drowning in every other agent's context.
5. **Observability as a first-class feature.** Every thought, tool call, token and dollar is
   an event in an append-only log. You can watch live, filter by unit, and replay history
   like a video.

## 3. Primary user stories

| ID | Story | Satisfied by |
|----|-------|--------------|
| US-1 | I create a project, give it a goal, and see an org chart form itself | 02, 03, 09 |
| US-2 | I run several projects at once, each in its own tab, and switch freely | 09 |
| US-3 | I watch a single agent's reasoning, tool calls and cost as it works | 07, 09 |
| US-4 | I watch a whole department's backlog, roster and KPIs | 07, 09 |
| US-5 | I inject a message into a running crew (steering) | 03, 09 |
| US-6 | I see which agents earned rewards and who got promoted | 05 |
| US-7 | I cap a project's spend and it physically cannot exceed it | 08 |
| US-8 | I see exactly what the org decided and why (decision records) | 03 |
| US-9 | I can replay yesterday's run and see where it went wrong | 07 |
| US-10 | I can stop everything with one control | 08, 09 |

## 4. Scope boundary

**In scope (v1):** multi-project management; dynamic org generation; CrewAI-backed
execution; council deliberation + decision records; reward/grade system; three-level memory;
event log with live WebSocket views and replay; local single-user auth with token mode;
secret vault; capability-based tool policy; sandboxed code/shell execution; egress allowlist;
budget guardrails; React tabbed control room.

**Deliberately out of scope (v1):** multi-tenant SaaS/hosting; billing and payment; mobile
app; agent-to-agent marketplaces; training/fine-tuning models; native desktop packaging;
automatic publishing to third-party social accounts (a tool can be added later under the
approval policy); replacing CrewAI's internals.

**Out of scope but designed for:** Postgres + Redis horizontal scale, OIDC/SSO, remote
worker fleet. The interfaces (event bus, repository layer, tool policy) are shaped so these
are swaps, not rewrites, see ADR 0003/0004.

## 5. Success criteria for v1

- A goal can be stated, an org formed, work executed end-to-end by real LLM agents, and the
  result verified, with no manual agent authoring by the user.
- Every state change visible in the UI within 1s of occurring.
- Zero project can exceed its configured budget (hard-enforced, tested).
- No secret is ever visible to an agent's context or stored in plaintext.
- Full run of a project can be replayed event-by-event from the log.
- An agent's promotion changes its model tier and spend limit automatically.

## 6. Vocabulary (used consistently everywhere in this repo)

| Term | Meaning |
|------|---------|
| **Project** | Isolated tenant of work with its own goal, org, brains, budget, policies. One UI tab. |
| **Org unit** | Any node of the org tree: project, department, squad, agent. |
| **Department** | Persistent functional unit (Research, Engineering, QA, …) with a Head agent. |
| **Squad / swarm** | A team inside a department working one workstream; has a Lead; disbandable. |
| **Agent** | One CrewAI `Agent` with a role spec, skills, tools, model tier, memory, score. |
| **Orchestrator** | The executive agent owning the project's plan, budget and arbitration. |
| **Council** | Ad-hoc panel of specialist agents convened to debate a consequential decision. |
| **Decider** | The single senior agent (or rotating senior) who issues the final Decision Record. |
| **Goal** | User-supplied objective at project level. |
| **Task** | Unit of executable work; node in the task DAG; executed by an agent or a squad. |
| **Reward event** | An immutable scored outcome attached to an agent/task. |
| **Brain** | A scoped memory store (project/department/agent). |
| **Event** | Append-only domain record that drives UI, replay and audit. |
| **Trace** | Span tree linking goal → plan → task → tool call → LLM call. |
