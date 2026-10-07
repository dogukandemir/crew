# Crew — Autonomous Agent Organization Platform

Crew is a platform for running **self-organizing crews of AI agents** across multiple
independent projects. Each project is a tab in the UI, owns its own org chart, budget,
memory ("brain") and task queue, and grows its own departments and agent swarms on demand
to achieve the goals you give it.

Execution of individual AI work is delegated to [CrewAI](https://crewai.com) (agents, tasks,
crews, flows). Crew adds the layers above it: the **organization**, the **command chain**,
the **reward system**, the **memory hierarchy**, **security governance** and **observability**.

## Repository layout

```
backend/          Python 3.12 · FastAPI · SQLAlchemy · CrewAI execution engine
frontend/         React 19 · TypeScript · Vite · tabbed control room
docs/             Refinement documentation (read this first)
docs/adr/         Architecture Decision Records
dev/mock/         Zero-dependency API mock — the UI and the office, with no backend and no keys
scripts/          Dev/ops helpers
```

## Read the docs in order

| # | Document | What it settles |
|---|----------|-----------------|
| — | [docs/README.md](docs/README.md) | Index and reading order |
| 00 | [Vision & Scope](docs/00-vision-and-scope.md) | What we build, what we explicitly do not |
| 01 | [System Architecture](docs/01-system-architecture.md) | Components, layers, tech stack, runtime |
| 02 | [Organization & Command Chain](docs/02-organization-and-command-chain.md) | Project/Department/Squad/Agent, authority, spawning |
| 03 | [Orchestration & Lifecycle](docs/03-orchestration-and-lifecycle.md) | From goal to execution to termination |
| 04 | [Agent Model & Skills](docs/04-agent-model-and-skills.md) | Roles, skills, tools, model routing |
| 05 | [Reward & Performance](docs/05-reward-and-performance.md) | Scoring, promotion, anti-gaming |
| 06 | [Memory & Brains](docs/06-memory-and-brains.md) | Three-level brain, promotion of insight |
| 07 | [Observability](docs/07-observability.md) | Events, traces, live views, replay |
| 08 | [Security & Governance](docs/08-security-and-governance.md) | Auth, secrets, sandbox, egress, budgets |
| 09 | [UI/UX Spec](docs/09-ui-ux-spec.md) | Tabs, views, control surfaces |
| 10 | [Data Model](docs/10-data-model.md) | Tables and invariants |
| 11 | [API & Event Contract](docs/11-api-and-event-contract.md) | REST + WebSocket message shapes |
| 12 | [Implementation Plan](docs/12-implementation-plan.md) | Milestones M0–M10 and exit criteria |

## Quick start (dev)

```bash
# 1. backend  (API + orchestrator; serves the REST contract and the event socket)
cd backend
uv sync
cp ../.env.example .env          # add ONE provider key for real agent runs
uv run python -m crew serve      # http://127.0.0.1:8787  (docs at /docs)

# 2. frontend (tabbed control room)
cd ../frontend
npm install
npm run dev                      # http://localhost:5173

# 3. optional: same pipeline with zero spend and zero keys (deterministic fake runner)
CREW_OFFLINE_LLM=true uv run python -m crew serve
```

### Fastest possible look: the mock, no backend and no keys

If you only want to see the control room and the office — no Python, no provider keys, no
spend — run the API mock instead of the backend:

```bash
node dev/mock/server.mjs                                  # http://127.0.0.1:8788
cd frontend && echo 'VITE_API_BASE=http://127.0.0.1:8788' > .env.local && npm run dev
```

Open the project and the office floor: the organization grows on its own while you watch
(a hire at t+12, a whole new department at t+30). See [dev/mock/README.md](dev/mock/README.md)
for what it does and does not promise.

Useful commands:

```bash
uv run pytest                    # 54 tests, no network required
uv run pytest -m live -s         # real provider run (needs a key; costs a few cents)
uv run ruff check src tests
uv run python -m crew status     # env, data dir, model tiers, sandbox mode
uv run python -m crew audit verify
```

Configure a project you want to try end to end:

1. Create a project (UI tab, or `POST /api/projects`).
2. State a goal: `POST /api/projects/{id}/runs {"goal": "...", "mode": "autonomous"}`.
3. Watch the tabs: **Org** (it hires itself), **Tasks**, **Agents** (live timelines),
   **Reward** (score changes), **Events** (the raw stream).

Read [docs/13](docs/13-backend-implementation-notes.md) before changing code: it lists what is
implemented, what is deliberately stubbed, and the bugs already found and fixed.

## Status

See [docs/12-implementation-plan.md](docs/12-implementation-plan.md) for the current
milestone. Milestone state is tracked there, not in this README.
