#!/usr/bin/env bash
# =============================================================================
# Crew: one-command install for a single-host Ubuntu 22.04/24.04 deployment.
#
# This is the automated form of docs/DEPLOYING.md. It installs Docker Engine +
# the Compose v2 plugin, Caddy (automatic HTTPS), and UFW; writes .env
# (mode 600) and /etc/caddy/Caddyfile; builds and starts docker-compose.prod.yml;
# waits for /api/health; runs `python -m crew doctor`; creates the first admin
# when the users table is empty; and installs a nightly backup cron.
#
# Interactive (a terminal on stdin):
#   sudo ./deploy/vps/install.sh
#   It prompts for the public domain, the ACME account email, the first admin
#   email, and optional provider keys.
#
# Non-interactive (no tty, or CREW_NONINTERACTIVE=1):
#   sudo CREW_NONINTERACTIVE=1 \
#     CREW_DOMAIN=crew.example.com \
#     CREW_ACME_EMAIL=ops@example.com \
#     CREW_ADMIN_EMAIL=owner@example.com \
#     ./deploy/vps/install.sh
#   Optional: CREW_ADMIN_PASSWORD, CREW_JWT_SECRET, CREW_ADMIN_NAME,
#   CREW_REPO_URL, CREW_REF, CREW_DIR, DEEPSEEK_API_KEY, OPENAI_API_KEY,
#   ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, OLLAMA_BASE_URL.
#
# Re-running is safe and is the supported way to apply a changed domain:
#   - an existing .env is merged, never replaced; a valid CREW_JWT_SECRET and
#     provider keys already in .env are preserved (an explicit CREW_JWT_SECRET
#     in the environment rotates the secret and signs everyone out);
#   - the first admin is created only while the users table is empty;
#   - DOCKER_SOCKET_GID and the derived origins are refreshed;
#   - volumes are never removed. It does rebuild and restart the stack.
#
# Prerequisites: Ubuntu 22.04 or 24.04, root, an A record for CREW_DOMAIN that
# points at this host, and inbound TCP 80/443 open. Caddy retries certificate
# issuance, so the DNS record may still be propagating when this runs.
#
# The security model is not changed by this installer: read docs/DEPLOYING.md
# sections 9 and 15. The sandbox broker mounts the host Docker socket and is
# host-level authority; this release is single-tenant; port 8790 is never
# published.
# =============================================================================
set -euo pipefail

DEFAULT_REPO_URL="https://github.com/dogukandemir/crew.git"
DEFAULT_REF="main"
DEFAULT_DIR="/opt/crew"

CADDYFILE="/etc/caddy/Caddyfile"
STATE_DIR="/etc/crew"
STATE_FILE="${STATE_DIR}/deploy.env"
ADMIN_PASSWORD_FILE="/root/crew-admin-password.txt"
BACKUP_DIR="/var/backups/crew"
BACKUP_LOG="/var/log/crew-backup.log"
CRON_FILE="/etc/cron.d/crew-backup"
LOGROTATE_FILE="/etc/logrotate.d/crew-backup"
COMPOSE_FILE_NAME="docker-compose.prod.yml"

# CREW_DIR is special: if the caller did not set it, a checkout that contains
# this script wins over the default. Capture whether it was explicit first.
CREW_DIR_EXPLICIT=0
if [ -n "${CREW_DIR:-}" ]; then CREW_DIR_EXPLICIT=1; fi
CREW_DIR="${CREW_DIR:-$DEFAULT_DIR}"
CREW_REPO_URL="${CREW_REPO_URL:-$DEFAULT_REPO_URL}"
CREW_REF="${CREW_REF:-$DEFAULT_REF}"
CREW_DOMAIN="${CREW_DOMAIN:-}"
CREW_ACME_EMAIL="${CREW_ACME_EMAIL:-}"
CREW_ADMIN_EMAIL="${CREW_ADMIN_EMAIL:-}"
CREW_ADMIN_NAME="${CREW_ADMIN_NAME:-Owner}"
CREW_ADMIN_PASSWORD="${CREW_ADMIN_PASSWORD:-}"
CREW_JWT_SECRET="${CREW_JWT_SECRET:-}"
NONINTERACTIVE="${CREW_NONINTERACTIVE:-0}"

PROVIDER_ENV_KEYS=(DEEPSEEK_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY OLLAMA_BASE_URL)

# Filled while the installer runs and used by the summary.
BACKEND_PORT=8787
FRONTEND_PORT=5173
ADMIN_PASSWORD_GENERATED=0
ADMIN_CREATED=0
DOCTOR_FAILED=0

