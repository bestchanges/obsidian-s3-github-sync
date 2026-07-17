#!/usr/bin/env bash
#
# 05-create-mcp-server.sh — per-vault remote MCP server (Lambda + Function URL), phase-0 bearer auth.
#
# Builds packages/mcp-server and provisions (idempotently): an execution role `vault-mcp-<user>`
# scoped to s3://<bucket>/<user>/*, a Lambda `vault-mcp-<user>-<vault>` pointed at that vault's
# prefix, a public Function URL (auth enforced in-handler), and a bearer token saved to
# .secrets/mcp-<user>-<vault>.json. Prints the MCP endpoint + client config at the end.
# Design: "MCP Server Design.md" · component details: packages/mcp-server/README.md
#
# Usage: ./05-create-mcp-server.sh --vault NAME [--user NS] [--bucket B] [--region R]
#                                  [--rotate-token] [--yes] [--dry-run]
#
set -euo pipefail
. "$(dirname "$0")/lib.sh"
load_env

BUCKET="${VAULT_BUCKET:-}"; REGION="${VAULT_REGION:-}"; USER_NS="${VAULT_USER:-}"; VAULT=""; ROTATE=0
while [ $# -gt 0 ]; do case "$1" in
  --vault) VAULT="$2"; shift 2 ;;
  --user) USER_NS="$2"; shift 2 ;;
  --bucket) BUCKET="$2"; shift 2 ;;
  --region) REGION="$2"; shift 2 ;;
  --rotate-token) ROTATE=1; shift ;;
  --yes) ASSUME_YES=1; shift ;;
  --dry-run) DRY_RUN=1; shift ;;
  -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
  *) die "unknown arg: $1" ;;
esac; done

require_tools aws jq node npm openssl; require_aws
[ -n "$VAULT" ] || die "--vault is required"
[ -n "$BUCKET" ] || die "--bucket (or VAULT_BUCKET) is required"
[ -n "$REGION" ] || die "--region (or VAULT_REGION) is required"
[ -n "$USER_NS" ] || USER_NS="$(derive_user)"

ROLE="vault-mcp-$USER_NS"
FUNC="vault-mcp-$USER_NS-$VAULT"
PREFIX="$(vault_prefix "$USER_NS" "$VAULT")"
CREDS="$SECRETS_DIR/mcp-$USER_NS-$VAULT.json"
ZIP="$REPO_DIR/packages/mcp-server/dist/mcp-server.zip"
mkdir -p "$SECRETS_DIR"

# --- 1. execution role (shared per user — the S3 scope covers all this user's vaults) ---------
step "Execution role '$ROLE'  (scope s3://$BUCKET/$USER_NS/*)"
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
ROLE_CREATED=0
if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  log "role exists — ensuring policies"
else
  confirm "Create IAM role '$ROLE'?" || die "aborted"
  if [ "${DRY_RUN:-0}" = 1 ]; then
    log "[dry-run] would create role $ROLE (trust: lambda.amazonaws.com)"
  else
    aws iam create-role --role-name "$ROLE" --assume-role-policy-document "$TRUST" \
      --tags Key=managed-by,Value=vault-sync >/dev/null
    ROLE_CREATED=1
    log "created"
  fi
fi

POL="$(mktemp)"; trap 'rm -f "$POL"' EXIT
cat >"$POL" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "Objects", "Effect": "Allow",
      "Action": ["s3:GetObject","s3:GetObjectVersion","s3:PutObject","s3:DeleteObject"],
      "Resource": "arn:aws:s3:::$BUCKET/$USER_NS/*" },
    { "Sid": "ListScoped", "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::$BUCKET",
      "Condition": { "StringLike": { "s3:prefix": ["$USER_NS/*"] } } }
  ]
}
JSON
run aws iam put-role-policy --role-name "$ROLE" --policy-name s3 --policy-document "file://$POL"
log "logs → AWSLambdaBasicExecutionRole"
run aws iam attach-role-policy --role-name "$ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
ROLE_ARN="arn:aws:iam::$(aws_account_id):role/$ROLE"

# --- 2. bearer token (phase-0 auth — design §4) -----------------------------------------------
step "Bearer token"
if [ -s "$CREDS" ] && [ "$ROTATE" != 1 ]; then
  TOKEN="$(jq -r .token "$CREDS")"
  log "reusing token from $CREDS (use --rotate-token to replace)"
else
  [ "$ROTATE" = 1 ] && warn "rotating: previously issued token stops working once the function updates"
  TOKEN="$(openssl rand -hex 32)"
  if [ "${DRY_RUN:-0}" = 1 ]; then
    log "[dry-run] would mint a token and write $CREDS"
  else
    umask 077
    jq -n --arg t "$TOKEN" '{token: $t}' >"$CREDS"; chmod 600 "$CREDS"
    log "token saved → $CREDS (never printed)"
  fi
fi
# dry-run echoes full aws commands — never let the real token into that output
[ "${DRY_RUN:-0}" = 1 ] && TOKEN="<redacted>"

# --- 3. build the bundle ----------------------------------------------------------------------
step "Build Lambda bundle"
run npm --prefix "$REPO_DIR" run build:mcp
[ "${DRY_RUN:-0}" = 1 ] || [ -s "$ZIP" ] || die "bundle missing: $ZIP"

