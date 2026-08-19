#!/usr/bin/env bash
#
# 06-enable-push-notifications.sh — instant sync via AWS IoT Core (§4.14).
#
# Optional. Without it everything still works: devices simply learn about changes on their next
# poll instead of in milliseconds. This script only grants permissions and prints the endpoint —
# it creates no resources, because IoT Core needs none for a plain MQTT topic.
#
# What it does (idempotently):
#   1. resolves the account's IoT ATS data endpoint for the region (or takes --endpoint)
#   2. ensures the inline `iot` policy on the plugin IAM user (02 writes it for new users)
#   3. adds an `iot:Publish` grant to the git-sync OIDC role, if one exists
#   4. prints what to paste into the plugin settings and the content repo's variables
#
# Both policies are scoped to vaultsync/<user>-vaults-*/rev — every vault of one user. They are
# attached by name to per-USER identities, so a per-vault document would be overwritten (and push
# silently broken for the earlier vault) as soon as a second vault was set up.
#
# The topic is derived from the vault prefix — vaultsync/<slug>/rev — and carries ONE integer plus
# a device label. Anyone who can read it learns *that* the vault changed and *which* device changed
# it, never what changed: strictly less than the bucket access these same credentials already have.
#
# Usage: ./06-enable-push-notifications.sh --vault V [--user NS] [--role ROLE]
#                                         [--endpoint HOST] [--yes] [--dry-run]
#
set -euo pipefail
. "$(dirname "$0")/lib.sh"
load_env

USER_NS="${VAULT_USER:-}"; VAULT="${VAULT_NAME:-}"; ROLE="${VAULT_SYNC_ROLE:-}"; ENDPOINT="${IOT_ENDPOINT:-}"
while [ $# -gt 0 ]; do case "$1" in
  --user) USER_NS="$2"; shift 2 ;;
  --vault) VAULT="$2"; shift 2 ;;
  --role) ROLE="$2"; shift 2 ;;
  # Discovery needs iot:DescribeEndpoint, which an operator scoped to S3/IAM/Lambda won't have.
  # Pass the endpoint (AWS console → IoT Core → Settings → Device data endpoint) to skip the call:
  # the grants below don't need IoT permissions at all, only IAM.
  --endpoint) ENDPOINT="$2"; shift 2 ;;
  --yes) ASSUME_YES=1; shift ;;
  --dry-run) DRY_RUN=1; shift ;;
  -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  *) die "unknown arg: $1" ;;
esac; done

require_tools aws jq; require_aws
[ -n "$USER_NS" ] || USER_NS="$(derive_user)"
[ -n "$VAULT" ] || die "--vault (or VAULT_NAME) is required — it selects the topic"

IAM_USER="vault-plugin-$USER_NS"
REGION="$(vault_region)"
[ -n "$REGION" ] || die "no region: set VAULT_REGION in .env, AWS_REGION, or 'aws configure set region'"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
TOPIC="$(vault_topic "$USER_NS" "$VAULT")"

step "Push notifications for vault '$VAULT'  (topic $TOPIC)"

# --- 1. endpoint ------------------------------------------------------------
# ATS is the current endpoint type; the legacy (Symantec-rooted) one is deprecated and its cert
# chain is not trusted by modern clients.
if [ -n "$ENDPOINT" ]; then
  log "IoT ATS data endpoint (given): $ENDPOINT"
else
  ENDPOINT="$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --region "$REGION" \
    --query endpointAddress --output text 2>/dev/null)" || true
  [ -n "$ENDPOINT" ] || die "could not read the IoT endpoint (needs iot:DescribeEndpoint).
   Either grant it, or pass it: --endpoint <host>
   Find it in the console: IoT Core → Settings → Device data endpoint (region $REGION)."
  log "IoT ATS data endpoint: $ENDPOINT"
fi

# --- 2. plugin user ---------------------------------------------------------
# 02-create-user.sh already writes this for new users; re-writing the SAME document here is what
# makes the script safe on deployments that predate it (and a no-op on ones that don't).
log "inline policy 'iot' on $IAM_USER → connect/subscribe/receive/publish on vaultsync/$USER_NS-vaults-*/rev"
POL="$(mktemp)"; trap 'rm -f "$POL"' EXIT
vault_iot_policy_json "$USER_NS" "$REGION" "$ACCOUNT" >"$POL"
confirm "Attach the 'iot' policy to $IAM_USER?" || die "aborted"
run aws iam put-user-policy --user-name "$IAM_USER" --policy-name iot --policy-document "file://$POL"

# --- 3. git-sync role (optional) -------------------------------------------
if [ -n "$ROLE" ]; then
  if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
    log "inline policy 'iot-publish' on role $ROLE → publish only (git-sync never subscribes)"
    RPOL="$(mktemp)"
    cat >"$RPOL" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "Publish", "Effect": "Allow", "Action": "iot:Publish",
      "Resource": "$(vault_topic_arn_pattern "$USER_NS" "$REGION" "$ACCOUNT" topic)" }
  ]
}
JSON
    run aws iam put-role-policy --role-name "$ROLE" --policy-name iot-publish --policy-document "file://$RPOL"
    rm -f "$RPOL"
  else
    warn "role '$ROLE' not found — skipping the git-sync grant"
  fi
else
  log "no --role given — skipping the git-sync grant (the Actions leg just won't announce)"
fi

step "Done — two things to set"
log "1. Plugin settings on EACH device:"
log "     Instant sync (push notifications) = ON"
log "     IoT endpoint = $ENDPOINT"
log "2. Content repo (optional, so git-sync announces too):"
log "     gh variable set S3_SYNC_IOT_ENDPOINT --body '$ENDPOINT'"
log ""
log "Verify: enable plugin logging on two devices, edit a note on one, and look for"
log "  'notify: rev <n> from <device>' on the other within a second."
log "If nothing arrives, sync still works — it falls back to polling."
