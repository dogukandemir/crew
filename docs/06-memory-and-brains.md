# 06 — Memory & Brains

Four brains, four scopes, one retrieval interface. The point is that an agent sees *enough*
context to act well and not so much that it is slow, expensive or confused.

## 1. The four levels

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ COMPANY BRAIN  (scope: company — ADR 0015)                                    │
│ Mission · portfolio review lessons · allocation decisions · company policy    │
│ The umbrella: retrieved by EVERY member project's agents (brain-id scoped)    │
│ Readers: every member's agents    Writers: the company's CEO / board chair     │
└───────────────▲──────────────────────────────────────────────────────────────┘
                │ one directive written once reaches the whole portfolio
┌───────────────┴──────────────────────────────────────────────────────────────┐
│ PROJECT BRAIN  (scope: project)                                              │
│ Goals & success criteria · constraints · standing policies · decision log     │
│ org history (who was hired/fired and why) · KPI rollups · cross-dept patterns │
│ Readers: Orchestrator, Heads, Decider      Writers: Orchestrator, Librarian    │
└───────────────▲──────────────────────────────────────────────────────────────┘
                │ promotion (insight that matters beyond one department)
┌───────────────┴──────────────────────────────────────────────────────────────┐
│ DEPARTMENT BRAIN  (scope: department)                                        │
│ Domain playbooks · proven procedures · tool recipes · past solutions & their  │
│ outcomes · domain glossary · recurring pitfalls · quality bar for the domain  │
│ Readers: dept members + council invitees    Writers: Head, Lead, Librarian     │
└───────────────▲──────────────────────────────────────────────────────────────┘
                │ promotion (procedure that worked, generalized)
┌───────────────┴──────────────────────────────────────────────────────────────┐
│ AGENT BRAIN  (scope: agent)                                                  │
│ Episodic memory (what I did, what happened) · working set (current task) ·     │
│ personal heuristics · self-critique notes · skill evidence                    │
│ Readers: that agent only                Writers: that agent, Librarian (curate)│
└──────────────────────────────────────────────────────────────────────────────┘
```

**Scoping rules (enforced in `BrainService`, not by prompts)**
- Read: own brain always; department brain if member; project brain if `project-memory.read`
  granted (executives) or if the entry is marked `public` (policies, glossary, decisions);
  the company brain of the project's parent company (the umbrella).
- Write: own brain always; department brain if role ≥ lead; project brain only
  Orchestrator/Librarian; company brain only the company's own CEO/chair. Retrieval is
  scoped by brain id — a member project finds the company brain's entries even though they
  live on the company's row (ADR 0015).
- The council is special: while a debate is open, the panel gets read access to a
  **shared evidence pack** (snapshot, not live memory) so debate is fair and reproducible.

## 2. Memory entry model

```
BrainEntry
├─ id, brain_id (scope), kind: fact | procedure | decision | artifact_ref | lesson | glossary
├─ title, body (markdown), structured payload (optional JSON)
├─ source: run_id?, task_id?, agent_id?, url?      ← provenance is mandatory
├─ trust: internal | verified | unverified | untrusted_external
├─ importance: 0..1 (set at write, adjustable by use/feedback)
├─ tags[], skill_ids[], department_id?
├─ embedding (vector), created_at, last_used_at, use_count, decay_score
└─ superseded_by? (never delete — supersede)
```

Retrieval score (hybrid, inspired by generative-agent memory streams):

```
score = 0.55·similarity(q, entry)      # vector, top-k 50 candidates
      + 0.25·recency(entry)            # exp decay, half-life 14 days
      + 0.15·importance(entry)
      + 0.05·usage(entry)              # use_count evidence it helps
      − penalty(untrusted_external)    # external content ranks lower and is marked
```

`top_k` default 8 for workers, 12 for leads/heads, 20 for the Orchestrator and councils, and
each tier has a token budget so retrieval can never blow the step budget. Results are
deduplicated, compressed to bullets (a `fast`-tier summarizer when the pack exceeds budget),
and always rendered **with provenance and trust labels**.

## 3. Working memory vs. long-term

- **Working set**: per task, bounded, explicit — the task, its inputs by reference, assigned
  brain pack, recent tool results (sliding window), the current plan slice. Dropped when the
  task ends, except for a summary that is written to the agent brain.
- **Long-term**: everything in the tables + vectors; never truncated, only decayed in
  ranking and superseded in content.
- Conversation history inside a crew is *not* memory: it dies with the crew. What survives is
  what an agent explicitly writes (`brain.write`) or what the run's summarizer extracts.

## 4. Insight promotion (how the org gets smarter)

Run by the Librarian agent at the LEARNING stage and on demand:

1. **Collect** — task outcomes, verifications, retries, escalations, decision records.
2. **Extract** — candidate lessons: "X worked for Y because Z" / "X failed because Z";
   each candidate must cite the events it came from.
3. **Score** — is it generalizable? does it contradict an existing entry? does it have ≥2
   independent instances? (single-instance lessons stay in the agent brain).
4. **Place** — agent → department → project, one level at a time. Promotion upward requires
   either a second department independently producing the same lesson, or a Head's explicit
   endorsement, or a Decision Record.
5. **Reconcile** — conflicting entries are marked `superseded_by` (never deleted) with a note
   on why the new one wins; the old one remains visible in history.
6. **Prune** — entries with `use_count = 0` and low importance past their decay window are
   archived (not deleted) and excluded from retrieval, keeping retrieval quality high.

Every promotion emits an event and is visible in the UI (brain activity panel), so you can
audit *why the org now believes something*.

## 5. Implementation

| Concern | Dev | Prod |
|---------|-----|------|
| Store | SQLite table `brain_entries` | Postgres |
| Vectors | `sqlite-vec` extension (fallback: in-process cosine over ≤5k rows) | `pgvector` (HNSW) |
| Keyword | SQLite FTS5 | Postgres `tsvector` |
| Embeddings | provider via `CREW_TIER_EMBED` | same |
| Cache | in-process LRU keyed by `(brain_id, query_hash)` | Redis |

`BrainService` API (used by tools and control plane):

```python
search(brain_ids, query, top_k, kinds=None, skill_ids=None, token_budget=...) -> list[BrainEntry]
write(brain_id, entry, actor_agent_id) -> BrainEntry          # scope-checked, audited
promote(entry_id, to_brain_id, actor_agent_id) -> BrainEntry  # requires rights + rationale
supersede(old_id, new_id, reason) -> None
summarize_working_set(task_id) -> BrainEntry                  # task-end distillation
export(project_id) / import(...)                              # portability, backups
```

## 6. Why not just one big vector store?

Because context is the scarcest resource in an agent org. Separate scopes give:
- **cheaper** steps (workers retrieve 8 items, not the project's whole history),
- **less contamination** (a Research agent's speculation must not become an Engineering
  agent's fact — trust labels and scopes keep them apart),
- **auditability** (you can point at the exact memory that caused a decision),
- **governance** (deleting/archiving a department's brain is a one-scope operation).

## 7. Retention

- Agent brains of archived agents: retained read-only (they are evidence).
- Decision records: retained forever (they are the org's legal memory).
- Raw events: retained per project setting (`events.retention_days`, default: forever in
  dev; 90 days plus monthly rollups in prod).
- Embeddings are recomputable from bodies at any time (`crew brains reindex`), so the vector
  index is disposable state.
