# Installation, upgrades and recovery

Crew is an experimental, single-process application for one trusted shared workspace. Start in Demo; a provider key is optional until you enable Live.

Check the [tested support matrix](SUPPORT-MATRIX.md) before choosing a provider or deployment. The Docker instructions below describe the distribution; platform support is limited to the evidence recorded there.

## Docker

Use Docker Desktop with Linux containers or Docker Engine 26+ (the sandbox uses volume subpaths), with Compose installed. Run these from the repository root:

```sh
docker compose up --build
```

Open http://localhost:5173. The API is at http://127.0.0.1:8787. Startup includes downloading a Python sandbox image. Both published ports bind to loopback. Keep those bindings: local mode treats callers as the administrator.

```sh
docker compose ps
docker compose logs --tail=100 backend sandbox
docker compose exec backend python -m crew doctor
```

The doctor reports database access, sandbox availability, mode and whether a provider is configured. It does not generate model output or prove a provider account has quota. Redact logs before sharing them.

Stop with `docker compose stop`; restart with `docker compose up -d`. `docker compose down` preserves named volumes. **Never add `--volumes` unless you intend to erase the installation.** Keep the same Compose project name across upgrades so it selects the same volumes.

The API stores its database and vault in `/data`. Project files live under `/workspaces`. A third volume holds the private broker credential. Only the sandbox service receives the Docker socket; that service is privileged in practice and must stay private. See [SECURITY.md](../SECURITY.md).

## Native development

Use Python 3.12, uv, Node 22 and Docker for command tools. In separate terminals:

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

These commands work in PowerShell and POSIX shells. Keep the UI on port 5173. Run `uv run python -m crew doctor` from `backend` for diagnostics. The default data directory is repository `data/`; company workspaces default to `~/crew/workspace`. Standalone projects may use `data/projects/<id>/workspace`. The saved project settings record the actual path. Back up both data and workspaces.

Copy `.env.example` to `.env` only when customization is needed. Keep it private. Do not run multiple API workers against the same database. SQLite is the supported database in this release.

## Providers and Live mode

Connect credentials using **Configure provider**, then explicitly choose **Enable Live**. Credentials alone do not start work. Mode changes and provider changes require active and paused runs to be resolved first. The saved mode persists across restarts.

For Ollama, install the configured model (`llama3.2` for the picker default) and start Ollama. Native installs use its local URL; Docker uses `http://host.docker.internal:11434`. On Linux the Compose host-gateway mapping supplies that hostname. The health check must reach the actual model server; a configured URL alone is not proof of readiness.

Provider verification checks credentials/model listing without generating output. Provider account permissions, quotas and compatibility can still cause a run to fail. Set provider billing limits and inspect the first run's artifacts before using them. See [the first-project recipe](FIRST-PROJECT.md).

Hosted model prices match exact identifiers. An unknown identifier is refused before a model request, rather than guessed from a similar name. To use an additional model, set `CREW_MODEL_PRICES` to a JSON object of exact model identifiers and `[input, output]` USD-per-million-token rates after checking the provider's prices, for example `{"custom/model":[2.0,8.0]}`. Native installs read this from `.env`; Docker requires an explicit backend environment override. Zero denotes an intentional zero per-token rate. Existing estimates exclude taxes, hosting and provider surcharges. The Haiku 4.5 estimate is based on [Anthropic's listed base rates](https://platform.claude.com/docs/en/models/haiku-4-5/overview); recheck rates when upgrading or changing provider terms.

## Shared-workspace sign-in

Native installations can use `CREW_AUTH_MODE=token` with a unique random `CREW_JWT_SECRET` of at least 32 characters. Create an account from `backend`:

```sh
uv run python -m crew auth create-user --email owner@example.com --role admin
```

The command prompts for a password (at least 12 characters). Prefer this to putting a password in shell history. Roles are `viewer`, `operator`, and `admin`. They share workspace data; these are not tenant boundaries. Tokens stay in browser memory and a reload requires signing in again. Sign out revokes the server session.

The default Compose distribution is local mode. Token mode in Compose requires an explicit backend environment override; merely adding an arbitrary variable to the root `.env` does not inject it into the container. Keep public hosting out of scope until you have configured token authentication, HTTPS, exact allowed origins and reviewed the trust model.

## Backup and upgrade

1. Stop runs and stop the API before copying data. Keep the previous application version available.
2. Back up the **entire data directory**, including `crew.db`, any SQLite sidecar files and `vault.key`, plus every project workspace. If using `CREW_VAULT_KEY` instead of a key file, retain that secret separately. Back up Docker named-volume contents with your Docker volume backup tooling while services are stopped.
3. Rebuild/reinstall using the committed lockfiles, then start one API process. It applies schema migrations automatically. Before upgrading an existing SQLite schema, it creates a consistent database snapshot under `data/backups` using SQLite's backup API (including committed WAL data).
4. Check health, open existing projects and inspect files before starting new work. Interrupted runs are paused for review rather than automatically replayed.

The automatic pre-migration snapshot covers the database only. It does not back up the vault key or project files. For rollback, stop services, restore the complete known-good backup into the original locations, and run the matching application version. Preserve the failed installation separately for diagnosis; do not overwrite it with a running database. Newer schemas are refused by older applications.

Legacy installations can contain paths chosen before unique IDs were added to folder names. Recorded paths are preserved. Before moving a native installation into Docker, copy each project's files into its own directory in the workspace volume and reconcile its saved workspace path while stopped. This migration is not automatic; do not point two projects at the same folder.

## Troubleshooting

| Symptom | Check |
|---|---|
| UI cannot connect | API health, logs, port conflicts and `VITE_API_BASE`. The Docker frontend URL is compiled at build time; rebuild after changing it. |
| Browser rejects requests | UI origin must exactly match `CREW_CORS_ORIGINS`; port and hostname both matter. |
| Sandbox unavailable | Docker is running, sandbox service is healthy, Python image download completed, and Docker supports volume subpaths. |
| Command denied | Check capability, workspace, run status and approval records; grants can be scoped to one invocation. |
| Provider saved but agents simulated | Explicitly enable Live after finishing active or paused runs. |
| Vault decryption fails after restore | Restore the original vault key; generating a new key cannot decrypt old credentials. |
| A restart left work paused | Review completed files and interrupted usage before explicitly resuming or cancelling. |

Cross-platform and complete Docker release checks remain tracked in [IMPLEMENTATION.md](reviews/2026-10-10/IMPLEMENTATION.md). Instructions are not a claim that all release environments have been verified.
