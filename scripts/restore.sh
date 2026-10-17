#!/usr/bin/env bash
# Crew restore: put a generation produced by scripts/backup.sh back and verify it.
#
# A restore replaces a live database, so unlike the backup this script stops the
# API: a writer cannot be swapped underneath. It refuses to run while the API
# answers unless --force is given, keeps a pre-restore copy of what it is about
# to overwrite, and verifies the restored database and vault key before it
# reports success.
#
#   scripts/restore.sh --from /srv/backups/crew/20261017T090000Z-manual
#   scripts/restore.sh --mode docker --from /srv/backups/crew/20261017T090000Z-manual
#
# Read docs/DEPLOYING.md before restoring. Exit codes: 0 ok, 2 usage or preflight
# failure, 3 tooling missing, 4 verification failed.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SELF_DIR}/.." && pwd -P)"

MODE=host
FROM=""
DATA_DIR=""
WORKSPACE_DIR=""
COMPOSE_FILE="${REPO_ROOT}/docker-compose.prod.yml"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-crew}"
DATA_VOLUME=""
WORKSPACE_VOLUME=""
HELPER_IMAGE="alpine:3.21"
BACKEND_IMAGE="crew-backend:${CREW_IMAGE_TAG:-prod}"
API_PORT="${CREW_BACKEND_PORT:-8787}"
FORCE=0
ALLOW_MISSING_VAULT_KEY=0
REPLACE_WORKSPACES=0
NO_WORKSPACES=0
DRY_RUN=0
PY_BIN=""

usage() {
  cat <<'EOF'
Usage: scripts/restore.sh --from DIR [options]

  --from DIR            Required. A generation directory written by scripts/backup.sh.

  --mode host|docker    Where the installation lives (default: host).
  --data-dir DIR        host: data directory to restore into (default: $CREW_DATA_DIR, else repo data/)
  --workspace-dir DIR   host: workspace root to restore into (default: $CREW_WORKSPACE_ROOT, else repo workspaces/)
  --no-workspaces       host: restore the database and the vault key only.
  --replace-workspaces  Delete the current workspace contents before copying. Needs --force.
  --compose-file FILE   docker: compose file (default: docker-compose.prod.yml)
  --data-volume NAME    docker: data volume (default: <project>_crew-data)
  --workspace-volume N  docker: workspace volume (default: <project>-workspaces)
  --backend-image IMG   docker: image used for the post-restore database check
  --helper-image IMG    docker: small image used to copy files into the volumes
  --port N              Port the API answers on; a live answer needs --force (default: 8787)

  --force               Proceed even though the API answers, or after a warning.
  --allow-missing-vault-key  Restore the database without a vault key. Stored
                        provider keys stay undecryptable; the file is not replaced.
  --dry-run             Verify the generation and print the plan, change nothing.

Exit codes: 0 ok, 2 usage or preflight failure, 3 tooling missing, 4 verification failed.
EOF
}

die() { printf 'restore: %s\n' "$*" >&2; exit "${2:-2}"; }
log() { printf 'restore: %s\n' "$*"; }
warn() { printf 'restore: warning: %s\n' "$*" >&2; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --from) FROM="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
    --workspace-dir) WORKSPACE_DIR="${2:-}"; shift 2 ;;
    --no-workspaces) NO_WORKSPACES=1; shift ;;
    --replace-workspaces) REPLACE_WORKSPACES=1; shift ;;
    --compose-file) COMPOSE_FILE="${2:-}"; shift 2 ;;
    --data-volume) DATA_VOLUME="${2:-}"; shift 2 ;;
    --workspace-volume) WORKSPACE_VOLUME="${2:-}"; shift 2 ;;
    --backend-image) BACKEND_IMAGE="${2:-}"; shift 2 ;;
    --helper-image) HELPER_IMAGE="${2:-}"; shift 2 ;;
    --port) API_PORT="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --allow-missing-vault-key) ALLOW_MISSING_VAULT_KEY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$FROM" ] || { usage >&2; die "the generation to restore is required (--from DIR)"; }
case "$MODE" in host|docker) ;; *) die "--mode must be host or docker" ;; esac
[ -d "$FROM" ] || die "the generation directory $FROM does not exist"
FROM_ABS="$(cd "$FROM" && pwd -P)"
if [ ! -e "${FROM_ABS}/data/crew.db" ] && [ ! -e "${FROM_ABS}/crew.db" ]; then
  die "no crew.db in ${FROM_ABS}; nothing to restore"
