# Deploying Crew on a host

This is the guide for putting Crew on a server that other people reach over the network: one host, one API process, token authentication, TLS in front of it, backups off the machine.

For local development on your own workstation, use [INSTALLATION.md](INSTALLATION.md) instead. That guide covers the native `uv`/`npm` loop and the loopback-only demo Compose file (`docker-compose.yml`), which stays the local single-workspace distribution. Everything below is about `docker-compose.prod.yml`.

Read [SECURITY.md](../SECURITY.md) before you expose this to anyone. Crew 0.1 is for one trusted team sharing one workspace. Roles (`viewer`, `operator`, `admin`) are not tenant boundaries.

## 1. What you are deploying

| Service | Image | Published | Volumes | Notes |
|---|---|---|---|---|
| `backend` | `crew-backend:<tag>` | `${CREW_BIND_HOST}:${CREW_BACKEND_PORT}` to container 8787 | `<project>_crew-data` at `/data`, `<project>-workspaces` at `/workspaces`, `<project>_sandbox-auth` read-only at `/sandbox-auth` | The API. Token auth. One process only. |
| `sandbox` | `crew-sandbox:<tag>` | nothing | workspace volume, sandbox-auth, and the Docker daemon socket | Private command broker on an internal network. Never publish it. |
| `frontend` | `crew-frontend:<tag>` | `${CREW_BIND_HOST}:${CREW_FRONTEND_PORT}` to container 5173 | none | Static build served by nginx. |

Both host ports bind to loopback (`CREW_BIND_HOST=127.0.0.1`) unless you change it. That is deliberate: the reverse proxy should run on the same machine and reach the containers on loopback. Widening `CREW_BIND_HOST` exposes an authenticated API without TLS to anything that can route to the host.

`COMPOSE_PROJECT_NAME` defaults to `crew`. Keep it stable: it is part of the volume names. `crew-workspaces` is deliberately named without the project prefix so that the demo file and the production file resolve to the same workspace volume.

## 2. One host, one API process

The API takes an exclusive OS-level lease on `<data dir>/crew.runtime.lock` at startup and refuses to start if another process holds it:

```
another Crew process owns this data directory; run one API worker or headless run at a time
```

Two writers on one SQLite database is a correctness problem, not a tuning problem. Consequences for your deployment:

- Exactly one `backend` replica. Never scale it, never add a second host pointed at the same data directory or volume.
- Do not run `python -m crew run` (headless goal execution) while the API is up; it takes the same lease.
- Stop the stack before you copy data by hand, and use the backup script in section 10 rather than a file copy.

There is no high availability story in this release, and the schema refuses to load in an older build, so roll back the application version together with the data.

## 3. Prerequisites

- A Linux host with Docker Engine 26 or newer (the sandbox creates containers with `volume-subpath`, which needs a recent engine) and the Compose plugin. Docker Desktop works for evaluation; a server should run the engine directly.
- A DNS name that resolves to the host, and a TLS certificate for it. A reverse proxy terminates TLS.
- Roughly: 2 vCPU and 2 GB RAM for the API plus 1 vCPU and 1 GB for the broker, plus disk for the data and workspace volumes. Agent-produced files grow; watch the volume.
- Python 3 and sha256sum (or shasum) on the host for the backup and restore scripts. The `sqlite3` CLI is used when present, otherwise the scripts use Python's `sqlite3` module.
- An outbound network path for the providers you configure, and an inbound path on 443 only.

## 4. Fill in the environment

The application reads `.env` in the repository root (or `backend/.env` on native runs), and Compose reads the same file for interpolation. Every key the application parses is documented in [`.env.example`](../.env.example).

```sh
git clone <this repo> /opt/crew
cd /opt/crew
cp .env.example .env
chmod 600 .env
```

Set at least these. The production Compose file refuses to render without the first three (`${VAR:?...}`).

```sh
# A signing secret with at least 32 characters. There is no built-in default.
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
CREW_JWT_SECRET=<paste>

# Exactly the origins a browser will use, scheme and host and port, comma separated.
CREW_CORS_ORIGINS=https://crew.example.com

# The absolute origin the UI is compiled against. It must be one of the origins above.
CREW_PUBLIC_ORIGIN=https://crew.example.com

# Keep the published ports on loopback; the proxy runs on this host.
CREW_BIND_HOST=127.0.0.1
CREW_BACKEND_PORT=8787
CREW_FRONTEND_PORT=5173

# The socket's group. Read it, do not guess:
#   stat -c '%g' /var/run/docker.sock
DOCKER_SOCKET_GID=<gid>

# Provider keys. An untrusted key can be stored later through the UI instead.
DEEPSEEK_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
OPENROUTER_API_KEY=
OLLAMA_BASE_URL=

# Optional. The API refuses a body over this size before parsing it (413), and a
# write with no Content-Length is answered 411. Keep the proxy's
# client_max_body_size at or above it. Default 8000000.
CREW_MAX_REQUEST_BYTES=8000000
```

