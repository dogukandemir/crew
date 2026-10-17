#!/usr/bin/env bash
# Crew backup: a WAL-safe SQLite snapshot, the vault key, and the workspace
# volume, written OUTSIDE the volumes they protect.
#
# Nothing is stopped: the database copy uses SQLite's online backup API (the
# sqlite3 CLI if present, otherwise the python sqlite3 module), which is safe
# while the API is running and serving.
#
#   scripts/backup.sh --dest /srv/backups/crew
#   scripts/backup.sh --mode docker --dest /srv/backups/crew --label after-upgrade
#
# The destination is a required argument. Each run writes one generation
# directory named <UTC timestamp>-<label> and renames it into place only when
# every step succeeded, so a half-written generation is never mistaken for a
# good one. Read docs/DEPLOYING.md before relying on a backup.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SELF_DIR}/.." && pwd -P)"

MODE=host
DEST=""
LABEL=manual
KEEP=7
DATA_DIR=""
WORKSPACE_DIR=""
COMPOSE_FILE="${REPO_ROOT}/docker-compose.prod.yml"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-crew}"
WORKSPACE_VOLUME=""
HELPER_IMAGE="alpine:3.21"
NO_WORKSPACES=0
DRY_RUN=0
PY_BIN=""

usage() {
  cat <<'EOF'
Usage: scripts/backup.sh --dest DIR [options]

  --dest DIR            Required. Directory that receives the generations. It must
                        live outside the data directory and the workspace volume.
  --label NAME          Suffix in the generation name (default: manual).
  --keep N              Generations to keep in DIR (default: 7).

  --mode host|docker    Where the live installation runs (default: host).
                          host    the API runs on this machine; read the paths below
                          docker  the stack runs under Docker Compose; read the
                                  named volumes through the API container
  --data-dir DIR        host: data directory (default: $CREW_DATA_DIR, else repo data/)
  --workspace-dir DIR   host: workspace root (default: $CREW_WORKSPACE_ROOT, else repo workspaces/)
  --no-workspaces       host: skip the workspace tree. The manifest records it.
  --compose-file FILE   docker: compose file (default: docker-compose.prod.yml)
  --workspace-volume N  docker: workspace volume name (default: <project>-workspaces)
  --helper-image IMG    docker: small image used to copy the volume (default: alpine:3.21)
  --dry-run             Print what would be copied and exit.

Exit codes: 0 ok, 2 usage or preflight failure, 3 snapshot tooling missing,
4 verification failed.
EOF
}

die() { printf 'backup: %s\n' "$*" >&2; exit "${2:-2}"; }
log() { printf 'backup: %s\n' "$*"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dest) DEST="${2:-}"; shift 2 ;;
    --label) LABEL="${2:-}"; shift 2 ;;
    --keep) KEEP="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
    --workspace-dir) WORKSPACE_DIR="${2:-}"; shift 2 ;;
    --no-workspaces) NO_WORKSPACES=1; shift ;;
    --compose-file) COMPOSE_FILE="${2:-}"; shift 2 ;;
    --workspace-volume) WORKSPACE_VOLUME="${2:-}"; shift 2 ;;
    --helper-image) HELPER_IMAGE="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$DEST" ] || { usage >&2; die "the destination is required (--dest DIR)"; }
case "$MODE" in host|docker) ;; *) die "--mode must be host or docker" ;; esac
case "$KEEP" in ''|*[!0-9]*) die "--keep must be a whole number" ;; esac
[ "$KEEP" -ge 1 ] || die "--keep must be at least 1"

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
# a native python would not open.
py_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w -- "$1"; else printf '%s' "$1"; fi
}

# A snapshot taken with the online backup API, never a plain copy of a live file.
snapshot_db() {
  local src="$1" out="$2"
  if have_sqlite3; then
    sqlite3 "$(py_path "$src")" ".backup '$(py_path "$out")'"
  else
    local py
    py="$(pick_python)" || die "neither the sqlite3 CLI nor a python interpreter with the sqlite3 module is available; install one" 3
    "$py" - "$(py_path "$src")" "$(py_path "$out")" <<'PY'
import sqlite3
import sys

src, out = sys.argv[1], sys.argv[2]
source = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
target = sqlite3.connect(out)
with target:
    source.backup(target)
target.close()
source.close()
PY
  fi
  [ -s "$out" ] || die "the snapshot at $out is empty" 4
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

file_sum() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else printf 'unavailable'; fi
}

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LABEL="$(printf '%s' "$LABEL" | tr -c 'A-Za-z0-9._-' '-')"
GENERATION="${STAMP}-${LABEL}"

mkdir -p "$DEST" || die "cannot create the destination directory $DEST"
DEST_ABS="$(cd "$DEST" && pwd -P)"
GEN_ABS="${DEST_ABS}/${GENERATION}"

