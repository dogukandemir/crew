#!/usr/bin/env bash
# =============================================================================
# Create a DigitalOcean Droplet with Crew's cloud-init, then print the DNS step.
#
# This is the "one command" path for DigitalOcean. It renders
# deploy/digitalocean/cloud-init.yaml with the three public values below,
# creates an Ubuntu 24.04 Droplet with that file as user data, waits for it to
# become active, and prints the public IPv4 plus the A record to create.
#
# Requirements:
#   - doctl installed and on PATH:
#       https://docs.digitalocean.com/reference/doctl/how-to/install/
#   - A DigitalOcean API token in DO_TOKEN, supplied through the environment
#     (for example: DO_TOKEN=... ./deploy/digitalocean/create-droplet.sh).
#     The token is used with `doctl --access-token` and is never written to
#     disk, never placed in shell history by this script, and never printed.
#   - An SSH key already registered with DigitalOcean; DO_SSH_KEY is its
#     fingerprint or numeric id.
#
# Environment:
#   DO_TOKEN          required (except with --dry-run)
#   DO_REGION         required; for example nyc3, ams3, sfo3, fra1
#   DO_SSH_KEY        required; SSH key fingerprint or id
#   CREW_DOMAIN       required; public DNS name, no scheme
#   CREW_ACME_EMAIL   required; Let's Encrypt / ACME account email
#   CREW_ADMIN_EMAIL  required; first Crew admin email
#   DO_SIZE           optional; default s-2vcpu-4gb
#   CREW_DROPLET_NAME optional; default crew-<first label of the domain>
#
# Usage:
#   DO_TOKEN=... DO_REGION=nyc3 DO_SSH_KEY=... \
#   CREW_DOMAIN=crew.example.com CREW_ACME_EMAIL=ops@example.com \
#   CREW_ADMIN_EMAIL=owner@example.com \
#   ./deploy/digitalocean/create-droplet.sh
#
#   ./deploy/digitalocean/create-droplet.sh --dry-run   # render + print, no API call
#   ./deploy/digitalocean/create-droplet.sh --yes       # skip the confirmation prompt
#
# No password is put in the cloud-init file: the installer generates one on the
# Droplet at /root/crew-admin-password.txt (mode 600).
# =============================================================================
set -euo pipefail

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
TEMPLATE="${SELF_DIR}/cloud-init.yaml"

DO_TOKEN="${DO_TOKEN:-}"
DO_REGION="${DO_REGION:-}"
DO_SIZE="${DO_SIZE:-s-2vcpu-4gb}"
DO_SSH_KEY="${DO_SSH_KEY:-}"
CREW_DOMAIN="${CREW_DOMAIN:-}"
CREW_ACME_EMAIL="${CREW_ACME_EMAIL:-}"
CREW_ADMIN_EMAIL="${CREW_ADMIN_EMAIL:-}"
CREW_DROPLET_NAME="${CREW_DROPLET_NAME:-}"

DRY_RUN=0
ASSUME_YES=0

log() { printf '[crew-droplet] %s\n' "$*"; }
warn() { printf '[crew-droplet] warning: %s\n' "$*" >&2; }
die() { printf '[crew-droplet] error: %s\n' "$*" >&2; exit 2; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed '$d' | sed -E 's/^# ?//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[ -f "$TEMPLATE" ] || die "cloud-init template not found at $TEMPLATE"

validate_domain() {
  case "$1" in
    *://*|*/*|*" "*|*$'\n'*) die "CREW_DOMAIN must be a bare DNS name without a scheme or path" ;;
  esac
  printf '%s' "$1" | grep -Eq '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$' \
    || die "CREW_DOMAIN is not a valid public DNS name: $1"
}

validate_email() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$' \
    || die "not a usable email address: $1"
}

[ -n "$CREW_DOMAIN" ] || die "CREW_DOMAIN is required"
[ -n "$CREW_ACME_EMAIL" ] || die "CREW_ACME_EMAIL is required"
[ -n "$CREW_ADMIN_EMAIL" ] || die "CREW_ADMIN_EMAIL is required"
CREW_DOMAIN="$(printf '%s' "$CREW_DOMAIN" | tr '[:upper:]' '[:lower:]')"
validate_domain "$CREW_DOMAIN"
validate_email "$CREW_ACME_EMAIL"
validate_email "$CREW_ADMIN_EMAIL"

if [ -z "$CREW_DROPLET_NAME" ]; then
  CREW_DROPLET_NAME="crew-${CREW_DOMAIN//./-}"
fi
# Droplet names are hostname-like: lowercase letters, digits and hyphens, with
# no leading or trailing hyphen. Truncate to the 63-character DNS label limit.
CREW_DROPLET_NAME="$(printf '%s' "$CREW_DROPLET_NAME" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-')"
CREW_DROPLET_NAME="$(printf '%s' "$CREW_DROPLET_NAME" | sed -E 's/^-+//; s/-+$//')"
CREW_DROPLET_NAME="${CREW_DROPLET_NAME:0:63}"
[ -n "$CREW_DROPLET_NAME" ] || die "the Droplet name is empty after sanitising; set CREW_DROPLET_NAME"

if [ "$DRY_RUN" -ne 1 ]; then
  [ -n "$DO_TOKEN" ] || die "DO_TOKEN is required (export it in the environment; do not put it in a file or a command line)"
  [ -n "$DO_REGION" ] || die "DO_REGION is required (for example nyc3)"
  [ -n "$DO_SSH_KEY" ] || die "DO_SSH_KEY is required (an SSH key fingerprint or id registered with DigitalOcean)"
  have doctl || die "doctl is not installed. Install it, or paste the rendered cloud-init file into the Droplet 'User data' field instead (see deploy/vps/README.md)."
fi

rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT

# envsubst is preferred (gettext). The fallback is safe because the three
# values were validated above and contain no sed metacharacters.
if have envsubst; then
  # shellcheck disable=SC2016  # ${...} is envsubst syntax, not shell expansion
  envsubst '${CREW_DOMAIN} ${CREW_ACME_EMAIL} ${CREW_ADMIN_EMAIL}' < "$TEMPLATE" > "$rendered"
else
  warn "envsubst not found; using a sed fallback (install gettext for the canonical path)"
  sed -e "s|\${CREW_DOMAIN}|${CREW_DOMAIN}|g" \
      -e "s|\${CREW_ACME_EMAIL}|${CREW_ACME_EMAIL}|g" \
      -e "s|\${CREW_ADMIN_EMAIL}|${CREW_ADMIN_EMAIL}|g" \
      "$TEMPLATE" > "$rendered"
fi

# The guard inside cloud-init catches unrendered placeholders at boot; check
# here too, so a broken render fails before an API call. The guard text itself
# contains '${', so match the specific assignment forms instead.
# shellcheck disable=SC2016  # literal assignment prefixes, not shell expansion
if grep -qF -e 'CREW_DOMAIN=${' -e 'CREW_ACME_EMAIL=${' -e 'CREW_ADMIN_EMAIL=${' "$rendered"; then
  die "the rendered cloud-init still contains an unsubstituted placeholder"
fi

# Optional structural check: valid YAML with the expected keys.
if have python3 && python3 -c 'import yaml' >/dev/null 2>&1; then
  python3 -I - "$rendered" <<'PY' || die "the rendered cloud-init is not valid YAML"
import sys
import yaml

with open(sys.argv[1], encoding="utf-8") as fh:
    doc = yaml.safe_load(fh)
if not isinstance(doc, dict) or "runcmd" not in doc or "write_files" not in doc:
    raise SystemExit("rendered cloud-init is missing runcmd/write_files")
PY
else
  warn "PyYAML is not available; the rendered cloud-init was not parsed"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry run: rendered cloud-init follows; no DigitalOcean API call was made"
  cat "$rendered"
  printf '\n[crew-droplet] would create:\n'
  printf '  name:    %s\n' "$CREW_DROPLET_NAME"
  printf '  image:   ubuntu-24-04-x64\n'
  printf '  region:  %s\n' "${DO_REGION:-<DO_REGION>}"
  printf '  size:    %s\n' "$DO_SIZE"
  printf '  ssh key: %s\n' "${DO_SSH_KEY:-<DO_SSH_KEY>}"
  exit 0
fi

log "Droplet: $CREW_DROPLET_NAME ($DO_SIZE, ubuntu-24-04-x64, region $DO_REGION)"
log "Domain:  $CREW_DOMAIN"
log "Admin:   $CREW_ADMIN_EMAIL"

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Create this Droplet now? [y/N] ' >&2
  read -r answer || answer=""
  case "$answer" in
    y|Y|yes|YES) ;;
    *) die "aborted; nothing was created" ;;
  esac
fi

# --access-token keeps the token out of doctl's config file. The script never
# echoes the command, never enables xtrace, and never prints the token. doctl
# has no stdin token option, so the value is visible in this machine's process
# list for the duration of each call: run this from a trusted workstation.
doctl_args=(--access-token "$DO_TOKEN")

set +e
# stderr stays on the terminal: doctl's own error is the useful diagnostic and
# it never contains the token. stdout must stay clean enough to parse.
created="$(doctl compute droplet create "$CREW_DROPLET_NAME" \
  --image ubuntu-24-04-x64 \
  --region "$DO_REGION" \
  --size "$DO_SIZE" \
  --ssh-keys "$DO_SSH_KEY" \
  --user-data-file "$rendered" \
  --wait \
  --format ID,Name,PublicIPv4 \
  --no-header \
  "${doctl_args[@]}")"
status=$?
set -e

if [ "$status" -ne 0 ]; then
  printf '%s\n' "$created" >&2
  die "doctl could not create the Droplet"
fi

droplet_id="$(printf '%s\n' "$created" | awk 'NF >= 1 {print $1; exit}')"
droplet_ip="$(printf '%s\n' "$created" | awk 'NF >= 3 {print $3; exit}')"
[ -n "$droplet_id" ] || die "doctl did not report a Droplet id"

# The create call may return before the public address is attached even with
# --wait; read it back once.
if [ -z "$droplet_ip" ] || [ "$droplet_ip" = "<nil>" ]; then
  droplet_ip="$(doctl compute droplet get "$droplet_id" --format PublicIPv4 --no-header "${doctl_args[@]}" | tr -d '[:space:]')"
fi
if [ -z "$droplet_ip" ] || [ "$droplet_ip" = "<nil>" ]; then
  die "the Droplet was created but has no public IPv4 yet; run: doctl compute droplet get $droplet_id"
fi

cat <<EOF

Droplet created.
  Name:        $CREW_DROPLET_NAME
  ID:          $droplet_id
  Public IPv4: $droplet_ip

Next steps
  1. Create (or update) a DNS A record:
       $CREW_DOMAIN.   300   IN   A   $droplet_ip
     Caddy retries certificate issuance, so an A record that is still
     propagating only delays HTTPS; it does not break the install.
  2. Wait 5-15 minutes for cloud-init, then check:
       ssh root@$droplet_ip 'cloud-init status --wait; tail -n 100 /var/log/crew-install.log'
  3. Open https://$CREW_DOMAIN and sign in as $CREW_ADMIN_EMAIL.
  4. The generated admin password is root-only on the Droplet:
       ssh root@$droplet_ip 'cat /root/crew-admin-password.txt'
  5. Read deploy/vps/README.md for updates, backups, restores and teardown.
EOF