What the production file pins for you, so that a public deployment cannot drift into a demo posture:

- `CREW_AUTH_MODE=token` and `CREW_CONTAINER_LOCAL_AUTH=false`. Token mode with a secret shorter than 32 characters fails at boot with a clear error.
- `CREW_ENV=prod`, which stops the API from adding the development origin regex and hides internal error detail in responses.
- `CREW_CORS_ORIGINS` is required and injected. Blank would deny every browser origin.
- Limits and log rotation on all three services, `restart: unless-stopped`, and a `stop_grace_period` per service.

Two things the environment does not decide for you:

- `CREW_TIER_*` and `CREW_MODEL_PRICES` are not injected. An explicit `CREW_TIER_*` in the container env wins over the provider chosen in the UI on every boot, which would lock the provider picker. If you want the environment to own routing, add those keys under the `backend` service's `environment:` block yourself.
- `CREW_OFFLINE_LLM` decides the first boot only. Crew starts in Demo (simulated agents, no provider calls) and the Demo/Live choice saved in the UI wins on every later boot. Live also requires a configured provider key.

## 5. First run

```sh
cd /opt/crew
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail=50 backend sandbox
```

The backend container's healthcheck calls `/api/health` inside the container; the sandbox healthcheck reads the broker token and calls the broker's `/health`. Both are declared in the Compose file, so `ps` shows real readiness rather than "running".

`GET /api/health` is public on purpose and returns liveness plus identity only:

```sh
curl -sS http://127.0.0.1:8787/api/health
{"status":"ok","version":"...","contract":...,"offline_llm":true,"server_time":"..."}
```

`GET /api/system/status` (projects, events, models, pricing, vault state) requires a session. The sandbox broker's port 8790 is never published; it is reachable only from the API over the `sandbox-private` network.

## 6. Reverse proxy and TLS

Terminate TLS on the host and route one origin to both containers. Anything the browser talks to must appear in `CREW_CORS_ORIGINS` exactly: the origin guard answers `403 {"detail":"untrusted browser origin"}` for a request that carries an `Origin` header which is not listed, including WebSocket upgrades.

An nginx server block that matches the Compose defaults:

```nginx
# Host allowlist: the proxy is the only component that checks the Host header
# (see section 7), so keep this list explicit.
server {
    listen 80;
    server_name crew.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name crew.example.com;

    ssl_certificate     /etc/letsencrypt/live/crew.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/crew.example.com/privkey.pem;

    # The API schema is useful and unauthenticated: keep it off the public origin.
    location ~ ^/(docs|redoc|openapi.json) { return 404; }

    # Above the API's own cap (CREW_MAX_REQUEST_BYTES, 8 MB by default) so the
    # limit you hit is the documented one, with a JSON detail.
    client_max_body_size 16m;

    location /api/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_set_header Host $host;
    }
}
```

Notes that come from the code, not from taste:

- The WebSocket endpoint is `/ws/projects/{id}` on the API port, not under `/api/`. Route `/ws/` to the backend or the office floor never goes live.
- The UI's API base is compiled into the bundle at image build time from `CREW_PUBLIC_ORIGIN`. Change the origin and you must rebuild the frontend image.
- Serving UI and API from one origin avoids CORS preflights, but it does not remove the origin check. Keep `CREW_CORS_ORIGINS` correct anyway.
- If you need a second hostname, list every origin in `CREW_CORS_ORIGINS` (comma separated) and be aware the UI is built for one origin only.
- Forwarded headers are not used for security decisions in this release. Run the proxy on the same host and keep the container ports on loopback.

## 7. Allowed hosts: what enforces what

`CREW_CORS_ORIGINS` is enforced twice in the application: by the CORS middleware and by a per-request guard that rejects a request whose `Origin` header is not listed. That guard is also the CSRF boundary, because it applies to `POST`/`PUT`/`DELETE` from a browser.

The `Host` header is a different story. `TrustedHostMiddleware` is installed only in local authentication mode, hard-coded to `localhost`, `127.0.0.1` and `[::1]` (`backend/src/crew/api/main.py`). In token mode the application does not check `Host` at all, and there is no `CREW_ALLOWED_HOSTS` setting to configure.