if [ "$MODE" = "host" ]; then
  [ -n "$DATA_DIR" ] || DATA_DIR="${CREW_DATA_DIR:-${REPO_ROOT}/data}"
  [ -d "$DATA_DIR" ] || die "the data directory $DATA_DIR does not exist (--data-dir)"
  DATA_ABS="$(cd "$DATA_DIR" && pwd -P)"
  if [ "$NO_WORKSPACES" -eq 1 ]; then
    WORKSPACE_ABS=""
  else
    [ -n "$WORKSPACE_DIR" ] || WORKSPACE_DIR="${CREW_WORKSPACE_ROOT:-${REPO_ROOT}/workspaces}"
    [ -d "$WORKSPACE_DIR" ] || die "the workspace directory $WORKSPACE_DIR does not exist (--workspace-dir, or --no-workspaces)"
    WORKSPACE_ABS="$(cd "$WORKSPACE_DIR" && pwd -P)"
  fi
  case "${DEST_ABS}/" in
    "${DATA_ABS}/"*) die "the destination is inside the data directory it protects (${DATA_ABS})" ;;
  esac
  if [ -n "$WORKSPACE_ABS" ]; then
    case "${DEST_ABS}/" in
      "${WORKSPACE_ABS}/"*) die "the destination is inside the workspace it protects (${WORKSPACE_ABS})" ;;
    esac
  fi
  case "${DATA_ABS}/" in
    "${DEST_ABS}/"*) die "the data directory is inside the destination; a restore would overwrite the backup" ;;
  esac
else
  command -v docker >/dev/null 2>&1 || die "docker is not available" 3
  [ -f "$COMPOSE_FILE" ] || die "the compose file $COMPOSE_FILE does not exist (--compose-file)"
  [ -n "$WORKSPACE_VOLUME" ] || WORKSPACE_VOLUME="${PROJECT_NAME}-workspaces"
  running="$(docker compose -f "$COMPOSE_FILE" ps --services --filter status=running 2>/dev/null || true)"
  case "$(printf '%s\n' "$running" | tr -d '\r')" in
    *backend*) ;;
    *) die "--mode docker needs the backend service running in $COMPOSE_FILE" ;;
  esac
fi

log "mode=${MODE} dest=${DEST_ABS} generation=${GENERATION} keep=${KEEP}"
if [ "$MODE" = "host" ]; then
  log "source data dir: ${DATA_ABS}"
  if [ -n "${WORKSPACE_ABS:-}" ]; then log "source workspace: ${WORKSPACE_ABS}"; else log "source workspace: skipped (--no-workspaces)"; fi
else
  log "compose file: ${COMPOSE_FILE}"
  log "workspace volume: ${WORKSPACE_VOLUME}"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry run: nothing was copied"
  exit 0
fi

if [ -e "$GEN_ABS" ]; then die "the generation ${GEN_ABS} already exists"; fi
PARTIAL="${GEN_ABS}.partial"
rm -rf "$PARTIAL"
mkdir -p "${PARTIAL}/data" "${PARTIAL}/workspaces"

WARNINGS=""
cleanup_partial() { rm -rf "$PARTIAL"; }
trap 'cleanup_partial' EXIT

TABLES=""
if [ "$MODE" = "host" ]; then
  if [ -f "${DATA_ABS}/crew.db" ]; then
    snapshot_db "${DATA_ABS}/crew.db" "${PARTIAL}/data/crew.db"
    integrity_check "${PARTIAL}/data/crew.db"
    TABLES="$(count_tables "${PARTIAL}/data/crew.db")"
    log "database snapshot: ${TABLES} tables, integrity ok"
  else
    WARNINGS="${WARNINGS}no crew.db in ${DATA_ABS}; the database was not backed up"$'\n'
  fi
  if [ -f "${DATA_ABS}/vault.key" ]; then
    cp -p "${DATA_ABS}/vault.key" "${PARTIAL}/data/vault.key"
    log "vault key copied"
  elif [ -n "${CREW_VAULT_KEY:-}" ]; then
    WARNINGS="${WARNINGS}CREW_VAULT_KEY is set in the environment; it is not written to the generation, store it separately"$'\n'
  else
    WARNINGS="${WARNINGS}no vault.key in ${DATA_ABS}; stored provider keys cannot be restored from this generation"$'\n'
  fi
  for extra in runtime-mode.json provider.json; do
    if [ -f "${DATA_ABS}/${extra}" ]; then cp -p "${DATA_ABS}/${extra}" "${PARTIAL}/data/${extra}"; fi
  done
  if [ -n "${WORKSPACE_ABS:-}" ]; then
    log "copying the workspace tree (this can take a while)"
    cp -a "${WORKSPACE_ABS}/." "${PARTIAL}/workspaces/"
  fi
  HOSTNAME_TXT="$(hostname 2>/dev/null || printf 'unknown')"
else
  SNAP="/data/.crew-backup-${STAMP}.db"
  if docker compose -f "$COMPOSE_FILE" exec -T backend test -f /data/crew.db; then
    log "snapshotting the database inside the backend container"
    docker compose -f "$COMPOSE_FILE" exec -T backend python - "$SNAP" <<'PY'
