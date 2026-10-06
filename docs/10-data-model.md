# 10 — Data Model

SQLAlchemy 2.x declarative, async. SQLite in dev (WAL), Postgres in prod. All ids are
`uuid7` strings (sortable). All timestamps UTC. Money = `cost_micros` BIGINT (1 USD = 1e6).

## 1. Entities & relationships

```
projects ─┬─< project_settings (1:1)
          ├─< runs ──< tasks ──< task_deps (self, M:N)
          │             └─< jobs
          ├─< departments ──< squads ──< squad_members >── agents
          ├─< agents ──< agent_skills >── skills
          ├─< brains ──< brain_entries ──< brain_links (supersede/promote)
          ├─< decisions ──< council_sessions ──< council_positions
          ├─< reward_events
          ├─< verification_results
          ├─< artifacts
          ├─< events (append-only, seq per project)
          ├─< budget_ledger
          ├─< approvals
          └─< audit_log (hash-chained)
users ──< sessions         secrets ──< secret_leases
```

## 2. Key tables

### projects
`id, name, slug, goal, description, status(active|paused|archived|failed), stage, created_at,
updated_at, archived_at, owner_id, budget_cap_micros, spend_micros, currency, tags[]`

### project_settings (1:1, JSON columns for extensibility)
`project_id, autonomous_intake(bool), require_goal_confirmation(bool),
require_human_verification(bool), max_agents(int), max_departments(int),
max_senior_ratio(float), auto_hire(bool), layoff_idle_days(int),
reward_weights(json), council_policy(json), egress_allow(json),
tool_policy(json), model_tiers(json), retention(json), notify(json)`

### departments
`id, project_id, name, mission, status(active|idle|archived), head_agent_id,
budget_envelope_micros, spend_micros, capabilities(json), brain_id, created_at, archived_at,
charter(json)`

### squads
`id, project_id, department_id, name, mission, lead_agent_id, status, created_at, closed_at,
workstream, brain_scope_tags(json)`

### agents
`id, project_id, department_id, squad_id, manager_id, name, role, grade(int 0..5),
state(idle|busy|probation|suspended|archived), mission, responsibilities(json),
decision_style, autonomy(supervised|bounded|autonomous), model_tier, model_id,
token_cap_per_step, spend_cap_per_run_micros, spend_cap_per_day_micros, spend_today_micros,
score(float), score_confidence(float), evidence_count, success_rate, tasks_done, tasks_failed,
penalty_count, prompt_version, brain_id, tools(json), approval_rules(json), created_at,
archived_at, last_active_at`

### skills / agent_skills
`skills: id, label, category, description, typical_tools(json), verification_hints(json),
related(json)` — global catalog
`agent_skills: agent_id, skill_id, proficiency(float), evidence_count, last_used_at`

### runs
`id, project_id, goal, goal_brief(json), plan(json), stage, status(running|paused|completed|
failed|aborted), started_at, ended_at, trace_id, cost_micros, tokens_in, tokens_out,
triggered_by(user|schedule), report(json)`

### tasks
`id, run_id, project_id, department_id, squad_id, parent_id, title, description, deliverable,
required_skills(json), acceptance_criteria(json), depends_on(json), output_contract(json),
effort(S|M|L|XL), priority(int), state(pending|blocked|ready|assigned|running|verifying|
completed|failed|aborted|escalated), assignee_agent_id, assignee_squad_id, attempts,
cost_micros, tokens_in, tokens_out, result_ref, started_at, ended_at, escalated_to,
escalation_reason`

### jobs (execution bookkeeping)
`id, task_id, project_id, state(queued|running|suspended|done|failed|cancelled), attempt,
worker, heartbeat_at, cancel_requested(bool), error_class, error_message, started_at, ended_at`

### verification_results
`id, task_id, verdict(pass|pass_with_notes|fail|inconclusive), method(deterministic|contract|
evaluator|peer|human), checks(json), rubric(json), evidence(json), confidence(float),
verifier_agent_id, created_at`

### reward_events
`id, project_id, run_id, task_id, agent_id, role_in_task(producer|lead|head|verifier|
orchestrator), verdict, components(json), penalties(json), reward(float), score_after(float),
grade_before, grade_after, created_at`

