#!/usr/bin/env bash
#
# 03-create-vault-repo.sh — OPTIONAL GitHub leg for a vault.
#
# Provisions the git side: the per-user GitHub-OIDC Actions role (vault-sync-<user>, scoped to
# s3://<bucket>/<user>/*), a private content repo with the sync workflow + variables, and adds this
# repo to the role's trust. Skip this entirely for an S3-only (plugin-only) vault.
#
# Idempotent: reuses the per-user role (created on the first vault, trust extended per repo) and
# skips repo creation if it already exists.
#
# Usage: ./03-create-vault-repo.sh --vault NAME [--repo NAME] [--user NS] [--bucket B] [--region R]
#                                  [--org OWNER] [--tool-repo O/R] [--run] [--yes] [--dry-run]
#
set -euo pipefail
. "$(dirname "$0")/lib.sh"
load_env

VAULT=""; REPO=""; USER_NS="${VAULT_USER:-}"; BUCKET="${VAULT_BUCKET:-}"; REGION="${VAULT_REGION:-}"
ORG="${VAULT_ORG:-}"; TOOL_REPO="${VAULT_TOOL_REPO:-}"; FIRST_RUN=0
while [ $# -gt 0 ]; do case "$1" in
  --vault) VAULT="$2"; shift 2 ;;
  --repo) REPO="$2"; shift 2 ;;
  --user) USER_NS="$2"; shift 2 ;;
  --bucket) BUCKET="$2"; shift 2 ;;
  --region) REGION="$2"; shift 2 ;;
  --org) ORG="$2"; shift 2 ;;
  --tool-repo) TOOL_REPO="$2"; shift 2 ;;
  --run) FIRST_RUN=1; shift ;;
  --yes) ASSUME_YES=1; shift ;;
  --dry-run) DRY_RUN=1; shift ;;
  -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
  *) die "unknown arg: $1" ;;
esac; done

require_tools aws gh jq git; require_aws; require_gh
[ -n "$VAULT" ] || die "--vault NAME is required"
[ -n "$BUCKET" ] || die "--bucket (or VAULT_BUCKET) is required"
[ -n "$REGION" ] || die "--region (or VAULT_REGION) is required"
[ -n "$ORG" ] || ORG="$(gh api user --jq .login)"
[ -n "$TOOL_REPO" ] || die "--tool-repo (or VAULT_TOOL_REPO) is required for the workflow checkout"
[ -n "$USER_NS" ] || USER_NS="$(derive_user)"
[ -n "$REPO" ] || REPO="$VAULT"

ACCT="$(aws_account_id)"
OIDC_ARN="arn:aws:iam::$ACCT:oidc-provider/token.actions.githubusercontent.com"
ROLE="vault-sync-$USER_NS"
PREFIX="$(vault_prefix "$USER_NS" "$VAULT")"
SUB="repo:$ORG/$REPO:*"

step "GitHub leg — repo $ORG/$REPO, role $ROLE, prefix $PREFIX"

# --- 1. OIDC provider (account-wide, once) ----------------------------------
if aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output text \
    | tr '\t' '\n' | grep -q 'token.actions.githubusercontent.com'; then
  log "OIDC provider exists"
else
  log "creating GitHub OIDC provider"
  run aws iam create-open-id-connect-provider \
    --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com
fi

# --- 2. per-user Actions role (create, or extend trust with this repo) -------
S3POL="$(mktemp)"; TRUST="$(mktemp)"; trap 'rm -f "$S3POL" "$TRUST"' EXIT
cat >"$S3POL" <<JSON
{ "Version":"2012-10-17","Statement":[
  { "Sid":"Objects","Effect":"Allow",
    "Action":["s3:GetObject","s3:GetObjectVersion","s3:PutObject","s3:DeleteObject"],
    "Resource":"arn:aws:s3:::$BUCKET/$USER_NS/*" },
  { "Sid":"ListScoped","Effect":"Allow","Action":["s3:ListBucket"],
    "Resource":"arn:aws:s3:::$BUCKET",
    "Condition":{"StringLike":{"s3:prefix":["$USER_NS/*"]}} } ] }
JSON