# -----------------------------------------------------------------------------
# Logging and small helpers
# -----------------------------------------------------------------------------
log() { printf '[crew-install] %s\n' "$*"; }
warn() { printf '[crew-install] warning: %s\n' "$*" >&2; }
die() { printf '[crew-install] error: %s\n' "$*" >&2; exit 2; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
Usage: sudo ./deploy/vps/install.sh [--help]

Installs the single-host Crew stack on Ubuntu 22.04/24.04 (the same layout
docs/DEPLOYING.md describes): Docker Engine + Compose v2, Caddy with automatic
HTTPS, UFW, the production Compose stack, the first admin and a nightly backup.

Interactive mode (stdin is a terminal) prompts for the domain, ACME email,
admin email and optional provider keys.

Non-interactive mode is selected when stdin is not a terminal or when
CREW_NONINTERACTIVE=1. It requires:

  CREW_DOMAIN        public DNS name, no scheme (for example crew.example.com)
  CREW_ACME_EMAIL    email for the Let's Encrypt / ACME account
  CREW_ADMIN_EMAIL   email for the first Crew admin account

Optional:
  CREW_ADMIN_PASSWORD   at least 12 characters; generated and stored in
                        /root/crew-admin-password.txt (mode 600) when empty
  CREW_JWT_SECRET       at least 32 characters; generated when .env has none.
                        An explicit value on a re-run rotates the secret.
  CREW_ADMIN_NAME       display name for the first admin (default: Owner)
  CREW_REPO_URL         repository to clone (default: this project's GitHub)
  CREW_REF              branch or tag to clone (default: main)
  CREW_DIR              checkout location (default: /opt/crew, or the checkout
                        that contains this script when it is run from one)
  DEEPSEEK_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY,
  OPENROUTER_API_KEY, OLLAMA_BASE_URL
                        provider configuration written to .env

The existing .env is merged, not overwritten. Secrets already present are
kept. Data volumes are never removed.
EOF
}

# Read a KEY=value line from a dotenv file without executing the file.
# Strips an inline comment, surrounding whitespace and matching quotes.
env_get() {
  local key="$1" file="$2" line value
  [ -f "$file" ] || return 1
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" | tail -n 1 || true)"
  [ -n "$line" ] || return 1
  value="${line#*=}"
  value="${value%$'\r'}"
  case "$value" in
    \'*\')
      value="${value#\'}"
      value="${value%\'}"
      ;;
    \"*\")
      value="${value#\"}"
      value="${value%\"}"
      ;;
    *)
      value="$(printf '%s' "$value" | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//')"
      ;;
  esac
  printf '%s' "$value"
}

# Quote a dotenv value when it contains anything outside a conservative safe
# set. Single quotes stop Compose interpolation; values with a single quote or
# a newline are refused rather than mis-encoded.
env_quote() {
  local value="$1"
  case "$value" in
    *$'\n'*|*$'\r'*) die "a value to write into .env contains a newline" ;;
    *"'"*) die "a value to write into .env contains a single quote; store it in the UI or edit .env by hand" ;;
  esac
  case "$value" in
    *[!A-Za-z0-9._/:@+=-]*) printf "'%s'" "$value" ;;
    *) printf '%s' "$value" ;;
  esac
}

# Replace (or append) one key in a dotenv file, preserving every other line,
# including comments and keys this installer does not manage. The value is
# passed through the environment so awk never interprets backslashes in it.
set_env_value() {
  local key="$1" value="$2" file="$3" tmp
  [ -f "$file" ] || : > "$file"
  value="$(env_quote "$value")"
  tmp="$(mktemp)"
  K="$key" V="$value" awk '
    BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
    { sub(/\r$/, "") }
    $0 ~ ("^[[:space:]]*(export[[:space:]]+)?" k "=") {
      if (!done) { print k "=" v; done = 1 }
      next
    }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" > "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

# Ubuntu's python3 is installed by install_base_packages; openssl is the
# fallback for a stripped-down image.
generate_secret() {
  if have python3 && python3 -c 'import secrets' >/dev/null 2>&1; then
    python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
  elif have openssl; then
    openssl rand -base64 48 | tr -d '\r\n='
  else
    die "neither a working python3 nor openssl is available to generate a secret"
  fi
}

generate_password() {
  if have python3 && python3 -c 'import secrets' >/dev/null 2>&1; then
    python3 -c 'import secrets; print(secrets.token_urlsafe(18))'
  elif have openssl; then
    openssl rand -base64 24 | tr -d '\r\n='
  else
    die "neither a working python3 nor openssl is available to generate an admin password"
  fi
}

major_version() {
  printf '%s' "$1" | sed -E 's/^[^0-9]*([0-9]+).*/\1/'
}

# -----------------------------------------------------------------------------
# Preconditions
# -----------------------------------------------------------------------------
require_root() {
  [ "$(id -u)" -eq 0 ] || die "run this installer as root (sudo ./deploy/vps/install.sh)"
}

require_ubuntu() {
  [ -r /etc/os-release ] || die "cannot read /etc/os-release; this installer supports Ubuntu 22.04 and 24.04"
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = "ubuntu" ] || die "this installer targets Ubuntu; detected ID=${ID:-unknown}"
  case "${VERSION_ID:-}" in
    22.04|24.04) ;;
    *) die "this installer supports Ubuntu 22.04 and 24.04; detected ${VERSION_ID:-unknown}" ;;
  esac
  have systemctl || die "systemd is required (this installer manages Docker, Caddy and cron as services)"
}

