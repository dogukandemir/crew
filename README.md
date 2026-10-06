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
# backend
cd backend
uv sync
cp ../.env.example .env          # fill in your provider keys
uv run uvicorn crew.api.main:app --reload --port 8787

# frontend
cd frontend
npm install
npm run dev                      # http://localhost:5173
```

## Status

See [docs/12-implementation-plan.md](docs/12-implementation-plan.md) for the current
milestone. Milestone state is tracked there, not in this README.
