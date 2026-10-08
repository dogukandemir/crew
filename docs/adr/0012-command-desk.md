# 0012 — The command desk: the Captain speaks, the orchestrator answers

Status: accepted · Supersedes: — · Relates to: 0009 (the company), 0010 (the board),
0011 (the board of directors)

## Context

The owner wants to *direct the company* — assign work, move it, fire, give breaks,
set goals and budgets — by writing plain sentences into a chat pane on the right of
the workspace, tagging agents by name. Two design questions dominated the refinement:

1. **God effect or direct command?** The owner asked explicitly. A god effect (the
   message arriving as the agent's own inner voice, or as formless inspiration) was
   rejected: it fabricates provenance, pollutes the record, and breaks the chain of
   responsibility — a direct violation of the system's "never lie" constraint. The
   decision is **direct, attributed instruction**: the channel is
   *you → the orchestrator (which parses and frames) → the command chain → the agent*,
   and the agent always knows who spoke.
2. **What is the owner called?** One term, every language, no translation drift:
   **the Captain**. Machined into the product (not a localized label): prompt block,
   event payloads, UI badge, glossary.

The "godlike feel" is delivered honestly instead: three **modes** — an `order`, an
`idea`, a `question` — a first-class `CAPTAIN DIRECTIVES` block in prompts, and a
stage/desk presence in the UI. A future note: the agent's *inner voice* (its own
reflection) will be a separate strip; Captain messages never mix into it.

## Decision

### One channel, fully recorded

`POST /api/projects/{id}/commands {text}` → parse → execute → reply.
`GET /api/projects/{id}/commands` → the transcript. Every turn is an event on the
project's record (`command.message`, `command.reply`); the drawer renders the record,
not a client-side chat log. Actor: `user:{id}` for the message, `system:orchestrator`
for the reply.

### Deterministic first, model second

A lexicon parser (Turkish and English) turns the message into a typed command:
`status | assign | reassign | fire | break | goal | budget | hire | help`, with
mentions resolved against the live roster and quantities (`15 dakika`, `%20`, `25$`)
extracted. Only when confidence is low **and** a provider key is configured does the
orchestrator's model interpret the text — into the same strict schema, validated
against the roster. Offline, the desk says what it can and cannot carry out; it never
guesses a destructive act.

### Modes: orders bind, ideas are weighed, questions are answered

- `order` (default) — reaches the agent's next prompt as a **binding** line under
  `CAPTAIN DIRECTIVES (from the Captain — this company's owner)`.
- `idea` (a "fikrim var:…" or "maybe…", in either language) — the same block, labeled
  as something to weigh.
- `question` (a question mark) — answered by the desk; **never** enters a task prompt.

A directed message (`@Ada …`) reaches only its addressee; an undirected one reaches
the floor. Window: last 6 hours, at most 3 lines, newest first.

### Actions are real service calls

| Intent | Runs on |
|---|---|
| assign | `Task` created (`run_id=null`): tagged → state `assigned`; untagged → `pending`, matched at the next wave by the existing engine |
| reassign | the old owner's latest open task moves; the old owner is freed (`busy → idle`); `task.reassigned` |
| fire | `org.layoff_agent` (audited archive). Engine seats — orchestrator, CEO, chair, board members — **refuse**; that decision belongs to the board |
| break | `agents.break_until = now + minutes` (default 10, cap 120; "herkese" = everyone except the engine); matching skips the agent until it passes — **work already in their hands finishes first**; "molayı kaldır"/"end the breaks" clears, targeting whoever is on one |
| goal | `orchestrator.start_run` |
| budget | the cap only (`budget_cap_micros`); what is spent stays spent; audited |
| hire | `org.hire_agent` from the closest role template (analyst/engineer/researcher/designer/writer) |

`Agent.break_until` is a new nullable column (added by `_add_missing_columns`).
Consequence for v1, stated honestly: a break gates **matching**; an already-handed
task is not interrupted, and a direct Captain assignment overrides it (the reply says
so).

## Consequences

- `control/commands.py` (parser + executors + transcript), two routes, four event
  types, the `CommandDrawer` (roster from leaderboard ∪ org tree, @-autocomplete,
  live mode preview, action chips citing the events), mock routes, tests
  (backend 15, frontend 10).
- The transcript is honest by construction: a refused or failed action replies
  "I couldn't carry that out: …" and is recorded as such (`ok=false`).
- Deferred deliberately: the agents' "inner voice" strip; streamed (SSE) replies —
  the drawer polls at 5s while open.