install_base_packages() {
  export DEBIAN_FRONTEND=noninteractive
  log "installing base packages"
  apt-get update -y
  # python3 is required by scripts/backup.sh when the sqlite3 CLI is absent
  # (the Docker backup still runs its integrity checks on the host).
  apt-get install -y --no-install-recommends \
    git curl ca-certificates ufw cron python3 logrotate
}

# -----------------------------------------------------------------------------
# Repository checkout
# -----------------------------------------------------------------------------
resolve_checkout() {
  local script_root
  script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"

  # A checkout that contains this script is the natural target when the caller
  # did not point CREW_DIR somewhere else. This is the path cloud-init uses:
  # it clones /opt/crew, then runs /opt/crew/deploy/vps/install.sh.
  if [ "$CREW_DIR_EXPLICIT" -eq 0 ] && [ -f "$script_root/$COMPOSE_FILE_NAME" ]; then
    CREW_DIR="$script_root"
  fi

  if [ -d "$CREW_DIR/.git" ] && [ -f "$CREW_DIR/$COMPOSE_FILE_NAME" ]; then
    log "using the existing checkout at $CREW_DIR"
    return 0
  fi

  if [ -e "$CREW_DIR" ]; then
    if [ -d "$CREW_DIR" ] && [ -z "$(ls -A -- "$CREW_DIR" 2>/dev/null)" ]; then
      : # An empty directory is fine: git clone can populate it.
    else
      die "$CREW_DIR exists but is not a Crew checkout (expected .git/ and $COMPOSE_FILE_NAME); move it aside or set CREW_DIR"
    fi
  fi

  mkdir -p -- "$(dirname -- "$CREW_DIR")"
  log "cloning $CREW_REPO_URL (ref: $CREW_REF) into $CREW_DIR"
  git clone --depth 1 --branch "$CREW_REF" -- "$CREW_REPO_URL" "$CREW_DIR" \
    || die "git clone failed; check CREW_REPO_URL and CREW_REF and that this host can reach the repository"
  [ -f "$CREW_DIR/$COMPOSE_FILE_NAME" ] || die "the clone at $CREW_DIR does not look like a Crew checkout"
}

# -----------------------------------------------------------------------------
# Configuration collection
# -----------------------------------------------------------------------------
ask() {
  local prompt="$1" default="${2:-}" answer
  if [ -n "$default" ]; then
    read -r -p "$prompt [$default]: " answer || die "standard input closed while prompting"
  else
    read -r -p "$prompt: " answer || die "standard input closed while prompting"
  fi
  printf '%s' "${answer:-$default}"
}

# Defaults come from the installer's own state file, then from the existing
# .env, then from the Caddyfile. This is what makes an interactive re-run
# quick without ever writing a secret into the state file.
load_defaults() {
  local value

  if [ -f "$STATE_FILE" ]; then
    if [ -z "$CREW_DOMAIN" ]; then
      value="$(env_get CREW_DOMAIN "$STATE_FILE" || true)"
      CREW_DOMAIN="$value"
    fi
    if [ -z "$CREW_ACME_EMAIL" ]; then
      value="$(env_get CREW_ACME_EMAIL "$STATE_FILE" || true)"
      CREW_ACME_EMAIL="$value"
    fi
    if [ -z "$CREW_ADMIN_EMAIL" ]; then
      value="$(env_get CREW_ADMIN_EMAIL "$STATE_FILE" || true)"
      CREW_ADMIN_EMAIL="$value"
    fi
  fi

  if [ -z "$CREW_DOMAIN" ] && [ -f "$CREW_DIR/.env" ]; then
    value="$(env_get CREW_PUBLIC_ORIGIN "$CREW_DIR/.env" || true)"
    case "$value" in
      https://*)
        value="${value#https://}"
        CREW_DOMAIN="${value%/}"
        ;;
    esac
  fi

  if [ -z "$CREW_ACME_EMAIL" ] && [ -f "$CADDYFILE" ]; then
    value="$(sed -nE 's/^[[:space:]]*email[[:space:]]+([^[:space:]]+).*/\1/p' "$CADDYFILE" | head -n 1)"
    value="${value#\"}"
    value="${value%\"}"
    CREW_ACME_EMAIL="$value"
  fi
}