fi
if [ -e "${FROM_ABS}/data/crew.db" ]; then SRC_DATA="${FROM_ABS}/data"; else SRC_DATA="$FROM_ABS"; fi
SRC_WORKSPACES="${FROM_ABS}/workspaces"

pick_python() {
  if [ -n "$PY_BIN" ]; then printf '%s' "$PY_BIN"; return 0; fi
  local candidate
  for candidate in python3 python py; do
    if command -v "$candidate" >/dev/null 2>&1; then
      if "$candidate" -c 'import sqlite3' >/dev/null 2>&1; then PY_BIN="$candidate"; printf '%s' "$PY_BIN"; return 0; fi
    fi
  done
  return 1
}

have_sqlite3() { command -v sqlite3 >/dev/null 2>&1; }

# Native tools are handed native paths: git-bash resolves everything as /c/..., which
# a native python or a Windows docker CLI would not open.
py_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w -- "$1"; else printf '%s' "$1"; fi
}

integrity_check() {
  local db="$1" result
  if have_sqlite3; then
    result="$(sqlite3 "$(py_path "$db")" 'PRAGMA integrity_check;')"
  else
    local py
    py="$(pick_python)" || die "no sqlite3 CLI and no python interpreter for the integrity check" 3
    result="$("$py" -c 'import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute("PRAGMA integrity_check").fetchone()[0])' "$(py_path "$db")")"
  fi
  [ "$result" = "ok" ] || die "integrity check of $db reported: $result" 4
}

count_tables() {
  local db="$1"
  if have_sqlite3; then
    sqlite3 "$(py_path "$db")" "select count(*) from sqlite_master where type='table';"
  else
    "$(pick_python)" -c 'import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute("select count(*) from sqlite_master where type=\x27table\x27").fetchone()[0])' "$(py_path "$db")"
  fi
}

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# ---------------------------------------------------------------- verify source
log "verifying the generation ${FROM_ABS}"
integrity_check "${SRC_DATA}/crew.db"
SRC_TABLES="$(count_tables "${SRC_DATA}/crew.db")"
if [ "$SRC_TABLES" -lt 1 ]; then die "the database in the generation has no tables" 4; fi
log "database: ${SRC_TABLES} tables, integrity ok"
if [ -f "${FROM_ABS}/SHA256SUMS" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    if ( cd "$FROM_ABS" && sha256sum -c --quiet SHA256SUMS ); then
      log "checksums verified"
    else
      die "the generation does not match its SHA256SUMS; it is damaged or was modified" 4
    fi
  else
    warn "sha256sum is not available; the generation checksums were not verified"
  fi
else
  warn "the generation has no SHA256SUMS file; integrity was checked on the database only"
fi
if [ -f "${SRC_DATA}/vault.key" ]; then
  log "vault key present"
elif [ "$ALLOW_MISSING_VAULT_KEY" -eq 1 ]; then
  warn "the generation has no vault.key; stored provider keys will stay undecryptable"
else
  die "the generation has no data/vault.key. Without it every stored provider key is lost. Restore the key, or pass --allow-missing-vault-key to accept that"
fi

# ------------------------------------------------------------- verify destination
if [ "$MODE" = "host" ]; then
  [ -n "$DATA_DIR" ] || DATA_DIR="${CREW_DATA_DIR:-${REPO_ROOT}/data}"
  mkdir -p "$DATA_DIR"
  DATA_ABS="$(cd "$DATA_DIR" && pwd -P)"
  if [ "$NO_WORKSPACES" -eq 1 ]; then
    WORKSPACE_ABS=""
  else
    [ -n "$WORKSPACE_DIR" ] || WORKSPACE_DIR="${CREW_WORKSPACE_ROOT:-${REPO_ROOT}/workspaces}"
    mkdir -p "$WORKSPACE_DIR"
    WORKSPACE_ABS="$(cd "$WORKSPACE_DIR" && pwd -P)"
  fi
  case "${FROM_ABS}/" in
    "${DATA_ABS}/"*) die "the generation is inside the data directory it would restore into" ;;
  esac
  if [ -n "$WORKSPACE_ABS" ]; then
    case "${FROM_ABS}/" in
      "${WORKSPACE_ABS}/"*) die "the generation is inside the workspace it would restore into" ;;
    esac
  fi
  case "${DATA_ABS}/" in
    "${FROM_ABS}/"*) die "the data directory is inside the generation; choose another --data-dir" ;;
  esac
  if [ ! -f "${SRC_DATA}/crew.db" ]; then die "the generation has no data/crew.db"; fi
  if [ -n "$WORKSPACE_ABS" ] && [ ! -d "$SRC_WORKSPACES" ]; then
    warn "the generation has no workspaces directory; only data and the vault key will be restored"
  fi
