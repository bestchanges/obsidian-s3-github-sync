#!/usr/bin/env bash
#
# 04-init-vault-zip.sh — build a ready-to-sync device zip for a vault.
#
# Emits <vault>.zip: an empty Obsidian vault with the plugin preconfigured for this vault's S3
# prefix and credentials (from 02's .secrets/<user>.json), device identity + state cleared, 10 MB
# download cap. Open it on any device, turn on community plugins, and it pulls the whole vault.
#
# Usage: ./04-init-vault-zip.sh --vault NAME [--user NS] [--bucket B] [--region R] [--out FILE]
#
# WARNING: the zip contains your AWS secret key. Share it privately; delete it after setup.
#
set -euo pipefail
. "$(dirname "$0")/lib.sh"
load_env

VAULT=""; USER_NS="${VAULT_USER:-}"; BUCKET="${VAULT_BUCKET:-}"; REGION="${VAULT_REGION:-}"; OUT=""
while [ $# -gt 0 ]; do case "$1" in
  --vault) VAULT="$2"; shift 2 ;;
  --user) USER_NS="$2"; shift 2 ;;
  --bucket) BUCKET="$2"; shift 2 ;;
  --region) REGION="$2"; shift 2 ;;
  --out) OUT="$2"; shift 2 ;;
  -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
  *) die "unknown arg: $1" ;;
esac; done

require_tools aws node zip; require_aws
[ -n "$VAULT" ] || die "--vault NAME is required"
[ -n "$BUCKET" ] || die "--bucket (or VAULT_BUCKET) is required"
[ -n "$REGION" ] || die "--region (or VAULT_REGION) is required"
[ -n "$USER_NS" ] || USER_NS="$(derive_user)"

CREDS="$SECRETS_DIR/$USER_NS.json"
[ -s "$CREDS" ] || die "no saved credentials at $CREDS — run ./02-create-user.sh --user $USER_NS first"
PREFIX="$(vault_prefix "$USER_NS" "$VAULT")"
[ -n "$OUT" ] || OUT="$PWD/$VAULT.zip"

step "Device zip for '$VAULT'  (prefix $PREFIX)"
node "$REPO_DIR/scripts/make-starter-vault.mjs" \
  --name "$VAULT" --bucket "$BUCKET" --region "$REGION" --prefix "$PREFIX" \
  --creds-file "$CREDS" --out "$OUT"

step "Done"
log "Carry $OUT to a device → extract here → open the $VAULT/ folder as a vault → turn on community plugins."