# --- 4. Lambda function -----------------------------------------------------------------------
# AWS_REGION is set by the Lambda runtime itself (it is a reserved key — do not put it in env).
step "Lambda '$FUNC'  (BUCKET=$BUCKET  PREFIX=$PREFIX)"
ENVJSON="$(jq -n --arg b "$BUCKET" --arg p "$PREFIX" --arg t "$TOKEN" \
  '{Variables:{BUCKET:$b,PREFIX:$p,MCP_BEARER_TOKEN:$t}}')"
if aws lambda get-function --function-name "$FUNC" --region "$REGION" >/dev/null 2>&1; then
  if [ "${DRY_RUN:-0}" = 1 ]; then
    log "[dry-run] would update code from $ZIP and reapply env/timeout/memory"
  else
    log "function exists — updating code + config"
    aws lambda update-function-code --function-name "$FUNC" --zip-file "fileb://$ZIP" \
      --region "$REGION" --no-cli-pager >/dev/null
    aws lambda wait function-updated --function-name "$FUNC" --region "$REGION"
    aws lambda update-function-configuration --function-name "$FUNC" \
      --environment "$ENVJSON" --timeout 30 --memory-size 512 \
      --region "$REGION" --no-cli-pager >/dev/null
    aws lambda wait function-updated --function-name "$FUNC" --region "$REGION"
    log "updated"
  fi
else
  confirm "Create Lambda function '$FUNC'?" || die "aborted"
  if [ "${DRY_RUN:-0}" = 1 ]; then
    log "[dry-run] would create function $FUNC (nodejs22.x, arm64, role $ROLE_ARN)"
  else
    # a just-created role takes a few seconds to become assumable by Lambda — retry briefly
    CREATED=0; ERR=""
    for i in 1 2 3 4 5 6 7 8; do
      if ERR="$(aws lambda create-function --function-name "$FUNC" \
            --runtime nodejs22.x --architectures arm64 --handler index.handler \
            --role "$ROLE_ARN" --timeout 30 --memory-size 512 \
            --environment "$ENVJSON" --zip-file "fileb://$ZIP" \
            --region "$REGION" --no-cli-pager 2>&1 >/dev/null)"; then CREATED=1; break; fi
      [ "$ROLE_CREATED" = 1 ] || break
      [ "$i" = 1 ] && log "waiting for IAM role propagation…"
      sleep 5
    done
    [ "$CREATED" = 1 ] || die "create-function failed: $ERR"
    aws lambda wait function-active --function-name "$FUNC" --region "$REGION"
    log "created"
  fi
fi

# --- 5. public Function URL (transport is public; auth lives in the handler) ------------------
step "Function URL"
URL="$(aws lambda get-function-url-config --function-name "$FUNC" --region "$REGION" \
        --query FunctionUrl --output text 2>/dev/null || true)"
if [ -n "$URL" ]; then
  log "url exists"
elif [ "${DRY_RUN:-0}" = 1 ]; then
  log "[dry-run] would create Function URL (auth-type NONE — bearer auth lives in the handler)"
else
  aws lambda create-function-url-config --function-name "$FUNC" --auth-type NONE \
    --region "$REGION" --no-cli-pager >/dev/null
  URL="$(aws lambda get-function-url-config --function-name "$FUNC" --region "$REGION" \
          --query FunctionUrl --output text 2>/dev/null || true)"
  log "created"
fi
# Since Oct 2025 public function URLs need BOTH grants (InvokeFunctionUrl alone → 403 Forbidden).
# The FunctionUrlAuthType=NONE condition scopes them to URL invocations only.
POLICY_DOC="$(aws lambda get-policy --function-name "$FUNC" --region "$REGION" \
                --query Policy --output text 2>/dev/null || true)"
for GRANT in "FunctionURLPublicAccess lambda:InvokeFunctionUrl" \
             "FunctionURLPublicInvokeFunction lambda:InvokeFunction"; do
  SID="${GRANT%% *}"; ACTION="${GRANT##* }"
  if printf '%s' "$POLICY_DOC" | grep -q "\"$SID\""; then
    log "public $ACTION permission present"
  elif [ "${DRY_RUN:-0}" = 1 ]; then
    log "[dry-run] would add public $ACTION permission (condition: FunctionUrlAuthType=NONE)"
  else
    aws lambda add-permission --function-name "$FUNC" --statement-id "$SID" \
      --action "$ACTION" --principal '*' --function-url-auth-type NONE \
      --region "$REGION" --no-cli-pager >/dev/null
    log "public $ACTION permission added"
  fi
done

# --- 6. record + summary ----------------------------------------------------------------------
if [ "${DRY_RUN:-0}" != 1 ] && [ -n "$URL" ]; then
  TMP="$(mktemp)"
  jq --arg f "$FUNC" --arg u "$URL" --arg r "$REGION" '. + {functionName:$f, url:$u, region:$r}' \
    "$CREDS" >"$TMP" && mv "$TMP" "$CREDS" && chmod 600 "$CREDS"
fi

step "MCP server ready for '$VAULT'"
log "Endpoint: ${URL:-https://<function-url>/}mcp"
log "Token:    $CREDS   (never printed; ships to the client via the command below)"
log "Redeploy code only:  AWS_REGION=$REGION MCP_FUNCTION=$FUNC npm run deploy -w @vault-sync/mcp-server"
log "Claude Code:"
printf '    claude mcp add --transport http %s "%smcp" --header "Authorization: Bearer $(jq -r .token %s)"\n' \
  "vault-$VAULT" "${URL:-https://<function-url>/}" "$CREDS"