Treat the proxy's `server_name` and a default server block as the Host allowlist:

```nginx
# Reject anything that arrives under another name instead of serving it.
server {
    listen 443 ssl default_server;
    server_name _;
    ssl_certificate     /etc/letsencrypt/live/crew.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/crew.example.com/privkey.pem;
    return 444;
}
```

So: `CREW_CORS_ORIGINS` decides which browser origins the application trusts, the proxy decides which hostnames reach it. Both must be set, and they are not interchangeable.

## 8. The first admin user

Accounts live in the database. Create the first admin from inside the running container, which prompts for a password of at least 12 characters:

```sh
docker compose -f docker-compose.prod.yml exec backend \
  python -m crew auth create-user --email owner@example.com --name "Owner" --role admin
```

The same command works in a native checkout as `uv run python -m crew auth create-user --email ... --role admin`. Roles are `viewer`, `operator` and `admin`. Sign-in requires token mode, which the production file already sets. Tokens stay in browser memory: a reload means signing in again, and signing out revokes the server session.

Do not create the first user with `--password` on the command line unless you accept the password in your shell history.

## 9. The sandbox broker and the Docker socket

The `sandbox` service is the only component that receives the Docker daemon socket. It is a broker with a narrow API: it accepts a fixed command shape, a fixed image, a timeout and an existing subdirectory of the dedicated workspace volume. It cannot mount the database, the vault or an arbitrary host path. That is also the whole trade-off: anything that breaks the broker's validation, or the host's Docker daemon, has host-level authority. It is not a security boundary stronger than Docker or its kernel.

Operational consequences:

- The broker runs as uid 10001 and is added to the socket's group in the container (`DOCKER_SOCKET_GID`). Read the real group with `stat -c '%g' /var/run/docker.sock`. On Debian and Ubuntu this is usually the `docker` group (often 999); on rootless Docker it is the invoking user.
- Never publish port 8790, never put the broker on the same network as anything untrusted, and never mount the socket or the broker token into an agent container. The Compose file keeps it on `sandbox-private`, an internal network, and drops `no-new-privileges` protection only where it cannot apply.
- A token file (`/sandbox-auth/token`, mode 0600) authenticates the API to the broker. Because the broker creates it 0600, the API and the broker share one uid (10001) in these images. That is why the API container is not a different user.
- Keep the Docker engine patched. The broker is exactly as dangerous as an unpatched daemon.
- The socket mount in the Compose file is the Linux host form, `/var/run/docker.sock`. On Docker Desktop the daemon arrives through the platform's own proxy path, which is why an evaluation on Desktop works without changing it. A server needs the real socket.
- The broker bounds itself: two concurrent agent commands, 45 second default timeout (120 maximum) per command, and each agent container is created with `--network none`, a read-only root, dropped capabilities, 1 GB memory, 1 CPU and a 128 pid limit.

## 10. Non-root containers and volume ownership

Every image runs as `crew` (uid and gid 10001), and `/data`, `/workspaces` and `/sandbox-auth` are created in the images with that ownership. A **fresh** named volume is initialized from the image directory, so a first install needs no `chown` at all.

Two cases need a one-time fix on the host:

1. Volumes created by an older release that ran as root, or by the demo file before this change:

```sh
docker run --rm -v crew_crew-data:/data -v crew-workspaces:/ws alpine \
  chown -R 10001:10001 /data /ws
```

