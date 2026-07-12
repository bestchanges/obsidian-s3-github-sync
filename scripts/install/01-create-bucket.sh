#!/usr/bin/env bash
#
# 01-create-bucket.sh — one-time shared S3 infrastructure for all vaults.
#
# Creates (idempotently) the bucket and applies: versioning (required — merge bases come from
# old object versions), public-access-block, default SSE-S3 encryption, and the CORS config the
# Obsidian plugin needs (without it every request fails with "TypeError: failed to fetch").
#
# Usage: ./01-create-bucket.sh [--bucket B] [--region R] [--lifecycle] [--yes] [--dry-run]
#   Reads VAULT_BUCKET / VAULT_REGION from .env when flags are omitted.
#
set -euo pipefail
. "$(dirname "$0")/lib.sh"
load_env

BUCKET="${VAULT_BUCKET:-}"; REGION="${VAULT_REGION:-}"; LIFECYCLE=0
while [ $# -gt 0 ]; do case "$1" in
  --bucket) BUCKET="$2"; shift 2 ;;
  --region) REGION="$2"; shift 2 ;;
  --lifecycle) LIFECYCLE=1; shift ;;
  --yes) ASSUME_YES=1; shift ;;
  --dry-run) DRY_RUN=1; shift ;;
  -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
  *) die "unknown arg: $1" ;;
esac; done

require_tools aws jq; require_aws
[ -n "$BUCKET" ] || die "--bucket (or VAULT_BUCKET) is required"
[ -n "$REGION" ] || die "--region (or VAULT_REGION) is required"

step "Bucket s3://$BUCKET ($REGION)"

if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  log "bucket exists — ensuring configuration"
else
  confirm "Create bucket '$BUCKET' in $REGION?" || die "aborted"
  if [ "$REGION" = "us-east-1" ]; then
    run aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
  else
    run aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION"
  fi
  log "created"
fi

log "versioning → Enabled"
run aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled

log "public access → fully blocked"
run aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

log "default encryption → SSE-S3 (AES256)"
run aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

log "CORS → allow Obsidian origins (desktop + mobile)"
CORS_JSON="$(mktemp)"; trap 'rm -f "$CORS_JSON"' EXIT
cat >"$CORS_JSON" <<'JSON'
{
  "CORSRules": [{
    "AllowedOrigins": ["app://obsidian.md", "capacitor://localhost", "http://localhost"],
    "AllowedMethods": ["GET", "PUT", "HEAD", "DELETE"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "x-amz-version-id", "x-amz-meta-revision"],
    "MaxAgeSeconds": 3000
  }]
}
JSON
run aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration "file://$CORS_JSON"

if [ "$LIFECYCLE" = 1 ]; then
  log "lifecycle → expire noncurrent versions after 90 days"
  run aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration \
    '{"Rules":[{"ID":"expire-noncurrent","Status":"Enabled","Filter":{"Prefix":""},"NoncurrentVersionExpiration":{"NoncurrentDays":90}}]}'
fi

step "Bucket ready"
log 'Next: ./02-create-user.sh   (per-user AWS identity + plugin access key)'