collect_settings() {
  if [ "$NONINTERACTIVE" != "1" ]; then
    CREW_DOMAIN="$(ask 'Public DNS name (no https://)' "$CREW_DOMAIN")"
    CREW_ACME_EMAIL="$(ask 'Email for the Let'\''s Encrypt / ACME account' "$CREW_ACME_EMAIL")"
    CREW_ADMIN_EMAIL="$(ask 'Email for the first Crew admin account' "$CREW_ADMIN_EMAIL")"

    local key value current
    for key in "${PROVIDER_ENV_KEYS[@]}"; do
      current="${!key:-}"
      if [ -z "$current" ] && [ -f "$CREW_DIR/.env" ]; then
        current="$(env_get "$key" "$CREW_DIR/.env" || true)"
      fi
      if [ -n "$current" ]; then
        printf '%s is already configured; leave blank to keep it.\n' "$key" >&2
      fi
      value="$(ask "$key (optional, blank to keep or skip)" "")"
      if [ -n "$value" ]; then
        printf -v "$key" '%s' "$value"
      fi
    done
    return 0
  fi

  local missing=""
  [ -n "$CREW_DOMAIN" ] || missing="$missing CREW_DOMAIN"
  [ -n "$CREW_ACME_EMAIL" ] || missing="$missing CREW_ACME_EMAIL"
  [ -n "$CREW_ADMIN_EMAIL" ] || missing="$missing CREW_ADMIN_EMAIL"
  if [ -n "$missing" ]; then
    die "non-interactive mode requires:$missing"
  fi
}