### brains / brain_entries / brain_links
`brains: id, project_id, scope(project|department|agent), owner_id, created_at`
`brain_entries: id, brain_id, kind(fact|procedure|decision|artifact_ref|lesson|glossary),
title, body, payload(json), source(json: run_id/task_id/agent_id/url), trust, importance,
tags(json), skill_ids(json), embedding(blob/vector), created_at, last_used_at, use_count,
decay_score, superseded_by, archived_at, human_edited(bool)`
`brain_links: from_entry_id, to_entry_id, relation(promoted_to|supersedes|derived_from|
supports|contradicts)`

### council_sessions / council_positions
`council_sessions: id, project_id, task_id, question, options(json), criteria(json),
constraints(json), status(open|deciding|closed), rounds(int), max_rounds, convened_by,
convened_at, closed_at, decision_id`
`council_positions: id, session_id, round(int), agent_id, option_id, claim, reasoning,
evidence(json), risks(json), confidence(float), critique_of_position_id`

### decisions
`id, project_id, session_id, task_id, question, chosen_option, rationale, dissent(json),
confidence(float), reversibility(one_way|two_way), follow_ups(json), decider_agent_id,
created_at, overridden_by, override_reason`

### artifacts
`id, project_id, task_id, agent_id, kind(file|text|json|url|image), path, mime, bytes,
sha256, trust, created_at, meta(json)` + on-disk content under
`data/projects/<id>/artifacts/`

### events
`id, project_id, seq(bigint, unique with project_id), ts, type, severity, title, summary,
payload(json), department_id, squad_id, agent_id, task_id, run_id, job_id, trace_id, span_id,
parent_span_id, actor, cost_micros, tokens_in, tokens_out, duration_ms`
Indexes: `(project_id, seq)`, `(project_id, type, ts)`, `(agent_id, ts)`, `(trace_id, ts)`.

### budget_ledger
`id, project_id, scope_kind(project|department|agent), scope_id, kind(reserve|settle|release|
cap_change), amount_micros, ref(job_id|llm_event_id), ts, note, idempotency_key(unique)`

### approvals
`id, project_id, task_id, agent_id, capability, request(json), state(pending|granted|denied|
expired), decided_by, decided_at, expires_at, reason`

### audit_log
`id, seq, ts, actor_kind(user|agent|system), actor_id, action, resource_kind, resource_id,
outcome, reason, trace_id, prev_hash, hash`

### users / sessions / secrets / secret_leases
`users: id, email, name, password_hash(argon2id), role(admin|operator|viewer), created_at,
disabled_at`
`sessions: id, user_id, token_hash, issued_at, expires_at, revoked_at, ua, ip`
`secrets: id, name, scope_kind, scope_id, ciphertext, nonce, aad, sha256, created_at,
rotated_at, last_used_at`
`secret_leases: id, secret_id, agent_id, capability, issued_at, expires_at, uses, max_uses,
revoked_at`

## 3. Invariants (enforced by constraints + tests)

1. `events.seq` is strictly increasing per project; the pair `(project_id, seq)` is unique and
   allocated inside the same transaction as the append.
2. Append-only tables (`events`, `reward_events`, `audit_log`, `budget_ledger`,
   `verification_results`, `council_positions`, `brain_links`) have **no UPDATE/DELETE** paths
   in the repository layer; supersession replaces mutation.
3. A task's `depends_on` forms a DAG (checked in the Planner before insert).
4. `agents.department_id` is not null for non-archived agents; exactly one agent per project has
   `role='orchestrator'` and state != archived.
5. `budget_ledger` sums per scope must equal `spend_micros` (reconciled by a startup check).
6. Every `brain_entries` row has non-empty `source`.
7. Every table with `project_id` filters by it in the repository layer; cross-project queries
   are impossible by construction (repository requires a project scope argument).
8. Soft delete only: `archived_at`/`status` transitions, never row deletion (except `forget`).

## 4. Migrations & seeding

- Alembic, single head; `0001_initial` matches this document.
- Seed data: skill catalog, role templates, default project settings, baseline egress
  allowlist, model tier map. Seeding is idempotent (`crew db seed`).
- `create_all` is allowed only in tests and `CREW_ENV=dev`; prod requires migrations.

## 5. Retention & size control

| Table | Growth | Policy |
|-------|--------|--------|
| events | high (thousands per run) | keep forever in dev; prod: 90d then monthly rollups; payload compaction for `agent.thought` (headline + hash) |
| llm.* events | high | never store prompt/response bodies in `events`; bodies go to artifact store, referenced by hash (privacy + size) |
| brain_entries | medium | archived by decay rule, never deleted |
| jobs | medium | pruned when `state=done` and older than 30d |
| artifacts | disk | content-addressed (sha256), deduped, quota per project |
