#!/usr/bin/env bash
#
# 06-enable-push-notifications.sh — instant sync via AWS IoT Core (§4.14).
#
# Optional. Without it everything still works: devices simply learn about changes on their next
# poll instead of in milliseconds. This script only grants permissions and prints the endpoint —
# it creates no resources, because IoT Core needs none for a plain MQTT topic.
#
# What it does (idempotently):
#   1. resolves the account's IoT ATS data endpoint for the region
#   2. adds an inline `iot` policy to the plugin IAM user  (connect/subscribe/receive/publish)
#   3. adds the same publish grant to the git-sync OIDC role, if one exists
#   4. prints what to paste into the plugin settings and the content repo's variables
#
# The topic is derived from the vault prefix — vaultsync/<slug>/rev — and carries ONE integer plus
# a device label. Anyone who can read it learns *that* the vault changed and *which* device changed
# it, never what changed: strictly less than the bucket access these same credentials already have.
#
# Usage: ./06-enable-push-notifications.sh [--user NS] [--vault V] [--role ROLE] [--yes] [--dry-run]
#
set -euo pipefail
. "$(dirname "$0")/lib.sh"
load_env

USER_NS="${VAULT_USER:-}"; VAULT="${VAULT_NAME:-}"; ROLE="${VAULT_SYNC_ROLE:-}"
while [ $# -gt 0 ]; do case "$1" in
  --user) USER_NS="$2"; shift 2 ;;
  --vault) VAULT="$2"; shift 2 ;;
  --role) ROLE="$2"; shift 2 ;;
  --yes) ASSUME_YES=1; shift ;;
  --dry-run) DRY_RUN=1; shift ;;
  -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
  *) die "unknown arg: $1" ;;
esac; done

require_tools aws jq; require_aws
[ -n "$USER_NS" ] || USER_NS="$(derive_user)"
[ -n "$VAULT" ] || die "--vault (or VAULT_NAME) is required — it selects the topic"

IAM_USER="vault-plugin-$USER_NS"
REGION="$(aws configure get region || echo "${AWS_REGION:-us-east-1}")"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"

# Must match revTopic() in packages/obsidian-plugin/src/notify.ts AND packages/git-sync/src/notify.ts
# (the prefix the plugin uses is "<user>/vaults/<vault>/").
PREFIX="$USER_NS/vaults/$VAULT/"
SLUG="$(printf '%s' "$PREFIX" | sed -e 's/[^A-Za-z0-9_-]\{1,\}/-/g' -e 's/^-*//' -e 's/-*$//')"
TOPIC="vaultsync/${SLUG:-default}/rev"

step "Push notifications for vault '$VAULT'  (topic $TOPIC)"

# --- 1. endpoint ------------------------------------------------------------
# ATS is the current endpoint type; the legacy (Symantec-rooted) one is deprecated and its cert
# chain is not trusted by modern clients.
ENDPOINT="$(aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text)"
log "IoT ATS data endpoint: $ENDPOINT"

TOPIC_ARN="arn:aws:iot:$REGION:$ACCOUNT:topic/$TOPIC"
TOPICFILTER_ARN="arn:aws:iot:$REGION:$ACCOUNT:topicfilter/$TOPIC"
# One client id per device. The plugin connects as its deviceId, so the wildcard is what lets a
# fleet share one IAM user without the devices disconnecting each other.
CLIENT_ARN="arn:aws:iot:$REGION:$ACCOUNT:client/*"

# --- 2. plugin user ---------------------------------------------------------
log "inline policy 'iot' on $IAM_USER → connect/subscribe/receive/publish on this topic only"
POL="$(mktemp)"; trap 'rm -f "$POL"' EXIT
cat >"$POL" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "Connect", "Effect": "Allow", "Action": "iot:Connect", "Resource": "$CLIENT_ARN" },
    { "Sid": "Subscribe", "Effect": "Allow", "Action": "iot:Subscribe", "Resource": "$TOPICFILTER_ARN" },
    { "Sid": "ReceivePublish", "Effect": "Allow",
      "Action": ["iot:Receive", "iot:Publish"], "Resource": "$TOPIC_ARN" }
  ]
}
JSON
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
    { "Sid": "Publish", "Effect": "Allow", "Action": "iot:Publish", "Resource": "$TOPIC_ARN" }
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