else
  command -v docker >/dev/null 2>&1 || die "docker is not available" 3
  [ -f "$COMPOSE_FILE" ] || die "the compose file $COMPOSE_FILE does not exist (--compose-file)"
  [ -n "$DATA_VOLUME" ] || DATA_VOLUME="${PROJECT_NAME}_crew-data"
  [ -n "$WORKSPACE_VOLUME" ] || WORKSPACE_VOLUME="${PROJECT_NAME}-workspaces"
  if docker volume ls --format '{{.Name}}' | grep -qx "$DATA_VOLUME"; then :; else die "the data volume $DATA_VOLUME does not exist (--data-volume)"; fi
  if docker volume ls --format '{{.Name}}' | grep -qx "$WORKSPACE_VOLUME"; then :; else warn "the workspace volume $WORKSPACE_VOLUME does not exist; it will be created empty"; fi
fi

# ------------------------------------------------------------- is the API alive?
if [ "$MODE" = "host" ] && command -v curl >/dev/null 2>&1; then
  STATUS="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:${API_PORT}/api/health" 2>/dev/null || true)"
  if [ -z "$STATUS" ]; then STATUS="000"; fi
  STATUS="$(printf '%s' "$STATUS" | tr -cd '0-9' | cut -c1-3)"
  if [ -z "$STATUS" ]; then STATUS="000"; fi
  if [ "$STATUS" != "000" ]; then
    if [ "$FORCE" -eq 1 ]; then
      warn "the API answered HTTP ${STATUS} on port ${API_PORT} and --force was given; an active writer can corrupt what follows"
    else
      die "the API answered HTTP ${STATUS} on port ${API_PORT}. Stop it first (docker compose -f ${COMPOSE_FILE} stop backend, or stop the native process), or pass --force"
    fi
  fi
fi
if [ "$REPLACE_WORKSPACES" -eq 1 ] && [ "$FORCE" -ne 1 ]; then
  die "--replace-workspaces deletes current workspace files; pass --force to confirm"
fi

log "mode=${MODE} from=${FROM_ABS}"
if [ "$MODE" = "host" ]; then
  log "destination data dir: ${DATA_ABS}"
  if [ -n "${WORKSPACE_ABS:-}" ]; then log "destination workspace: ${WORKSPACE_ABS}"; else log "destination workspace: skipped (--no-workspaces)"; fi
else
  log "compose file: ${COMPOSE_FILE}"
  log "data volume: ${DATA_VOLUME}"
  log "workspace volume: ${WORKSPACE_VOLUME}"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry run: the generation verifies and nothing was changed"
  exit 0
fi

# ------------------------------------------------------------ pre-restore safety
SAFETY=""
if [ "$MODE" = "host" ]; then
  if [ -f "${DATA_ABS}/crew.db" ]; then
    SAFETY="${DATA_ABS}.pre-restore-${STAMP}"
    log "keeping the current data directory in ${SAFETY}"
    mkdir -p "$SAFETY"
    cp -a "${DATA_ABS}/." "$SAFETY/"
  fi
else
  SAFETY="${REPO_ROOT}/data.pre-restore-${STAMP}"
  log "keeping the current data volume in ${SAFETY}"
  mkdir -p "$SAFETY"
  docker run --rm -v "${DATA_VOLUME}:/src:ro" -v "$(py_path "$SAFETY"):/out" "$HELPER_IMAGE" sh -c 'cd /src && cp -a . /out/'
fi