if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  log "role exists — ensuring '$SUB' is trusted"
  CUR="$(aws iam get-role --role-name "$ROLE" --query Role.AssumeRolePolicyDocument --output json)"
  printf '%s' "$CUR" | jq --arg sub "$SUB" '
    (.Statement[0].Condition.StringLike["token.actions.githubusercontent.com:sub"]) as $c
    | (if ($c|type)=="array" then $c else [$c] end) as $arr
    | .Statement[0].Condition.StringLike["token.actions.githubusercontent.com:sub"] = (($arr + [$sub]) | unique)
  ' >"$TRUST"
  run aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "file://$TRUST"
else
  confirm "Create Actions role '$ROLE'?" || die "aborted"
  cat >"$TRUST" <<JSON
{ "Version":"2012-10-17","Statement":[{
  "Effect":"Allow","Principal":{"Federated":"$OIDC_ARN"},
  "Action":"sts:AssumeRoleWithWebIdentity",
  "Condition":{
    "StringEquals":{"token.actions.githubusercontent.com:aud":"sts.amazonaws.com"},
    "StringLike":{"token.actions.githubusercontent.com:sub":["$SUB"]} } }] }
JSON
  run aws iam create-role --role-name "$ROLE" --assume-role-policy-document "file://$TRUST" \
    --tags "Key=managed-by,Value=vault-sync"
fi
log "role inline policy 's3' → scope $USER_NS/*"
run aws iam put-role-policy --role-name "$ROLE" --policy-name s3 --policy-document "file://$S3POL"
ROLE_ARN="arn:aws:iam::$ACCT:role/$ROLE"

# --- 3. content repo + scaffold ---------------------------------------------
if gh repo view "$ORG/$REPO" >/dev/null 2>&1; then
  warn "repo $ORG/$REPO already exists — skipping creation/scaffold, updating variables only"
else
  confirm "Create private repo '$ORG/$REPO' and push the sync scaffold?" || die "aborted"
  TMP="$(mktemp -d)"
  mkdir -p "$TMP/.github/workflows"
  cp "$REPO_DIR/templates/s3-sync.yml" "$TMP/.github/workflows/s3-sync.yml"
  cat >"$TMP/.gitignore" <<'GI'
# Sync tool checked out at workflow run time
.sync-tool/

# .obsidian syncs across devices/GitHub — hold back only per-device files
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/plugins/vault-s3-sync/data.json
.obsidian/plugins/vault-s3-sync/state.json.gz
.trash/
.idea/
.DS_Store
GI
  printf '# %s\n\nObsidian vault synced via S3 (prefix `%s`). See the sync tool: %s\n' \
    "$VAULT" "$PREFIX" "$TOOL_REPO" >"$TMP/README.md"
  if [ "${DRY_RUN:-0}" = 1 ]; then
    log "[dry-run] would: git init + gh repo create $ORG/$REPO --private --source=$TMP --push"
  else
    ( cd "$TMP" && git init -q && git add -A && git -c user.name=vault-sync -c user.email=vault-sync@local commit -qm "init vault sync" \
        && git branch -M main \
        && gh repo create "$ORG/$REPO" --private --source=. --remote=origin --push )
    log "repo created + scaffold pushed"
  fi
  rm -rf "$TMP"
fi

# --- 4. repo variables + workflow permissions -------------------------------
log "setting Actions variables"
for kv in \
  "S3_SYNC_BUCKET=$BUCKET" "S3_SYNC_REGION=$REGION" "S3_SYNC_ROLE_ARN=$ROLE_ARN" \
  "S3_SYNC_TOOL_REPO=$TOOL_REPO" "S3_SYNC_PREFIX=$PREFIX"; do
  run gh variable set "${kv%%=*}" --repo "$ORG/$REPO" --body "${kv#*=}"
done
log "workflow permissions → read/write (bot pushes sync commits)"
run gh api -X PUT "repos/$ORG/$REPO/actions/permissions/workflow" -f default_workflow_permissions=write >/dev/null

if [ "$FIRST_RUN" = 1 ]; then
  log "triggering first sync run"
  run gh workflow run s3-sync.yml --repo "$ORG/$REPO"
fi

step "GitHub leg ready for '$VAULT'"
log "Repo:   https://github.com/$ORG/$REPO"
log "Prefix: $PREFIX   Role: $ROLE_ARN"
log "Next:   ./04-init-vault-zip.sh --vault $VAULT   (device zip)"
