#!/usr/bin/env bash
#
# 02-create-user.sh — per-user AWS identity for the S3 (Obsidian plugin) leg.
#
# Creates (idempotently) an IAM user `vault-plugin-<user>` scoped to s3://<bucket>/<user>/* and
# mints one access key, written to .secrets/<user>.json (gitignored, chmod 600) for 04 to embed in
# the vault zip. This is all you need for an S3-only vault; the GitHub leg lives in 03.
#
# "user" is your AWS IAM username (the S3 namespace). Auto-derived from the caller ARN, or --user.
#
# Usage: ./02-create-user.sh [--user NS] [--bucket B] [--rotate] [--yes] [--dry-run]
#
set -euo pipefail
. "$(dirname "$0")/lib.sh"
load_env

BUCKET="${VAULT_BUCKET:-}"; USER_NS="${VAULT_USER:-}"; ROTATE=0
while [ $# -gt 0 ]; do case "$1" in
  --user) USER_NS="$2"; shift 2 ;;
  --bucket) BUCKET="$2"; shift 2 ;;
  --rotate) ROTATE=1; shift ;;
  --yes) ASSUME_YES=1; shift ;;
  --dry-run) DRY_RUN=1; shift ;;
  -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
  *) die "unknown arg: $1" ;;
esac; done

require_tools aws jq; require_aws
[ -n "$BUCKET" ] || die "--bucket (or VAULT_BUCKET) is required"
[ -n "$USER_NS" ] || USER_NS="$(derive_user)"

IAM_USER="vault-plugin-$USER_NS"
CREDS="$SECRETS_DIR/$USER_NS.json"
mkdir -p "$SECRETS_DIR"

step "Plugin IAM user '$IAM_USER'  (scope s3://$BUCKET/$USER_NS/*)"

if aws iam get-user --user-name "$IAM_USER" >/dev/null 2>&1; then
  log "user exists — ensuring policy"
else
  confirm "Create IAM user '$IAM_USER'?" || die "aborted"
  run aws iam create-user --user-name "$IAM_USER" --tags "Key=managed-by,Value=vault-sync"
  log "created"
fi

# ListBucketVersions is a SEPARATE action from ListBucket, and version history reads it directly
# (§2.9) — without it the history panel fails with AccessDenied.
log "inline policy 's3' → objects under $USER_NS/* + scoped ListBucket/ListBucketVersions"
POL="$(mktemp)"; trap 'rm -f "$POL"' EXIT
cat >"$POL" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "Objects", "Effect": "Allow",
      "Action": ["s3:GetObject","s3:GetObjectVersion","s3:PutObject","s3:DeleteObject"],
      "Resource": "arn:aws:s3:::$BUCKET/$USER_NS/*" },
    { "Sid": "ListScoped", "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:ListBucketVersions"],
      "Resource": "arn:aws:s3:::$BUCKET",
      "Condition": { "StringLike": { "s3:prefix": ["$USER_NS/*"] } } }
  ]
}
JSON
run aws iam put-user-policy --user-name "$IAM_USER" --policy-name s3 --policy-document "file://$POL"

# --- change notifications (§4.14) -------------------------------------------
# Granted up front rather than in 06, so instant sync is a per-device toggle later instead of an
# IAM round-trip. Costs nothing while unused: with pushNotifications off the plugin never connects,
# and IoT Core bills only live connections and messages. Scoped to this user's own topics.
REGION="$(vault_region)"
if [ -n "$REGION" ]; then
  ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
  log "inline policy 'iot' → change notifications on vaultsync/$USER_NS-vaults-*/rev (§4.14)"
  IOTPOL="$(mktemp)"
  vault_iot_policy_json "$USER_NS" "$REGION" "$ACCOUNT" >"$IOTPOL"
  run aws iam put-user-policy --user-name "$IAM_USER" --policy-name iot --policy-document "file://$IOTPOL"
  rm -f "$IOTPOL"
else
  warn "no region resolved — skipping the 'iot' policy (run 06-enable-push-notifications.sh later)"
fi

# --- access key -------------------------------------------------------------
if [ -s "$CREDS" ] && [ "$ROTATE" != 1 ]; then
  log "access key already saved → $CREDS (use --rotate to replace)"
else
  if [ "$ROTATE" = 1 ]; then
    warn "rotating: deleting existing access keys for $IAM_USER"
    for k in $(aws iam list-access-keys --user-name "$IAM_USER" --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
      run aws iam delete-access-key --user-name "$IAM_USER" --access-key-id "$k"
    done
  fi
  confirm "Mint a new access key for '$IAM_USER'? (secret saved to $CREDS, never printed)" || die "aborted"
  if [ "${DRY_RUN:-0}" = 1 ]; then
    log "[dry-run] would create access key and write $CREDS"
  else
    KEY_JSON="$(aws iam create-access-key --user-name "$IAM_USER")"
    umask 077
    printf '%s' "$KEY_JSON" | jq '{accessKeyId: .AccessKey.AccessKeyId, secretAccessKey: .AccessKey.SecretAccessKey}' >"$CREDS"
    chmod 600 "$CREDS"
    KID="$(jq -r .accessKeyId "$CREDS")"
    log "access key ${KID:0:4}… saved → $CREDS (secret not shown)"
  fi
fi

step "User ready"
log "S3-only path:  ./04-init-vault-zip.sh --vault <name>"
log "With GitHub:   ./03-create-vault-repo.sh --vault <name>   then  04"