import sqlite3
import sys

target = sqlite3.connect(sys.argv[1])
source = sqlite3.connect("file:/data/crew.db?mode=ro", uri=True)
with target:
    source.backup(target)
target.close()
source.close()
print("snapshot written to", sys.argv[1])
PY
    docker compose -f "$COMPOSE_FILE" cp "backend:${SNAP}" "${PARTIAL}/data/crew.db" >/dev/null
    docker compose -f "$COMPOSE_FILE" exec -T backend rm -f "$SNAP"
    integrity_check "${PARTIAL}/data/crew.db"
    TABLES="$(count_tables "${PARTIAL}/data/crew.db")"
    log "database snapshot: ${TABLES} tables, integrity ok"
  else
    WARNINGS="${WARNINGS}no /data/crew.db in the container; the database was not backed up"$'\n'
  fi
  if docker compose -f "$COMPOSE_FILE" exec -T backend test -f /data/vault.key; then
    docker compose -f "$COMPOSE_FILE" cp "backend:/data/vault.key" "${PARTIAL}/data/vault.key" >/dev/null
    log "vault key copied"
  elif [ -n "${CREW_VAULT_KEY:-}" ]; then
    WARNINGS="${WARNINGS}CREW_VAULT_KEY is set in the environment; it is not written to the generation, store it separately"$'\n'
  else
    WARNINGS="${WARNINGS}no /data/vault.key in the container; stored provider keys cannot be restored from this generation"$'\n'
  fi
  for extra in runtime-mode.json provider.json; do
    if docker compose -f "$COMPOSE_FILE" exec -T backend test -f "/data/${extra}"; then
      docker compose -f "$COMPOSE_FILE" cp "backend:/data/${extra}" "${PARTIAL}/data/${extra}" >/dev/null
    fi
  done
  log "copying the workspace volume ${WORKSPACE_VOLUME}"
  docker run --rm -v "${WORKSPACE_VOLUME}:/src:ro" -v "$(py_path "${PARTIAL}/workspaces"):/out" "$HELPER_IMAGE" \
    sh -c 'cd /src && cp -a . /out/'
  HOSTNAME_TXT="docker($(hostname 2>/dev/null || printf 'unknown'))"
fi

WORKSPACE_FILES="$(find "${PARTIAL}/workspaces" -type f 2>/dev/null | wc -l | tr -d ' ')"
{
  printf 'generation: %s\n' "$GENERATION"
  printf 'created_utc: %s\n' "$STAMP"
  printf 'mode: %s\n' "$MODE"
  printf 'host: %s\n' "$HOSTNAME_TXT"
  printf 'database_tables: %s\n' "${TABLES:-none}"
  printf 'workspace_files: %s\n' "$WORKSPACE_FILES"
  if [ "$MODE" = "host" ]; then
    printf 'source_data_dir: %s\n' "$DATA_ABS"
    printf 'source_workspace: %s\n' "${WORKSPACE_ABS:-skipped}"
  else
    printf 'compose_file: %s\n' "$COMPOSE_FILE"
    printf 'workspace_volume: %s\n' "$WORKSPACE_VOLUME"
  fi
  printf 'restore: scripts/restore.sh --from %s\n' "$GEN_ABS"
  printf 'warning: the vault key in data/vault.key decrypts every stored provider key; keep this generation private\n'
  if [ -n "$WARNINGS" ]; then printf 'warnings:\n%s' "$WARNINGS"; fi
} > "${PARTIAL}/MANIFEST.txt"

( cd "$PARTIAL" && find . -type f ! -name SHA256SUMS ! -name MANIFEST.txt | LC_ALL=C sort | while read -r f; do printf '%s  %s\n' "$(file_sum "$f")" "$f"; done > SHA256SUMS )

mv "$PARTIAL" "$GEN_ABS"
trap - EXIT
log "generation written: ${GEN_ABS}"

# Prune older generations. The UTC timestamp prefix sorts lexically, so the
# oldest names come first and the newest KEEP survive.
TOTAL=0
for entry in "$DEST_ABS"/*/; do
  if [ -d "$entry" ]; then TOTAL=$((TOTAL + 1)); fi
done
if [ "$TOTAL" -gt "$KEEP" ]; then
  DROP=$((TOTAL - KEEP))
  INDEX=0
  for entry in "$DEST_ABS"/*/; do
    if [ ! -d "$entry" ]; then continue; fi
    INDEX=$((INDEX + 1))
    if [ "$INDEX" -le "$DROP" ]; then
      NAME="$(basename "$entry")"
      case "$NAME" in
        *.partial) continue ;;
      esac
      log "pruning old generation: ${NAME}"
      rm -rf "${DEST_ABS:?}/${NAME}"
    fi
  done
fi

log "done: ${GEN_ABS}"
log "copy this generation to another machine or another disk; a backup on the host it protects is not a backup"