2. Files inside the workspace that were produced by agent commands. Agent commands run in their own container as root (the broker's fixed command line does not set a user), so a directory created by an agent inside `/workspaces` is root-owned, and the API can read it but may not be able to write into it. The API reports the write as a permission error rather than silently dropping it. Between runs, an operator can reconcile the tree with the same one-liner above. Changing this would require a change in `backend/src/crew/execution/sandbox_worker.py`, which is outside this deployment work.

Sandbox-auth ownership matters in the same way: the volume must be writable by uid 10001, because the broker creates the token there.

## 11. Logs

Logs go to stdout/stderr and Docker keeps them in per-container `json-file` logs, rotated by the Compose file (`max-size: 10m`, `max-file: 5` per service, override with `CREW_LOG_MAX_SIZE` and `CREW_LOG_MAX_FILE`). Nothing on the host grows without bound, and nothing is shipped anywhere: if you need long retention, ship the Docker log files with your own collector.

```sh
docker compose -f docker-compose.prod.yml logs -f --tail=100 backend
docker compose -f docker-compose.prod.yml logs -f --tail=100 sandbox frontend
```

The API's own verbosity is `CREW_LOG_LEVEL` (`debug`, `info`, `warning`, `error`). Startup logs the version, contract, environment, auth mode, sandbox mode, data directory and model tiers, which is the first thing to read when a deployment misbehaves. Secrets known to Crew are redacted from events and formatted logs; that is not a licence to paste credentials into goals, filenames or artifacts.

## 12. Backup and restore

Two scripts, both executable, both documented by `--help`. They write **outside** the volumes they protect, and the destination is a required argument: without it they exit with a usage error instead of writing into `/data`.

```sh
# Host installation (native or the API reading host paths)
scripts/backup.sh --dest /srv/backups/crew --data-dir /var/lib/crew/data --workspace-dir /var/lib/crew/workspaces

# Docker installation: reads the database through the running API container
scripts/backup.sh --mode docker --dest /srv/backups/crew --label nightly --keep 14
```

What a generation contains:

- `data/crew.db`: a snapshot taken with SQLite's online backup API (`sqlite3 .backup`, or the Python `sqlite3` module when the CLI is missing). It is WAL-safe and requires stopping nothing: the API keeps serving during a backup.
- `data/vault.key`: the master key that decrypts every stored provider key. **A database backup without this key cannot restore credentials.** If you set `CREW_VAULT_KEY` instead of using the key file, the script warns you: that secret lives outside the data directory and you must store it yourself.
- `data/runtime-mode.json` and `data/provider.json` when present, so the restored install remembers Demo/Live and the provider choice.
- `workspaces/`: the workspace volume, copied read-only.
- `MANIFEST.txt` and `SHA256SUMS`: what was taken, from where, how many tables and files, and hashes to detect damage later.

Generations are directories named `<UTC timestamp>-<label>`, renamed into place only when every step succeeded, with the oldest pruned to `--keep` (default 7). `--dry-run` prints the plan and copies nothing. The script refuses a destination inside the data directory or the workspace, and refuses to run in Docker mode without a running `backend` service.

```sh
# Verify a generation without changing anything
scripts/restore.sh --from /srv/backups/crew/20261017T030000Z-nightly --dry-run
```

Restoring replaces a live database, so this script does stop things:

- It verifies the generation first: database integrity, checksum file, and presence of the vault key. A damaged generation exits with code 4 before anything is touched.
- It refuses to run when the API answers on the port (default 8787) unless `--force` is given, because a running writer cannot be swapped underneath safely. In Docker mode it stops the `backend` service itself and copies into the volumes, and tells you to start it again.
- It keeps a pre-restore copy of what it is about to overwrite: next to the data directory (`<data dir>.pre-restore-<timestamp>`) in host mode, or under the repository root in Docker mode. Then it restores the database, the vault key (mode 0600), the mode/provider files and the workspace tree.
- It verifies the restored database (integrity check, table count) and that the vault key exists, in host mode or inside the volume in Docker mode, then prints the next steps: start one API process, run `python -m crew doctor`, sign in, open an existing project, confirm stored provider keys decrypt, and run `python -m crew audit verify`.

Copy each generation off the machine. A backup that lives only on the host it protects is not a backup. A nightly cron entry looks like this:

```cron
0 3 * * * cd /opt/crew && scripts/backup.sh --mode docker --dest /srv/backups/crew --label nightly --keep 14 >> /var/log/crew-backup.log 2>&1
30 3 * * * rsync -a --delete /srv/backups/crew/ backup-host:/srv/crew-backups/
```

Two things the scripts do not cover. The pre-migration snapshot the application writes itself (under `data/backups`, before a schema migration) covers the database only. And the restore is not point-in-time: interrupted runs are paused for review rather than replayed, so expect to review work that was in flight.

## 13. Upgrades

```sh
cd /opt/crew
git pull
docker compose -f docker-compose.prod.yml build          # rebuilds the three images
docker compose -f docker-compose.prod.yml up -d          # recreates changed containers
docker compose -f docker-compose.prod.yml ps
```

- Take a backup first (section 12). It takes minutes and needs no downtime.
- Keep `COMPOSE_PROJECT_NAME` and `CREW_IMAGE_TAG` stable so the new containers reuse the same volumes. Bump `CREW_IMAGE_TAG` per release if you want to roll back by tag: the previous image stays on the host until you prune it.
- On startup the API takes the lease, applies schema migrations and writes a consistent database snapshot under `data/backups` before touching an existing schema. Interrupted runs are paused and require review.
- Rollback: check out the previous revision, or build the previous tag, then `up -d` again. The restored application must match the data: a newer schema is refused by an older build, so roll back the backup with the version, not instead of it.
- Changing `CREW_PUBLIC_ORIGIN` requires a frontend rebuild, because the value is compiled into the bundle.

## 14. What to monitor

| Signal | Where | What it means |
|---|---|---|
| Liveness | `curl -fsS http://127.0.0.1:8787/api/health` | `status` is `degraded` when the database ping fails. Alert on non-200 and on `degraded`. |
| Container state | `docker compose -f docker-compose.prod.yml ps` | `unhealthy` or a restart count that keeps climbing means crash-looping; read the logs. |
| Sandbox readiness | `docker compose ... ps sandbox` and the API's `doctor` | Agents cannot run commands without a healthy broker; the healthcheck calls the broker with the token. |
| Installation check | `docker compose ... exec backend python -m crew doctor` | Database, sandbox, mode, provider configured. It does not prove a provider account has quota. |
| Disk | volume sizes and `docker system df` | The workspace volume grows with agent output; the data volume holds the database, artifacts and pre-migration snapshots. |
| Memory and CPU | `docker stats` against the declared limits | A service pinned at its limit is the first sign that `CREW_MAX_CONCURRENT_CREWS` is set too high for the host. |
| Log volume | `docker compose logs --since 1h \| wc -l` | Rotation bounds size, not noise. A rotating log that never stops rotating is a loop. |
| Spend | `/api/system/status` (`pricing`) and the UI budget views | `CREW_HARD_BUDGET_USD` and the per-project budgets are application estimates against configured prices, not provider invoices. Set provider-side billing limits too. |
| Audit chain | `docker compose ... exec backend python -m crew audit verify` | Verifies the hash-chained audit log after a restore or an incident. |
| Provenance | `curl -sS https://crew.example.com/api/health` | The public route should answer. `/docs` should not (section 6 blocks it at the proxy). |

## 15. Known limits of this deployment path

- Single host, single API process, SQLite. No replicas, no failover, no read-only second instance.
- The sandbox broker holds the Docker socket. See section 9; this is the largest trust decision in the deployment.
- Host header enforcement lives in the proxy, not in the application (section 7).
- Agent commands still run as root inside the workspace volume, so root-owned files there are a known rough edge (section 10).
- TLS, certificate renewal, log shipping, metrics, alerting and image publishing are the operator's job. This guide ships configuration, not an automation pipeline.
- There is no supported multi-host or multi-tenant mode in this release.

## Troubleshooting

| Symptom | Check |
|---|---|
| Compose refuses to start: "required variable ... is missing a value" | `.env` is missing `CREW_JWT_SECRET`, `CREW_CORS_ORIGINS` or `CREW_PUBLIC_ORIGIN`, or Compose is not running from the repository root. |
| Backend exits at boot with a token-mode error | `CREW_JWT_SECRET` is shorter than 32 characters. |
| Backend exits with "another Crew process owns this data directory" | A second API process or headless run holds the lease. Stop it; one writer per data directory. |
| "untrusted browser origin" in the browser console | The origin the browser uses is not in `CREW_CORS_ORIGINS`, exactly (scheme, host and port). Rebuild the frontend if you changed the public origin. |
| The office floor loads but events never arrive | `/ws/` is not proxied to the API port, the WebSocket upgrade headers are missing, or the origin is not allowed (the socket closes with code 4403). |
| Sandbox unhealthy | The broker cannot reach the Docker socket: `DOCKER_SOCKET_GID` does not match `stat -c '%g' /var/run/docker.sock`, or the engine is too old for `volume-subpath`. |
| Agents fail with permission errors on workspace files | Root-owned files from earlier agent runs (section 10); reconcile ownership once. |
| Provider saved but agents do nothing | Crew is still in Demo. Finish or cancel active runs, then enable Live; the saved mode wins over `CREW_OFFLINE_LLM` after the first boot. |
| 413 on a large upload | The body exceeded `CREW_MAX_REQUEST_BYTES` (default 8 MB). Raise it and the proxy's `client_max_body_size` together. A 411 means the client sent a write with no `Content-Length`. |
| The wizard's Browse button answers 403 | By design: the host folder picker is disabled outside development. Set `CREW_ALLOW_HOST_PICKER=true` if the operator wants it, or type the path. Behind a same-host proxy every peer already looks like loopback, so treat that opt-in as deliberate. |
| Vault decryption fails after a restore | The restored database does not match the vault key. Restore the matching `data/vault.key`; a new key cannot decrypt old secrets. |
| UI shows an old API address | `CREW_PUBLIC_ORIGIN` changed without rebuilding the frontend image. |