validate_settings() {
  # DNS names are case-insensitive; lowercasing keeps the Caddy site address,
  # the CORS origin and the compiled frontend base byte-identical.
  CREW_DOMAIN="$(printf '%s' "$CREW_DOMAIN" | tr '[:upper:]' '[:lower:]')"
  case "$CREW_DOMAIN" in
    *://*|*/*|*" "*|*$'\n'*) die "CREW_DOMAIN must be a bare DNS name without a scheme or path (for example crew.example.com)" ;;
  esac
  if ! printf '%s' "$CREW_DOMAIN" | grep -Eq '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$'; then
    die "CREW_DOMAIN is not a valid public DNS name: $CREW_DOMAIN"
  fi
  [ "${#CREW_DOMAIN}" -le 253 ] || die "CREW_DOMAIN is longer than 253 characters"

  local email
  for email in "$CREW_ACME_EMAIL" "$CREW_ADMIN_EMAIL"; do
    if ! printf '%s' "$email" | grep -Eq '^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$'; then
      die "not a usable email address: $email"
    fi
  done

  case "$CREW_DIR" in
    /*) ;;
    *) die "CREW_DIR must be an absolute path (got: $CREW_DIR)" ;;
  esac
  case "$CREW_DIR" in
    *[!A-Za-z0-9._/-]*) die "CREW_DIR must not contain spaces or unusual characters; it is written into a cron job" ;;
  esac

  if [ -n "$CREW_ADMIN_PASSWORD" ] && [ "${#CREW_ADMIN_PASSWORD}" -lt 12 ]; then
    die "CREW_ADMIN_PASSWORD must be at least 12 characters"
  fi
  case "$CREW_ADMIN_NAME" in
    *$'\n'*|*$'\r'*) die "CREW_ADMIN_NAME must be a single line" ;;
  esac
}

save_state() {
  local old_umask
  old_umask="$(umask)"
  umask 077
  mkdir -p "$STATE_DIR"
  {
    printf 'CREW_DOMAIN=%s\n' "$CREW_DOMAIN"
    printf 'CREW_ACME_EMAIL=%s\n' "$CREW_ACME_EMAIL"
    printf 'CREW_ADMIN_EMAIL=%s\n' "$CREW_ADMIN_EMAIL"
  } > "$STATE_FILE"
  chmod 600 "$STATE_FILE"
  umask "$old_umask"
}

# -----------------------------------------------------------------------------
# Docker Engine and Compose v2
# -----------------------------------------------------------------------------
install_docker() {
  if have docker; then
    log "Docker is already installed; starting it"
    systemctl enable --now docker >/dev/null 2>&1 || true
  else
    log "installing Docker Engine from the Ubuntu archive (docker.io)"
    apt-get install -y --no-install-recommends docker.io \
      || die "could not install docker.io. Docker Engine 26 or newer is required; install it from Docker's official apt repository and re-run."
    systemctl enable --now docker >/dev/null 2>&1 || true
  fi

  if ! docker compose version >/dev/null 2>&1; then
    log "installing the Docker Compose v2 plugin (docker-compose-v2)"
    apt-get install -y --no-install-recommends docker-compose-v2 \
      || die "could not install the Docker Compose v2 plugin from the Ubuntu archive. On Ubuntu 22.04 install Docker Engine 26+ and the Compose plugin from Docker's official apt repository, then re-run. The legacy docker-compose v1 package is not supported."
  fi

  # The socket appears a moment after the daemon starts.
  for _ in $(seq 1 30); do
    [ -S /var/run/docker.sock ] && break
    sleep 1
  done
  [ -S /var/run/docker.sock ] || die "the Docker socket /var/run/docker.sock did not appear; check: systemctl status docker"

  local engine compose_version
  engine="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
  [ -n "$engine" ] || die "the Docker daemon is not answering; check: systemctl status docker"

  # The sandbox broker creates command containers with
  # `--mount type=volume,...,volume-subpath=...`; Engine 26 is the first release
  # that accepts that mount (docs/DEPLOYING.md section 3).
  if [ "$(major_version "$engine")" -lt 26 ]; then
    die "Docker Engine $engine is too old: the sandbox broker needs volume-subpath support (Engine 26+). Install Docker Engine 26+ from Docker's official apt repository and re-run."
  fi

  compose_version="$(docker compose version --short 2>/dev/null || true)"
  [ -n "$compose_version" ] || die "the 'docker compose' plugin is missing; install Docker Compose v2"
  if [ "$(major_version "${compose_version#v}")" -lt 2 ]; then
    die "Docker Compose $compose_version is too old; install Compose v2"
  fi

  log "Docker Engine $engine, Compose $compose_version"
}

install_caddy() {
  if ! have caddy; then
    log "installing Caddy from the Ubuntu archive"
    apt-get install -y --no-install-recommends caddy \
      || die "could not install Caddy from the Ubuntu archive"
  fi
  systemctl enable caddy >/dev/null 2>&1 || true
}

# -----------------------------------------------------------------------------
# .env (mode 600, merged with what is already there)
# -----------------------------------------------------------------------------
write_env_file() {
  local env_file="$CREW_DIR/.env"
  local existing_jwt jwt bind project socket_gid old_umask
  local backend_port frontend_port key value

  old_umask="$(umask)"
  umask 077
  if [ -f "$env_file" ]; then
    cp -p "$env_file" "${env_file}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
    chmod 600 "${env_file}".bak.* 2>/dev/null || true
  else
    : > "$env_file"
    {
      printf '%s\n' '# Generated by deploy/vps/install.sh; mode 600 because it holds secrets.'
      printf '%s\n' '# Every key the application reads is documented in .env.example.'
      printf '%s\n' '# Re-running the installer merges values and preserves existing secrets.'
      printf '\n'
    } >> "$env_file"
  fi

  # A valid secret already in .env survives a re-run. An explicit value in the
  # environment is a deliberate rotation and wins (every session is signed out).
  existing_jwt="$(env_get CREW_JWT_SECRET "$env_file" || true)"
  if [ -n "$CREW_JWT_SECRET" ]; then
    [ "${#CREW_JWT_SECRET}" -ge 32 ] || die "CREW_JWT_SECRET must be at least 32 characters"
    jwt="$CREW_JWT_SECRET"
  elif [ -n "$existing_jwt" ] && [ "${#existing_jwt}" -ge 32 ]; then
    jwt="$existing_jwt"
  else
    jwt="$(generate_secret)"
    if [ -n "$existing_jwt" ]; then
      warn "the existing CREW_JWT_SECRET was shorter than 32 characters; replacing it (existing sessions are invalidated)"
    fi
  fi
  [ "${#jwt}" -ge 32 ] || die "failed to produce a CREW_JWT_SECRET of at least 32 characters"
  set_env_value CREW_JWT_SECRET "$jwt" "$env_file"

  # The UI and the API share one origin through Caddy. The UI's API base is
  # compiled from CREW_PUBLIC_ORIGIN at image build time, so .env must be final
  # before `docker compose build` (build_and_start runs later on purpose).
  set_env_value CREW_CORS_ORIGINS "https://$CREW_DOMAIN" "$env_file"
  set_env_value CREW_PUBLIC_ORIGIN "https://$CREW_DOMAIN" "$env_file"

  # Loopback publishing is the trust boundary between the containers and the
  # proxy. Preserve a deliberate override, but say what it means.
  bind="$(env_get CREW_BIND_HOST "$env_file" || true)"
  [ -n "$bind" ] || bind="127.0.0.1"
  if [ "$bind" != "127.0.0.1" ]; then
    warn "CREW_BIND_HOST is $bind, not 127.0.0.1; the API and UI are reachable outside Caddy without TLS. Keep loopback unless the proxy runs elsewhere."
  fi
  set_env_value CREW_BIND_HOST "$bind" "$env_file"

  backend_port="$(env_get CREW_BACKEND_PORT "$env_file" || true)"
  [ -n "$backend_port" ] || backend_port="8787"
  frontend_port="$(env_get CREW_FRONTEND_PORT "$env_file" || true)"
  [ -n "$frontend_port" ] || frontend_port="5173"
  case "$backend_port" in ''|*[!0-9]*) die "CREW_BACKEND_PORT is not a number: $backend_port" ;; esac
  case "$frontend_port" in ''|*[!0-9]*) die "CREW_FRONTEND_PORT is not a number: $frontend_port" ;; esac
  if [ "$backend_port" -lt 1 ] || [ "$backend_port" -gt 65535 ]; then
    die "CREW_BACKEND_PORT is out of range"
  fi
  if [ "$frontend_port" -lt 1 ] || [ "$frontend_port" -gt 65535 ]; then
    die "CREW_FRONTEND_PORT is out of range"
  fi
  BACKEND_PORT="$backend_port"
  FRONTEND_PORT="$frontend_port"
  set_env_value CREW_BACKEND_PORT "$backend_port" "$env_file"
  set_env_value CREW_FRONTEND_PORT "$frontend_port" "$env_file"

  # The broker runs as uid 10001 and joins the socket's group; read the real
  # group instead of guessing (it differs between hosts and with rootless Docker).
  socket_gid="$(stat -c '%g' /var/run/docker.sock)"
  case "$socket_gid" in ''|*[!0-9]*) die "could not read the Docker socket's group id" ;; esac
  set_env_value DOCKER_SOCKET_GID "$socket_gid" "$env_file"

  # Stable project name: it prefixes the volume names. Changing it on a re-run
  # would point the stack at new, empty volumes.
  project="$(env_get COMPOSE_PROJECT_NAME "$env_file" || true)"
  [ -n "$project" ] || project="crew"
  set_env_value COMPOSE_PROJECT_NAME "$project" "$env_file"

  # Provider keys: an explicit environment value updates the file; otherwise a
  # key already stored there is preserved. Keys saved through the UI live in the
  # encrypted vault and are not touched by this file.
  for key in "${PROVIDER_ENV_KEYS[@]}"; do
    value="${!key:-}"
    if [ -z "$value" ]; then
      value="$(env_get "$key" "$env_file" || true)"
    fi
    if [ -n "$value" ]; then
      set_env_value "$key" "$value" "$env_file"
    fi
  done

  # Optional externally managed vault key. Blank is the normal case: the app
  # generates /data/vault.key on first boot and the backup script captures it.
  if [ -n "${CREW_VAULT_KEY:-}" ]; then
    set_env_value CREW_VAULT_KEY "$CREW_VAULT_KEY" "$env_file"
  fi

  chmod 600 "$env_file"
  chown root:root "$env_file"
  umask "$old_umask"
  log "wrote $env_file (mode 600)"
}

# -----------------------------------------------------------------------------
# Caddy: TLS, routing and the headers the proxy owns
# -----------------------------------------------------------------------------
write_caddyfile() {
  local tmp backup
  tmp="$(mktemp)"
  cat > "$tmp" <<EOF
{
    email $CREW_ACME_EMAIL
}

$CREW_DOMAIN {
    # /ws/ is the WebSocket endpoint, not under /api/. Both go to the API.
    @crew_api path /api /api/*
    handle @crew_api {
        reverse_proxy 127.0.0.1:$BACKEND_PORT
    }

    @crew_ws path /ws /ws/*
    handle @crew_ws {
        reverse_proxy 127.0.0.1:$BACKEND_PORT
    }

    handle {
        reverse_proxy 127.0.0.1:$FRONTEND_PORT
    }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        Content-Security-Policy "default-src 'self'; connect-src 'self' https://$CREW_DOMAIN wss://$CREW_DOMAIN; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        X-Frame-Options "DENY"
        -Server
    }
}
EOF

  # --adapter is explicit because the temporary file has no .caddyfile suffix.
  if ! caddy validate --adapter caddyfile --config "$tmp"; then
    rm -f "$tmp"
    die "the generated Caddyfile did not validate; nothing was changed"
  fi

  if [ -f "$CADDYFILE" ]; then
    backup="${CADDYFILE}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
    cp -p "$CADDYFILE" "$backup"
    log "previous Caddyfile saved as $backup"
  fi
  install -m 644 -o root -g root "$tmp" "$CADDYFILE"
  rm -f "$tmp"

  systemctl enable caddy >/dev/null 2>&1 || true
  if ! systemctl restart caddy; then
    die "Caddy failed to start; inspect: journalctl -u caddy -n 100 --no-pager"
  fi
  systemctl is-active --quiet caddy || die "Caddy is not active; inspect: journalctl -u caddy -n 100 --no-pager"
  log "Caddy is running for $CREW_DOMAIN"
}

# -----------------------------------------------------------------------------
# Firewall: never lock out SSH, then open HTTP/HTTPS
# -----------------------------------------------------------------------------
configure_ufw() {
  local allowed_ssh=0 port
  if ! have ufw; then
    apt-get install -y --no-install-recommends ufw
  fi

  # Docker publishes container ports through its own iptables rules, which
  # bypass UFW. That is acceptable here because the Compose file binds the API
  # and UI to 127.0.0.1 and never publishes the broker (8790). Do not widen
  # CREW_BIND_HOST and expect UFW to compensate.

  # Allow every port sshd is actually configured to listen on. This covers a
  # non-default port and cloud-init (where SSH_CONNECTION is unset); a stock
  # 22/tcp is the fallback.
  if have sshd; then
    while IFS= read -r port; do
      case "$port" in ''|*[!0-9]*) continue ;; esac
      ufw allow "${port}/tcp" >/dev/null
      allowed_ssh=1
    done < <(sshd -T 2>/dev/null | awk '$1 == "port" {print $2}')
  fi
  # `sshd -T` needs readable host keys; fall back to the config files when it
  # returns nothing (for example very early in cloud-init).
  if [ "$allowed_ssh" -eq 0 ]; then
    local config
    for config in /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf; do
      [ -r "$config" ] || continue
      while IFS= read -r port; do
        case "$port" in ''|*[!0-9]*) continue ;; esac
        ufw allow "${port}/tcp" >/dev/null
        allowed_ssh=1
      done < <(awk '$1 == "Port" {print $2}' "$config")
    done
  fi
  if [ -n "${SSH_CONNECTION:-}" ]; then
    port="$(printf '%s' "$SSH_CONNECTION" | awk '{print $4}')"
    if [ -n "$port" ] && [ "$port" != "22" ]; then
      ufw allow "${port}/tcp" >/dev/null
    fi
  fi
  if [ "$allowed_ssh" -eq 0 ]; then
    ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null
  fi

  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  log "UFW enabled (SSH, 80/tcp, 443/tcp)"
  ufw status | sed 's/^/[crew-install]   /'
}

# -----------------------------------------------------------------------------
# Stack
# -----------------------------------------------------------------------------
build_and_start() {
  cd "$CREW_DIR"
  log "building images and starting the production stack"
  # This is deliberately after write_env_file: the frontend image bakes
  # CREW_PUBLIC_ORIGIN into the bundle at build time and cannot be fixed later.
  docker compose -f "$COMPOSE_FILE_NAME" up -d --build \
    || die "docker compose up failed; inspect: docker compose -f $COMPOSE_FILE_NAME logs --tail=100"
  docker compose -f "$COMPOSE_FILE_NAME" ps
}

wait_for_health() {
  local url="http://127.0.0.1:${BACKEND_PORT}/api/health" deadline=$((SECONDS + 300))
  log "waiting for $url"
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
      log "the API is healthy"
      return 0
    fi
    sleep 3
  done
  docker compose -f "$COMPOSE_FILE_NAME" ps || true
  docker compose -f "$COMPOSE_FILE_NAME" logs --tail=80 backend sandbox frontend || true
  die "the API did not become healthy within 5 minutes; the container logs are above"
}

run_doctor() {
  log "running: python -m crew doctor"
  if docker compose -f "$COMPOSE_FILE_NAME" exec -T backend python -m crew doctor; then
    return 0
  fi
  DOCTOR_FAILED=1
  warn "doctor reported a problem; the stack is running. Re-run: docker compose -f $COMPOSE_FILE_NAME exec backend python -m crew doctor"
}

user_count() {
  local count
  count="$(docker compose -f "$COMPOSE_FILE_NAME" exec -T backend python -c \
    'import sqlite3; print(sqlite3.connect("file:/data/crew.db?mode=ro", uri=True).execute("SELECT COUNT(*) FROM users").fetchone()[0])' \
    2>/dev/null || true)"
  count="$(printf '%s' "$count" | tr -dc '0-9')"
  [ -n "$count" ] || return 1
  printf '%s' "$count"
}

ensure_admin() {
  local count password="$CREW_ADMIN_PASSWORD" out status generated=0 old_umask
  if ! count="$(user_count)"; then
    die "could not read the users table; the database is not ready"
  fi
  if [ "$count" -gt 0 ]; then
    log "the installation already has $count account(s); skipping the first-admin step"
    return 0
  fi

  if [ -z "$password" ]; then
    password="$(generate_password)"
    generated=1
  fi
  [ "${#password}" -ge 12 ] || die "the admin password must be at least 12 characters"

  # The CLI accepts --password and the value appears in the host process list
  # for the lifetime of this exec. It is never echoed to the log; with
  # CREW_ADMIN_PASSWORD unset the password only ever exists in memory and in
  # /root/crew-admin-password.txt (mode 600).
  set +e
  out="$(docker compose -f "$COMPOSE_FILE_NAME" exec -T backend python -m crew auth create-user \
    --email "$CREW_ADMIN_EMAIL" --name "$CREW_ADMIN_NAME" --role admin --password "$password" 2>&1)"
  status=$?
  set -e

  if [ "$status" -ne 0 ]; then
    case "$out" in
      *"already exists"*|*"UNIQUE constraint"*|*"IntegrityError"*)
        warn "the first admin already exists; leaving the account and any password file unchanged"
        return 0
        ;;
      *)
        printf '%s\n' "$out" >&2
        die "creating the first admin failed"
        ;;
    esac
  fi

  log "first admin created: $CREW_ADMIN_EMAIL"
  ADMIN_CREATED=1
  if [ "$generated" -eq 1 ]; then
    old_umask="$(umask)"
    umask 077
    printf '%s\n' "$password" > "$ADMIN_PASSWORD_FILE"
    chmod 600 "$ADMIN_PASSWORD_FILE"
    chown root:root "$ADMIN_PASSWORD_FILE"
    umask "$old_umask"
    ADMIN_PASSWORD_GENERATED=1
  fi
}

# -----------------------------------------------------------------------------
# Nightly backup
# -----------------------------------------------------------------------------
install_backup_cron() {
  if ! have cron; then
    apt-get install -y --no-install-recommends cron
  fi

  chmod +x "$CREW_DIR/scripts/backup.sh" "$CREW_DIR/scripts/restore.sh"
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  touch "$BACKUP_LOG"
  chmod 600 "$BACKUP_LOG"

  # The crontab runs as root and cd's into the checkout so Compose finds .env.
  # CREW_DIR is validated above to contain no whitespace, so this line needs no
  # shell quoting.
  cat > "$CRON_FILE" <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=""
15 3 * * * root cd $CREW_DIR && ./scripts/backup.sh --mode docker --dest $BACKUP_DIR --label nightly --keep 14 >> $BACKUP_LOG 2>&1
EOF
  chmod 644 "$CRON_FILE"
  chown root:root "$CRON_FILE"

  cat > "$LOGROTATE_FILE" <<EOF
$BACKUP_LOG {
    weekly
    rotate 8
    compress
    missingok
    notifempty
    create 0600 root root
}
EOF
  chmod 644 "$LOGROTATE_FILE"

  systemctl enable --now cron >/dev/null 2>&1 || systemctl enable --now cron.service >/dev/null 2>&1 \
    || die "could not enable cron"
  log "nightly backup scheduled at 03:15 (14 generations kept in $BACKUP_DIR)"
}

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
print_summary() {
  local password_note doctor_note
  if [ "$ADMIN_PASSWORD_GENERATED" -eq 1 ]; then
    password_note="generated on this run; stored in $ADMIN_PASSWORD_FILE (mode 600)"
  elif [ "$ADMIN_CREATED" -eq 1 ]; then
    password_note="the value in CREW_ADMIN_PASSWORD; not written to disk"
  elif [ -f "$ADMIN_PASSWORD_FILE" ]; then
    password_note="from an earlier run; stored in $ADMIN_PASSWORD_FILE (mode 600)"
  else
    password_note="not generated on this run (the account already existed); see deploy/vps/README.md to rotate it"
  fi
  if [ "$DOCTOR_FAILED" -eq 1 ]; then
    doctor_note="reported a problem; re-run it after checking the logs"
  else
    doctor_note="completed; the checks printed above are the source of truth"
  fi

  cat <<EOF

Crew deployment summary
-----------------------
  URL:             https://$CREW_DOMAIN
  Admin email:     $CREW_ADMIN_EMAIL
  Admin password:  $password_note
  Checkout:        $CREW_DIR
  Compose file:    $CREW_DIR/$COMPOSE_FILE_NAME
  Backups:         $BACKUP_DIR nightly at 03:15 (keep 14); log: $BACKUP_LOG
  Installer state: $STATE_FILE (mode 600)
  Doctor:          $doctor_note

Caddy obtains a TLS certificate automatically once $CREW_DOMAIN resolves to
this host. If DNS was not ready, it retries; watch it with:
  journalctl -u caddy -f

SECURITY: read docs/DEPLOYING.md sections 9 and 15 before inviting users.
The sandbox broker mounts the host Docker socket and is host-level authority.
This release is single-tenant: one trusted workspace, one API process, SQLite.
Never publish port 8790. Keep the Docker engine patched. Copy backups off this
machine; a backup that lives only on the host it protects is not a backup.
EOF
}

# -----------------------------------------------------------------------------
main() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h|--help) usage; exit 0 ;;
      *) die "unknown argument: $1 (see --help)" ;;
    esac
  done

  require_root
  require_ubuntu

  # A script run by cloud-init (or through a pipe) has no tty on stdin: that is
  # non-interactive mode, and the three required values must come from the
  # environment (or /etc/crew/deploy.env, which the caller sources).
  if [ "$NONINTERACTIVE" = "1" ] || [ ! -t 0 ]; then
    NONINTERACTIVE=1
  fi

  install_base_packages
  resolve_checkout
  load_defaults
  collect_settings
  validate_settings
  save_state
  install_docker
  install_caddy
  write_env_file
  write_caddyfile
  configure_ufw
  build_and_start
  wait_for_health
  run_doctor
  ensure_admin
  install_backup_cron
  print_summary
}

main "$@"
