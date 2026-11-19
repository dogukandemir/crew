# Crew: a playable control room for real AI agents

Give a company a goal. Watch its agents organize, use tools, produce files, and ask for approvals in an animated office.

[![CI](https://github.com/dogukandemir/crew/actions/workflows/ci.yml/badge.svg)](https://github.com/dogukandemir/crew/actions/workflows/ci.yml)
[![CodeQL](https://github.com/dogukandemir/crew/actions/workflows/codeql.yml/badge.svg)](https://github.com/dogukandemir/crew/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/dogukandemir/crew/badge)](https://securityscorecards.dev/viewer/?uri=github.com/dogukandemir/crew)
[![License: MIT](https://img.shields.io/badge/License-MIT-3da639.svg)](LICENSE)

**Experimental, local-first software.** Crew combines a game-like interface with a real [CrewAI](https://github.com/crewAIInc/crewAI) execution harness. It is for developers and builders exploring supervised agent companies. Agent output still needs human review. It is not a hosted multi-tenant service or a guarantee of autonomous business success.

**Short on time?** The screenshot above, the [What is real?](#what-is-real) table and one
`docker compose up --build` are the whole story.

### At a glance

- **Execution engine:** CrewAI: planning, hiring, tasks and tool calls are real records; the office is a view of the same events.
- **Providers:** DeepSeek (shipped default), OpenAI, Anthropic, OpenRouter, or local Ollama. Demo needs no key and spends nothing.
- **Runtime:** Python 3.13 backend, React 19 / Node 26 frontend, Docker for agent command execution, SQLite for state.
- **Distribution:** one `docker compose up --build`; both ports bind to loopback only.
- **License:** MIT. **Status:** experimental; one trusted workspace per installation.

![Crew's animated office](docs/assets/office.png)

## Try it

Install Docker Desktop with Linux containers, or Docker Engine 26+ with Compose. Run this from the repository root:

```sh
docker compose up --build
```

Open [the control room](http://localhost:5173). The first build downloads the agent runtime and container images; later starts reuse them. The API listens at `127.0.0.1:8787`. Both published ports are restricted to this computer.

1. Start in **Demo**. It uses deterministic simulated agents, makes no model requests, and incurs no provider usage charges.
2. Choose **Found your company**, select a template, and review the goal and spending caps. The first run starts only if you select its checkbox.
3. Open the project's office, tasks, and deliverables. Demo files are labelled simulated.
4. For real work, choose **Configure provider**, connect a provider, then explicitly **Enable Live**. Saving a key alone does not enable Live.
5. Give the first Live run a small, checkable goal, such as the [first-project recipe](docs/FIRST-PROJECT.md). Review actual files and verification results before using them.

Stop the app with `docker compose stop`. Resume with `docker compose up -d`. Named volumes preserve the database, encrypted vault, and project files. `docker compose down` also keeps volumes; adding `--volumes` deletes them.

To put Crew on a server, use the [VPS deployment guide](deploy/vps/README.md): one command installs the production stack on Ubuntu 24.04 (a DigitalOcean Droplet is the worked example) with Caddy automatic HTTPS, UFW and a nightly backup.

## What is real?

| Capability | Demo | Live |
|---|---|---|
| Company, projects, tasks and event history | Real saved records | Real saved records |
| Agent reasoning and planning | Simulated | Your selected model provider |
| Deliverable files | Labelled sample output | Files actually created by agents |
| Shell / Python tools | Not used by the simulated runner | Disposable Docker containers |
| Model spend | Zero | Estimated from token usage and a price table |
| Verification | Simulation checks | Artifact integrity, declared contracts and model review |
| Office movement | Visualization of application state | Visualization of application state |

The office makes work visible; the saved task, tool and artifact records are the source of truth. Rewards are internal scores, not money paid to agents. A successful verifier result does not replace a human quality or security review.

See [a verified DeepSeek example](examples/temperature-converter/PROVENANCE.md): actual source files, ten passing tests and the captured execution report. Its provenance records the repairs, operator approval and cumulative cost needed to complete the workflow.

<p>
  <img src="docs/assets/command-desk.png" width="32%" alt="The command desk: the Captain writes an order, the orchestrator answers with the actions it took">
  <img src="docs/assets/hq.png" width="32%" alt="The company floor: a live board session, one pod per product">
  <img src="docs/assets/portfolio.png" width="32%" alt="The portfolio: products with health verdicts, budget envelopes and directives">
</p>

## How it works

```
 goal ─▶ plan ─▶ staff ─▶ execute ─▶ verify ─▶ reward ─▶ files in the workspace
                  │           │
                  │           └─ approval + budget gates, one human decision per gate
                  └─ hiring goes through HR: interviews, rejections, a bounded ladder

 every step is a persisted event ─▶ the office renders that same stream
```

Nothing on the floor is invented for the camera: the plan, each hire, every tool call, each
approval, the verifier's verdict and the reward are records first and pixels second. Files written
into the project workspace are recorded as artifacts with their hash, and the verifier reads those
artifacts rather than the agent's own summary.

## Repository layout

| Path | What lives there |
|---|---|
| `backend/` | FastAPI API, orchestrator, CrewAI execution and the sandbox broker (Python 3.13) |
| `frontend/` | React 19 + TypeScript control room and the 2.5D office |
| `docs/` | 18 numbered specs, 19 ADRs, deployment, support and review notes |
| `dev/mock/` | A standalone demo backend for UI work — no provider, no cost |
| `examples/` | One verified end-to-end run, with provenance and its tests |
| `scripts/` | `backup.sh` and `restore.sh` for a host installation |
| `site/` | The project page, deployed to GitHub Pages |

## Providers and installation

<p>
  <img src="docs/assets/onboarding.png" width="62%" alt="First run: pick a provider, the key is checked, stored encrypted and never shown again">
</p>

The picker offers DeepSeek, OpenAI, Anthropic, OpenRouter, and local Ollama. The bounded DeepSeek/Docker workflow has passed real-provider acceptance; the other integrations remain experimental. See the [tested support matrix](docs/SUPPORT-MATRIX.md) for exact evidence and limitations. Hosted providers need your own account and credentials. Ollama needs its server and the configured model installed. Docker reaches host Ollama through `host.docker.internal`; native installs normally use `localhost`. Provider availability and model access depend on your account.

Keys are encrypted locally. Model requests send task context to the selected provider. Web tools can access approved public destinations even when the model itself is local. Read [privacy and security](SECURITY.md) before giving agents private work.

For development, use Python 3.13 with [uv](https://docs.astral.sh/uv/), Node 26, and Docker (running, for agent command tools). Run the two blocks below from the repository root, in separate terminals:

```sh
cd backend
uv sync --frozen
uv run python -m crew serve
```

```sh
cd frontend
npm ci
npm run dev
```

These commands work in PowerShell and POSIX shells. No environment file or provider key is needed for Demo. Optional settings are listed in [.env.example](.env.example). Keep the Vite port at 5173 or explicitly update the backend's allowed browser origins. See [installation and upgrades](docs/INSTALLATION.md) for authentication, storage, troubleshooting and recovery.

## Architecture

React renders the company and project views. FastAPI owns the API and event stream. The orchestrator plans and assigns work, CrewAI runs individual agents, and a shared model gateway reserves and records estimated usage. Capability checks and approvals guard tools. SQLite stores application state, budgets, audit records and events; project folders hold files.

The Docker distribution has three services: a static frontend, the API, and a private sandbox broker. Only the broker receives the Docker daemon socket. Command containers have no network, a read-only root, resource limits, and one project directory mounted for work. See [the security model](SECURITY.md) for its trust boundary.

This release supports **one server process and one shared workspace**. Viewer accounts can read that workspace; operators can run work; administrators manage credentials and execution mode. Do not use it to host mutually untrusted tenants.

## Current limits

- Spending caps use estimates, not a provider invoice. Failed or interrupted requests with unknown usage are charged conservatively. Set provider-side billing limits as well.
- Stopping a run blocks subsequent tool/model calls and requests container termination. A model request already sent may finish and bill. Server restarts pause interrupted runs for review.
- Network allowlists and deterministic content checks reduce exposure; they do not prove a page or command safe.
- One bounded DeepSeek workflow passed Live acceptance. Other providers and clean installations on additional platforms still need release validation. The [implementation tracker](docs/reviews/2026-10-10/IMPLEMENTATION.md) distinguishes changes from verified results.
- CrewAI still brings Chroma transitively. Its outstanding advisory assessment is recorded in [dependency notes](docs/DEPENDENCIES.md); no Chroma server is shipped.

## Documentation

| Start here | |
|---|---|
| [Installation](docs/INSTALLATION.md) | Local development and evaluation, upgrades, storage, recovery |
| [Deploying](docs/DEPLOYING.md) | One host that other people reach: token auth, TLS, backups |
| [VPS deployment](deploy/vps/README.md) | One-command Ubuntu 24.04 install with Caddy, UFW and backups (DigitalOcean walkthrough) |
| [First project](docs/FIRST-PROJECT.md) | The first small, checkable Live goal |
| [Support matrix](docs/SUPPORT-MATRIX.md) | What is tested where, and what still needs evidence |
| [Security](SECURITY.md) | The trust boundary, the sandbox and the Docker socket |
| [Specification](docs/README.md) | The 18 specs and 19 ADRs, in reading order |

## FAQ

- **Does it need an API key?** Not for the demo: Demo mode runs deterministic simulated agents and
  spends nothing. Live work needs one provider key (DeepSeek is the shipped default), entered in the
  UI and encrypted locally.
- **What does it cost?** The software is MIT. Demo spends nothing; Live bills your own provider.
  Crew estimates spend from token usage against a price table and enforces per-project caps and a
  hard ceiling — set provider-side billing limits as well.
- **Is it multi-tenant?** No. One trusted workspace per installation, with viewer / operator /
  admin roles. Do not host mutually untrusted tenants on it.
- **Which providers are proven?** One bounded DeepSeek workflow passed real-provider acceptance.
  OpenAI, Anthropic, OpenRouter and local Ollama are implemented but experimental; the
  [support matrix](docs/SUPPORT-MATRIX.md) says exactly what was tested.
- **Do agents run code on my machine?** Shell and Python run only inside Docker containers with no
  network, a read-only root and one writable project folder. The private broker is the only
  component that receives the Docker socket.
- **Can an agent act without asking?** Approvals gate tools, risky commands and gated web content.
  "Always allow" can stand in for one agent and capability, and a project can opt into Full
  autonomy, which records every such call in the audit log. Capability ceilings, the workspace
  jail, the sandbox and budget breakers still bind.
- **How is this different from a chat UI?** The unit is a company — departments, squads, grades,
  budgets — and the output is verified files, not a transcript.

## Project status

As of 2026-10-17: backend 367 of 368 tests collected (one live test deselected), frontend 353 tests
across 51 files, the converter example's 10 tests pass, and CI is green on every push. What still
needs evidence is listed in the [support matrix](docs/SUPPORT-MATRIX.md).

## Contribute

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development loop and [the code of conduct](CODE_OF_CONDUCT.md). Small, reproducible examples are especially useful: a goal, expected deliverable, observed result, and redacted logs. Use private reporting for security concerns.

The public-readiness [review](docs/reviews/2026-10-10/REPORT.md), its [action plan](docs/reviews/2026-10-10/ACTION-PLAN.md) and the [UI/UX review](docs/reviews/2026-10-13/UI-UX.md) explain the work and the open evidence. The specification is 18 numbered documents plus 19 ADRs under `docs/`; it describes both implemented behavior and earlier proposals, so the code and current installation guide take precedence.

Project page: <https://dogukandemir.github.io/crew>. Crew's application code is [MIT licensed](LICENSE). Dependencies keep their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
