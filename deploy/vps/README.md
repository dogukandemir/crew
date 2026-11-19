# Deploying Crew on a VPS

This directory contains a one-command installation path for a fresh Ubuntu 24.04 server: a DigitalOcean Droplet is the worked example, and the same installer runs on Hetzner, OVH, Scaleway or any other Ubuntu 22.04/24.04 VPS. It automates the manual steps in [docs/DEPLOYING.md](../../docs/DEPLOYING.md): Docker Engine and Compose v2, Caddy with automatic HTTPS, UFW, `.env`, the first admin, and a nightly backup.

Crew is experimental software for **one trusted team and one shared workspace**. It has one API process, SQLite, and no high-availability story. This installer does not make it multi-tenant, and it does not remove the trust decision described in [docs/DEPLOYING.md section 9](../../docs/DEPLOYING.md#9-the-sandbox-broker-and-the-docker-socket): the sandbox broker mounts the host Docker socket and therefore has host-level authority.

## What "one-click" means here

A DigitalOcean Marketplace "Deploy" button requires a vendor application and a published, reviewed 1-Click image. Crew does not publish one, so there is no Marketplace listing and this repository cannot make one appear. The practical one-click path is a Droplet plus cloud-init:

- **One paste:** create the Droplet with [`deploy/digitalocean/cloud-init.yaml`](../digitalocean/cloud-init.yaml) in the "User data" field. Cloud-init clones Crew and runs the installer non-interactively.
- **One command:** [`deploy/digitalocean/create-droplet.sh`](../digitalocean/create-droplet.sh) renders the same cloud-init and creates the Droplet through `doctl`.

Both paths still require two things that no installer can do for you: an SSH key registered with the provider, and a DNS record pointing the domain at the server. Caddy retries certificate issuance, so the DNS record may still be propagating while the install runs.

## What the installer does

[`install.sh`](install.sh) runs as root and:

1. Checks Ubuntu 22.04/24.04 and installs `git`, `curl`, `ca-certificates`, `ufw`, `cron`, `python3`, Docker Engine and the Compose v2 plugin, and Caddy. It prefers Ubuntu's `docker.io` + `docker-compose-v2` packages and refuses to continue unless the engine is 26+ (the sandbox broker needs `volume-subpath`) and Compose is v2.
2. Uses a checkout that already contains the script, or clones the repository to `/opt/crew` (`CREW_REPO_URL`, `CREW_REF`, `CREW_DIR`).
3. Merges `.env` (mode 600) with `CREW_JWT_SECRET`, `CREW_CORS_ORIGINS=https://$CREW_DOMAIN`, `CREW_PUBLIC_ORIGIN=https://$CREW_DOMAIN`, `CREW_BIND_HOST=127.0.0.1`, `DOCKER_SOCKET_GID` read from the real socket, `COMPOSE_PROJECT_NAME=crew`, and optional provider keys. Re-running preserves existing secrets and data; an explicit `CREW_JWT_SECRET` on a re-run rotates the secret.
4. Writes and validates `/etc/caddy/Caddyfile`: automatic HTTPS, `/api/*` and `/ws/*` to `127.0.0.1:8787`, everything else to `127.0.0.1:5173`, HSTS, CSP naming the public origin (including `wss://`), and the nosniff / referrer / frame headers.
5. Enables UFW with the SSH port(s) it can detect, plus 80 and 443. It does not touch the loopback-only container ports.
6. Builds and starts `docker-compose.prod.yml`. The frontend build happens **after** `.env` exists, because `VITE_API_BASE` is compiled from `CREW_PUBLIC_ORIGIN` into the bundle.
7. Waits for `/api/health`, runs `python -m crew doctor`, and creates the first admin only while the `users` table is empty. An empty `CREW_ADMIN_PASSWORD` is generated on the server and written to `/root/crew-admin-password.txt` (mode 600); the password is never printed.
8. Installs `/etc/cron.d/crew-backup`: `scripts/backup.sh --mode docker --dest /var/backups/crew --label nightly --keep 14` at 03:15, with `/var/log/crew-backup.log` and log rotation.
9. Prints the URL, admin email, password-file path, backup destination, and the section 9/15 security warning.

The installer never removes volumes. Re-running it is the supported way to apply a changed domain or provider key; it rebuilds and restarts the stack.

## Requirements

- Ubuntu 22.04 or 24.04, root access.
- 2 vCPU and 4 GB RAM (`s-2vcpu-4gb` on DigitalOcean). The API, broker and static UI have limits of 2 GB + 1 GB + 256 MB in the Compose file, and the image build is the memory-heavy step. More disk helps: the workspace volume grows with agent output.
- Docker Engine 26 or newer. Ubuntu 24.04's `docker.io` package satisfies this on amd64. On Ubuntu 22.04 the `docker-compose-v2` package is not in the archive; either pre-install Docker Engine 26+ with the Compose plugin from Docker's official apt repository, or install Ubuntu 24.04.
- A public DNS name and an email address for the ACME account. Point an A record at the server **before** you expect HTTPS; Caddy retries until it can issue the certificate.
- Inbound TCP 22 (or your SSH port), 80 and 443. Outbound access for apt, GitHub, Docker Hub and the model provider.
- An SSH key registered with the provider if you use `create-droplet.sh`.

## DigitalOcean walkthrough

### 1. Create the Droplet

In the DigitalOcean console: **Create Droplet**, image **Ubuntu 24.04 (LTS) x64**, plan **Basic / Regular / 2 vCPU / 4 GB**, a region near your users, and your SSH key. Do not add a password: the installer generates the admin password on the server.

In the **User data** field, paste [`deploy/digitalocean/cloud-init.yaml`](../digitalocean/cloud-init.yaml) after editing the three values under `write_files`:

```yaml
CREW_DOMAIN=${CREW_DOMAIN}          # e.g. crew.example.com, no https://
CREW_ACME_EMAIL=${CREW_ACME_EMAIL}  # Let's Encrypt / ACME account
CREW_ADMIN_EMAIL=${CREW_ADMIN_EMAIL}
```

If you paste the file unchanged, cloud-init stops at the placeholder guard and writes the reason to `/var/log/cloud-init-output.log`; the installer does not run with an empty or literal domain.

Alternatively, install [`doctl`](https://docs.digitalocean.com/reference/doctl/how-to/install/) and let the script do it (see the next section).

### 2. Create the DNS record

Add an A record for the domain at your DNS provider:

```text
crew.example.com.   300   IN   A   <droplet-ipv4>
```

Caddy will start immediately and keep retrying the certificate; a record that is still propagating only delays HTTPS. Watch it on the server with `journalctl -u caddy -f`.

### 3. Wait for cloud-init

```sh
ssh root@<droplet-ipv4>
cloud-init status --wait
tail -n 100 /var/log/crew-install.log
docker compose -f /opt/crew/docker-compose.prod.yml ps
```

The first run takes about 5-15 minutes: apt, three image builds, health checks. The authoritative result is the end of `/var/log/crew-install.log` (the deployment summary); `cloud-init status --long` shows a failed module, but the installer log has the detail.

### 4. First login

1. Open `https://<your-domain>`.
2. On the Droplet, read the generated password:
   ```sh
   ssh root@<droplet-ipv4> 'cat /root/crew-admin-password.txt'
   ```
3. Sign in as the admin email you set. Store the password in a password manager and remove the file (`rm /root/crew-admin-password.txt`) if you do not want it on the host.
4. Configure a provider and explicitly enable **Live** in the UI when you are ready to spend money. The first boot is Demo mode and spends nothing.

The admin password is the only credential this installer creates. It does not write a password into the cloud-init file, the `.env`, or the logs.

## Alternative: `create-droplet.sh`

The script renders the same cloud-init with `envsubst`, validates the YAML when PyYAML is available, creates the Droplet with `doctl`, waits for it, and prints the public IPv4 and the A record to create. `DO_TOKEN` is read from the environment and passed as `--access-token`; the script never calls `doctl auth init`, so the token is not written into `~/.config/doctl`, and it never echoes the token or the command. `doctl` has no stdin option for the token, so the value is visible in the local process list for the duration of the call: run this from a trusted workstation.

```sh
export DO_TOKEN='...'            # from the DigitalOcean API tokens page; do not commit it
export DO_REGION=nyc3
export DO_SSH_KEY='aa:bb:cc:...' # fingerprint or numeric id, not the key material
export CREW_DOMAIN=crew.example.com
export CREW_ACME_EMAIL=ops@example.com
export CREW_ADMIN_EMAIL=owner@example.com

./deploy/digitalocean/create-droplet.sh --dry-run   # render and inspect, no API call
./deploy/digitalocean/create-droplet.sh             # prompts, then creates the Droplet
```

`DO_SIZE` defaults to `s-2vcpu-4gb`; `CREW_DROPLET_NAME` defaults to `crew-<domain with dots replaced by hyphens>`. `--yes` skips the confirmation prompt. The rendered cloud-init is written to a temporary file with mode 600 and removed on exit.

## Any Ubuntu 24.04 VPS (Hetzner and similar)

The installer is provider-neutral. Create the server with your SSH key, point DNS at it, then:

```sh
ssh root@<server-ip>
apt-get update && apt-get install -y git
git clone --depth 1 https://github.com/dogukandemir/crew.git /opt/crew

export CREW_NONINTERACTIVE=1
export CREW_DOMAIN=crew.example.com
export CREW_ACME_EMAIL=ops@example.com
export CREW_ADMIN_EMAIL=owner@example.com
/opt/crew/deploy/vps/install.sh
```

Run it without `CREW_NONINTERACTIVE` and with a terminal attached to answer the domain, ACME email, admin email and optional provider-key prompts instead. The examples above log in as root; if you use `sudo` instead, use `sudo -E` (or pass the variables on the `sudo` command line) so they reach the installer. The script also installs Docker and Caddy, so a bare Ubuntu image is enough.

Hetzner Cloud users can put the same installer call in a `cloud-init` user-data field; the DigitalOcean file is a working template, and only the repository URL and the three values change.

## Non-interactive reference

| Variable | Required | Meaning |
|---|---|---|
| `CREW_NONINTERACTIVE` | no | `1` forces non-interactive mode; a stdin that is not a terminal selects it automatically. |
| `CREW_DOMAIN` | yes | Public DNS name, no scheme. |
| `CREW_ACME_EMAIL` | yes | ACME / Let's Encrypt account email. |
| `CREW_ADMIN_EMAIL` | yes | First Crew admin account. |
| `CREW_ADMIN_PASSWORD` | no | At least 12 characters. When empty, a password is generated and stored in `/root/crew-admin-password.txt` (mode 600). |
| `CREW_JWT_SECRET` | no | At least 32 characters. Generated when `.env` has none. An explicit value on a re-run **rotates** the signing secret and signs everyone out. |
| `CREW_ADMIN_NAME` | no | Display name for the first admin (default `Owner`). |
| `CREW_REPO_URL` | no | Repository to clone. |
| `CREW_REF` | no | Branch or tag (default `main`). A raw commit SHA does not work with the shallow `git clone --branch`. |
| `CREW_DIR` | no | Checkout path (default `/opt/crew`, or the checkout containing the script when run from one). |
| `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL` | no | Written to `.env`. Keys stored later through the UI live in the encrypted vault instead. |
| `CREW_VAULT_KEY` | no | Externally managed vault master key. Leave it unset to let the app generate `/data/vault.key` on first boot; the backup script captures that file. |

The installer stores `CREW_DOMAIN`, `CREW_ACME_EMAIL` and `CREW_ADMIN_EMAIL` in `/etc/crew/deploy.env` (mode 600) so an interactive re-run can offer them as defaults. It does not store secrets there. `.env` remains the source of truth for the stack.

## Day 2 operations

### Update

```sh
cd /opt/crew
scripts/backup.sh --mode docker --dest /var/backups/crew --label before-update --keep 14
git pull
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml exec backend python -m crew doctor
```

Take the backup first: it is WAL-safe and needs no downtime. Keep `COMPOSE_PROJECT_NAME` and `CREW_IMAGE_TAG` stable so the new containers reuse the same volumes. See [docs/DEPLOYING.md section 13](../../docs/DEPLOYING.md#13-upgrades) for rollback.

To change the domain: edit `CREW_DOMAIN` defaults by re-running `install.sh` with the new `CREW_DOMAIN` (or edit `.env`'s `CREW_CORS_ORIGINS` and `CREW_PUBLIC_ORIGIN`), then rebuild the frontend. The origin is compiled into the bundle; a restart alone will not change it. Re-running the installer does the rebuild and updates the Caddyfile.

### Back up

The installer schedules this at 03:15 every day and keeps 14 generations:

```sh
cd /opt/crew
scripts/backup.sh --mode docker --dest /var/backups/crew --label manual --keep 14
scripts/backup.sh --mode docker --dest /var/backups/crew --dry-run
```

A generation contains the SQLite snapshot, `vault.key` (without it stored provider keys cannot be decrypted), `runtime-mode.json` / `provider.json`, the workspace volume, `MANIFEST.txt` and `SHA256SUMS`. **Copy each generation off the machine:**

```sh
rsync -a --delete /var/backups/crew/ backup-host:/srv/crew-backups/
```

A backup that lives only on the server it protects is not a backup. The vault key makes the generation as sensitive as the installation itself; encrypt it at rest if the backup host is shared.

### Restore

```sh
cd /opt/crew
scripts/restore.sh --mode docker --from /var/backups/crew/<generation> --dry-run
scripts/restore.sh --mode docker --from /var/backups/crew/<generation>
```

The restore verifies the generation, keeps a pre-restore copy, stops the `backend` service itself, copies into the volumes, and prints the next steps: start the backend, run `python -m crew doctor`, sign in, open an existing project, confirm stored provider keys decrypt, and run `python -m crew audit verify`. The application version must match the data: an older build refuses a newer schema. Restore the backup together with the matching release, not instead of it.

### Rotate the admin password

There is no password-change CLI in this release. Change the hash from inside the API container, with the new password read from stdin (not from the command line, so it does not enter shell history or the process list):

```sh
cd /opt/crew
read -r -s -p 'New admin password: ' CREW_NEW_PASSWORD; echo
printf '%s\n' "$CREW_NEW_PASSWORD" | \
  docker compose -f docker-compose.prod.yml exec -T backend python -c '
import asyncio, sys
from sqlalchemy import select
from crew.core.db import init_db, session_scope
from crew.core.models import User
from crew.api.auth import hash_password

async def main() -> None:
    await init_db()
    email = sys.argv[1]
    password = sys.stdin.readline().rstrip("\n")
    if len(password) < 12:
        raise SystemExit("use at least 12 characters")
    async with session_scope() as s:
        user = await s.scalar(select(User).where(User.email == email))
        if user is None:
            raise SystemExit(f"no such user: {email}")
        user.password_hash = hash_password(password)
    print("password updated")

asyncio.run(main())
' owner@example.com
unset CREW_NEW_PASSWORD
```

Existing bearer tokens remain valid until `CREW_ACCESS_TOKEN_TTL_MIN` expires (720 minutes by default); changing the password does not revoke them. If you need immediate revocation, delete the rows in `sessions` after taking a backup, or let the tokens expire. Back up before changing the database by hand.

### Logs and status

```sh
cd /opt/crew
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f --tail=100 backend sandbox frontend
docker compose -f docker-compose.prod.yml exec backend python -m crew doctor
curl -fsS https://<your-domain>/api/health
journalctl -u caddy -f          # certificate issuance and proxy errors
tail -f /var/log/crew-backup.log
```

The sandbox broker's port 8790 is never published; it is reachable only from the API on the internal `sandbox-private` network.

### Teardown

```sh
cd /opt/crew
docker compose -f docker-compose.prod.yml down          # keeps the named volumes
docker compose -f docker-compose.prod.yml down --volumes # DESTROYS the database and workspaces
```

If you are decommissioning the host, also remove `/etc/cron.d/crew-backup`, `/etc/logrotate.d/crew-backup`, `/etc/caddy/Caddyfile`, `/etc/crew/deploy.env` and `/root/crew-admin-password.txt`; disable `caddy` and `docker`; remove the UFW rules; and delete the Droplet (`doctl compute droplet delete <id>`) or the VPS. Volumes are the only copy of Crew data unless you took a backup.

## Security caveats

- **The broker is host-level authority.** The `sandbox` service mounts `/var/run/docker.sock` and runs as uid 10001 with the socket group added through `DOCKER_SOCKET_GID`. Anything that breaks its validation, or the daemon, can control the host. There is no stronger boundary than Docker and the kernel. Read [docs/DEPLOYING.md section 9](../../docs/DEPLOYING.md#9-the-sandbox-broker-and-the-docker-socket).
- **Single tenant only.** One trusted team, one shared workspace, one API process and SQLite. Do not host mutually untrusted tenants, do not scale the backend, and do not point a second process or host at the same data.
- **Never publish 8790.** The Compose file keeps the broker on an internal network; the only host ports are the API and UI on `127.0.0.1`. Do not widen `CREW_BIND_HOST` unless your proxy runs elsewhere and you accept what that means.
- **Keep the Docker engine patched.** `unattended-upgrades` is enabled on stock Ubuntu images; verify it is, and reboot for engine updates when the package asks. An unpatched daemon is the real attack surface.
- **DNS before TLS.** Caddy obtains the certificate only after the A record resolves. It retries, but until then the site answers over HTTP with a certificate error. Do not paste the Droplet IP into `CREW_DOMAIN`.
- **Proxy trust.** The application does not use `X-Forwarded-*` for security decisions; the proxy's hostname and UFW are the network boundary. Keep Caddy on the same host and the container ports on loopback.
- **No proxy rate limiter.** Stock Caddy has no request-rate-limit directive, so this installer does not reproduce the nginx `limit_req` example in [docs/DEPLOYING.md section 6](../../docs/DEPLOYING.md#6-reverse-proxy-and-tls). The application limits sign-in and run creation in-process, but the edge bound is weaker than the nginx example. Add a Caddy rate-limit plugin or upstream protection if you need a hard limit.
- **The admin password file is root-only.** Move it to a password manager and delete it if your policy requires. It is not part of a backup generation.
- **Provider spend is yours.** Set provider-side billing limits too; Crew's caps are estimates from token usage, not invoices.
- **This path is not in the verified support matrix yet.** [docs/SUPPORT-MATRIX.md](../../docs/SUPPORT-MATRIX.md) records verified installations; native Linux and Docker host installations are still listed as requiring evidence. Run the first deployment as an acceptance test (Demo mode, a sandbox smoke command, a backup and a restore to a second volume) before trusting it with real work.

## Troubleshooting

| Symptom | Check |
|---|---|
| Cloud-init finishes but there is no site | `/var/log/crew-install.log` and `/var/log/cloud-init-output.log` on the Droplet. The installer stops at the first failed step. |
| `cloud-init` still contains placeholders | Edit the three values in the user-data field, or set them in `/etc/crew/deploy.env` and run `install.sh` again. |
| Caddy has no certificate | `dig +short <domain>` must return the Droplet IP; allow 80/443 in any cloud firewall as well as UFW; `journalctl -u caddy -n 100`. |
| `required variable ... is missing a value` | `.env` lacks `CREW_JWT_SECRET`, `CREW_CORS_ORIGINS` or `CREW_PUBLIC_ORIGIN`; run the installer again from the checkout. |
| `Docker Engine ... is too old` | Ubuntu's archive on this architecture is below 26. Install Docker Engine 26+ with the Compose plugin from Docker's official apt repository, then re-run. |
| `could not install the Docker Compose v2 plugin` | Ubuntu 22.04 does not ship `docker-compose-v2`; use Ubuntu 24.04 or Docker's official packages. The legacy `docker-compose` v1 package is not supported. |
| Sandbox unhealthy | `stat -c '%g' /var/run/docker.sock` must equal `DOCKER_SOCKET_GID` in `.env`; the installer refreshes it on every run. |
| Admin already exists but the password is lost | Use the password-rotation recipe above. Re-running the installer never resets an existing account. |
| `untrusted browser origin` | The browser origin is not exactly `https://$CREW_DOMAIN` in `CREW_CORS_ORIGINS`; rebuild the frontend after changing the origin. |
| Port 80 or 443 is already in use | A preinstalled web server (nginx, Apache) is running. Stop and disable it before the installer starts Caddy. |
| The office floor loads but no events arrive | `/ws/` must reach `127.0.0.1:8787`; check `curl -i https://<domain>/api/health` and the Caddy logs. |