# ------------------------------------------------------------ restore
if [ "$MODE" = "host" ]; then
  rm -f "${DATA_ABS}/crew.db" "${DATA_ABS}/crew.db-wal" "${DATA_ABS}/crew.db-shm"
  cp -p "${SRC_DATA}/crew.db" "${DATA_ABS}/crew.db"
  if [ -f "${SRC_DATA}/vault.key" ]; then
    cp -p "${SRC_DATA}/vault.key" "${DATA_ABS}/vault.key"
    chmod 600 "${DATA_ABS}/vault.key" 2>/dev/null || warn "could not set mode 0600 on vault.key; restrict it with the platform's own permissions"
  fi
  for extra in runtime-mode.json provider.json; do
    if [ -f "${SRC_DATA}/${extra}" ]; then cp -p "${SRC_DATA}/${extra}" "${DATA_ABS}/${extra}"; fi
  done
  if [ -n "${WORKSPACE_ABS:-}" ] && [ -d "$SRC_WORKSPACES" ]; then
    if [ "$REPLACE_WORKSPACES" -eq 1 ]; then
      log "emptying ${WORKSPACE_ABS} before copying"
      find "${WORKSPACE_ABS}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    fi
    log "restoring the workspace tree (this can take a while)"
    cp -a "${SRC_WORKSPACES}/." "${WORKSPACE_ABS}/"
  fi
else
  log "stopping the backend service so nothing writes during the restore"
  docker compose -f "$COMPOSE_FILE" stop backend
  docker run --rm -v "${DATA_VOLUME}:/data" -v "$(py_path "$SRC_DATA"):/src:ro" "$HELPER_IMAGE" \
    sh -c 'rm -f /data/crew.db /data/crew.db-wal /data/crew.db-shm && cp -a /src/. /data/'
  if [ -d "$SRC_WORKSPACES" ] && [ "$NO_WORKSPACES" -ne 1 ]; then
    if [ "$REPLACE_WORKSPACES" -eq 1 ]; then
      docker run --rm -v "${WORKSPACE_VOLUME}:/ws" "$HELPER_IMAGE" sh -c 'find /ws -mindepth 1 -maxdepth 1 -exec rm -rf {} +'
    fi
    docker run --rm -v "${WORKSPACE_VOLUME}:/ws" -v "$(py_path "$SRC_WORKSPACES"):/src:ro" "$HELPER_IMAGE" sh -c 'cp -a /src/. /ws/'
  fi
fi

# ------------------------------------------------------------ verify the result
if [ "$MODE" = "host" ]; then
  integrity_check "${DATA_ABS}/crew.db"
  TABLES="$(count_tables "${DATA_ABS}/crew.db")"
  [ "$TABLES" -ge 1 ] || die "the restored database has no tables" 4
  if [ -f "${SRC_DATA}/vault.key" ] && [ ! -f "${DATA_ABS}/vault.key" ]; then die "vault.key was not restored" 4; fi
  if [ -n "${WORKSPACE_ABS:-}" ] && [ -d "$SRC_WORKSPACES" ]; then
    RESTORED="$(find "${WORKSPACE_ABS}" -type f 2>/dev/null | wc -l | tr -d ' ')"
    log "workspace files present: ${RESTORED}"
  fi
else
  if docker image inspect "$BACKEND_IMAGE" >/dev/null 2>&1; then
    docker run --rm -v "${DATA_VOLUME}:/data" --entrypoint python "$BACKEND_IMAGE" -c '
import sqlite3
import sys
con = sqlite3.connect("/data/crew.db")
result = con.execute("PRAGMA integrity_check").fetchone()[0]
tables = con.execute("select count(*) from sqlite_master where type=\x27table\x27").fetchone()[0]
print("integrity", result, "tables", tables)
sys.exit(0 if result == "ok" and tables > 0 else 1)
' || die "the restored database did not verify inside the volume" 4
  else
    warn "the image ${BACKEND_IMAGE} is not present, so the restored database was not verified; run the check after starting the API"
  fi
  docker run --rm -v "${DATA_VOLUME}:/data" "$HELPER_IMAGE" sh -c 'test -f /data/crew.db' \
    || die "no /data/crew.db in the volume after the restore" 4
  if [ -f "${SRC_DATA}/vault.key" ]; then
    docker run --rm -v "${DATA_VOLUME}:/data" "$HELPER_IMAGE" sh -c 'test -f /data/vault.key' \
      || die "vault.key is missing in the volume after the restore" 4
  fi
fi

log "verification passed: ${TABLES:-database} tables, integrity ok"
if [ -n "$SAFETY" ]; then log "the previous state is preserved in ${SAFETY}"; fi
cat <<EOF
restore: next steps
  1. start one API process (docker compose -f ${COMPOSE_FILE} start backend, or the native command)
  2. run: python -m crew doctor
  3. open the UI, sign in, and open an existing project before starting new work
  4. confirm stored provider keys decrypt (vault), then run: python -m crew audit verify
  5. if the vault cannot decrypt, the restored data does not belong with this vault key; restore the matching one
EOF
