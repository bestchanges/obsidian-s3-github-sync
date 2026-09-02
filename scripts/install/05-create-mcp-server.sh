#!/usr/bin/env bash
#
# 05-create-mcp-server.sh — per-vault remote MCP server (Lambda + Function URL), phase-0 bearer auth.
#
# Builds packages/mcp-server and provisions (idempotently): an execution role `vault-mcp-<user>`
# scoped to s3://<bucket>/<user>/*, a Lambda `vault-mcp-<user>-<vault>` pointed at that vault's
# prefix, a public Function URL (auth enforced in-handler), and a bearer token saved to
# .secrets/mcp-<user>-<vault>.json. Then publishes <prefix>mcp.json (no secret) so every device's
# plugin settings can show how to connect, writes .secrets/mcp-<user>-<vault>-connect.md with the
# per-client config, and verifies the deployment with an MCP handshake. Also sets up OAuth (the
# in-Lambda authorization server) so browser clients — claude.ai, ChatGPT, the Gemini app — can
# connect: it mints a signing key and takes an owner passphrase for the consent page.
# Setup guide: MCP.md · design: "MCP Server Design.md" · details: packages/mcp-server/README.md
#
# Usage: ./05-create-mcp-server.sh --vault NAME [--user NS] [--bucket B] [--region R]
#                                  [--rotate-token] [--passphrase P] [--rotate-oauth-key]
#                                  [--no-oauth] [--yes] [--dry-run]
#
set -euo pipefail
. "$(dirname "$0")/lib.sh"
load_env

BUCKET="${VAULT_BUCKET:-}"; REGION="${VAULT_REGION:-}"; USER_NS="${VAULT_USER:-}"; VAULT=""; ROTATE=0
PASSPHRASE=""; ROTATE_OAUTH=0; NO_OAUTH=0
while [ $# -gt 0 ]; do case "$1" in
  --vault) VAULT="$2"; shift 2 ;;
  --user) USER_NS="$2"; shift 2 ;;
  --bucket) BUCKET="$2"; shift 2 ;;
  --region) REGION="$2"; shift 2 ;;
  --rotate-token) ROTATE=1; shift ;;
  --passphrase) PASSPHRASE="$2"; shift 2 ;;
  --rotate-oauth-key) ROTATE_OAUTH=1; shift ;;
  --no-oauth) NO_OAUTH=1; shift ;;
  --yes) ASSUME_YES=1; shift ;;
  --dry-run) DRY_RUN=1; shift ;;
  -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
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

# --- 2b. OAuth (in-Lambda authorization server — MCP.md §"web clients") ------------------------
# Two secrets: a signing key for the tokens this server issues, and a scrypt hash of the vault
# owner's passphrase, which is the only thing the consent page checks. The passphrase itself is
# never stored — rotating the key (--rotate-oauth-key) invalidates every issued token at once.
step "OAuth authorization server"
SIGNING_KEY=""; PASSWORD_HASH=""
if [ "$NO_OAUTH" = 1 ]; then
  log "skipped (--no-oauth): bearer-token clients only"
else
  [ -s "$CREDS" ] && SIGNING_KEY="$(jq -r '.oauthSigningKey // ""' "$CREDS")"
  [ -s "$CREDS" ] && PASSWORD_HASH="$(jq -r '.loginPasswordHash // ""' "$CREDS")"
  if [ "$ROTATE_OAUTH" = 1 ] || [ -z "$SIGNING_KEY" ]; then
    [ "$ROTATE_OAUTH" = 1 ] && [ -n "$SIGNING_KEY" ] && warn "rotating the signing key signs every connected app out"
    SIGNING_KEY="$(openssl rand -hex 32)"
  fi
  # Ask only when we have nowhere to read it from and someone is there to type it.
  if [ -z "$PASSPHRASE" ] && [ -z "$PASSWORD_HASH" ] && [ -t 0 ] && [ "${DRY_RUN:-0}" != 1 ]; then
    printf 'Vault passphrase for the OAuth consent page (empty = skip OAuth): '
    read -r -s PASSPHRASE; printf '\n'
  fi
  if [ -n "$PASSPHRASE" ]; then
    # Mirrors hashPassword() in packages/mcp-server/src/oauth/password.ts — same parameters and
    # format (scrypt$N$r$p$saltHex$hashHex). Change one, change the other.
    PASSWORD_HASH="$(VAULT_PASSPHRASE="$PASSPHRASE" node -e '
      const { randomBytes, scryptSync } = require("node:crypto");
      const salt = randomBytes(16);
      const key = scryptSync(process.env.VAULT_PASSPHRASE, salt, 32, { N: 16384, r: 8, p: 1 });
      process.stdout.write(["scrypt",16384,8,1,salt.toString("hex"),key.toString("hex")].join("$"));
    ')"
    log "passphrase hashed (scrypt) — the passphrase itself is never stored"
  fi
  if [ -z "$PASSWORD_HASH" ]; then
    SIGNING_KEY=""
    warn "no passphrase → OAuth stays off; bearer-token clients still work (pass --passphrase to enable)"
  else
    if [ "${DRY_RUN:-0}" != 1 ]; then
      umask 077
      TMPC="$(mktemp)"
      jq --arg k "$SIGNING_KEY" --arg h "$PASSWORD_HASH" \
        '. + {oauthSigningKey:$k, loginPasswordHash:$h}' "$CREDS" >"$TMPC" \
        && mv "$TMPC" "$CREDS" && chmod 600 "$CREDS"
    fi
    log "signing key + passphrase hash saved → $CREDS (never printed)"
  fi
fi
[ "${DRY_RUN:-0}" = 1 ] && [ -n "$SIGNING_KEY" ] && { SIGNING_KEY="<redacted>"; PASSWORD_HASH="<redacted>"; }

# --- 3. build the bundle ----------------------------------------------------------------------
step "Build Lambda bundle"
run npm --prefix "$REPO_DIR" run build:mcp
[ "${DRY_RUN:-0}" = 1 ] || [ -s "$ZIP" ] || die "bundle missing: $ZIP"

# --- 4. Lambda function -----------------------------------------------------------------------
# AWS_REGION is set by the Lambda runtime itself (it is a reserved key — do not put it in env).
# 60 s / 1024 MB: search has no index, so one call folds remote state and reads candidate notes in
# parallel (packages/mcp-server/src/vault.ts). Its own budget stops at 20 s — this is the headroom
# around it, and more memory buys proportionally more CPU and network for the parallel reads.
TIMEOUT=60
MEMORY=1024
step "Lambda '$FUNC'  (BUCKET=$BUCKET  PREFIX=$PREFIX)"
ENVJSON="$(jq -n --arg b "$BUCKET" --arg p "$PREFIX" --arg t "$TOKEN" \
  --arg k "$SIGNING_KEY" --arg h "$PASSWORD_HASH" \
  '{Variables:{BUCKET:$b,PREFIX:$p,MCP_BEARER_TOKEN:$t}}
   + (if $k == "" then {} else {Variables:{BUCKET:$b,PREFIX:$p,MCP_BEARER_TOKEN:$t,
        MCP_OAUTH_SIGNING_KEY:$k, MCP_LOGIN_PASSWORD_HASH:$h}} end)')"
if aws lambda get-function --function-name "$FUNC" --region "$REGION" >/dev/null 2>&1; then
  if [ "${DRY_RUN:-0}" = 1 ]; then
    log "[dry-run] would update code from $ZIP and reapply env/timeout/memory"
  else
    log "function exists — updating code + config"
    aws lambda update-function-code --function-name "$FUNC" --zip-file "fileb://$ZIP" \
      --region "$REGION" --no-cli-pager >/dev/null
    aws lambda wait function-updated --function-name "$FUNC" --region "$REGION"
    aws lambda update-function-configuration --function-name "$FUNC" \
      --environment "$ENVJSON" --timeout "$TIMEOUT" --memory-size "$MEMORY" \
      --region "$REGION" --no-cli-pager >/dev/null
    aws lambda wait function-updated --function-name "$FUNC" --region "$REGION"
    log "updated"
  fi
else
  confirm "Create Lambda function '$FUNC'?" || die "aborted"
  if [ "${DRY_RUN:-0}" = 1 ]; then
    log "[dry-run] would create function $FUNC (nodejs22.x, arm64, ${TIMEOUT}s/${MEMORY}MB, role $ROLE_ARN)"
  else
    # a just-created role takes a few seconds to become assumable by Lambda — retry briefly
    CREATED=0; ERR=""
    for i in 1 2 3 4 5 6 7 8; do
      if ERR="$(aws lambda create-function --function-name "$FUNC" \
            --runtime nodejs22.x --architectures arm64 --handler index.handler \
            --role "$ROLE_ARN" --timeout "$TIMEOUT" --memory-size "$MEMORY" \
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
# AWS accepts the FunctionUrlAuthType=NONE condition only on InvokeFunctionUrl; the InvokeFunction
# grant is necessarily unconditioned — safe here because the Invoke API itself requires SigV4
# (anonymous traffic can only arrive via the URL) and the handler's bearer check gates everything.
POLICY_DOC="$(aws lambda get-policy --function-name "$FUNC" --region "$REGION" \
                --query Policy --output text 2>/dev/null || true)"
for GRANT in "FunctionURLPublicAccess lambda:InvokeFunctionUrl" \
             "FunctionURLPublicInvokeFunction lambda:InvokeFunction"; do
  SID="${GRANT%% *}"; ACTION="${GRANT##* }"
  COND=(); [ "$ACTION" = "lambda:InvokeFunctionUrl" ] && COND=(--function-url-auth-type NONE)
  if printf '%s' "$POLICY_DOC" | grep -q "\"$SID\""; then
    log "public $ACTION permission present"
  elif [ "${DRY_RUN:-0}" = 1 ]; then
    log "[dry-run] would add public $ACTION permission"
  else
    # ${COND[@]+…}: empty-array expansion trips `set -u` on macOS bash 3.2
    aws lambda add-permission --function-name "$FUNC" --statement-id "$SID" \
      --action "$ACTION" --principal '*' ${COND[@]+"${COND[@]}"} \
      --region "$REGION" --no-cli-pager >/dev/null
    log "public $ACTION permission added"
  fi
done

# --- 6. record locally --------------------------------------------------------------------------
if [ "${DRY_RUN:-0}" != 1 ] && [ -n "$URL" ]; then
  TMP="$(mktemp)"
  jq --arg f "$FUNC" --arg u "$URL" --arg r "$REGION" '. + {functionName:$f, url:$u, region:$r}' \
    "$CREDS" >"$TMP" && mv "$TMP" "$CREDS" && chmod 600 "$CREDS"
fi

ENDPOINT="${URL:-https://<function-url>/}mcp"
SERVER_NAME="vault-$(printf '%s' "$VAULT" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9_-]\{1,\}/-/g' -e 's/^-*//' -e 's/-*$//')"

# --- 7. publish connection info to the vault -----------------------------------------------------
# `<prefix>mcp.json` sits beside snapshot.json.gz / deltas/ / files/ / _logs/. Neither sync leg
# lists or folds anything outside those, so it never becomes vault content and never reaches the
# GitHub repo — it is a side-channel the plugin reads to show every device how to connect
# (IMPLEMENTATION.md §4.15). It carries NO secret: the token stays in .secrets and is pasted
# per-device. Tool names are read out of the source so this can't drift from what ships.
step "Publish connection info  (s3://$BUCKET/${PREFIX}mcp.json)"
TOOLS_JSON="$(grep -A1 'registerTool(\|registerWrite(' "$REPO_DIR/packages/mcp-server/src/mcp.ts" \
  | grep -o '"[a-z_]\{3,\}"' | tr -d '"' | jq -R . | jq -sc . 2>/dev/null || echo '[]')"
AUTH_MODES='["bearer"]'
[ -n "$PASSWORD_HASH" ] && AUTH_MODES='["bearer","oauth"]'
INFO="$(jq -n --arg e "$ENDPOINT" --arg r "$REGION" --arg f "$FUNC" --arg v "$VAULT" \
  --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson tools "$TOOLS_JSON" --argjson modes "$AUTH_MODES" \
  '{version:1, endpoint:$e, region:$r, functionName:$f, vault:$v,
    authModes:$modes, tools:$tools, updatedAt:$t, docs:"MCP.md"}')"
if [ "${DRY_RUN:-0}" = 1 ]; then
  log "[dry-run] would put mcp.json: $(printf '%s' "$INFO" | jq -c .)"
else
  INFO_FILE="$(mktemp)"; printf '%s\n' "$INFO" >"$INFO_FILE"
  aws s3api put-object --bucket "$BUCKET" --key "${PREFIX}mcp.json" --body "$INFO_FILE" \
    --content-type application/json --region "$REGION" --no-cli-pager >/dev/null
  rm -f "$INFO_FILE"
  log "published — the plugin's 'AI assistants (MCP)' settings section picks this up on every device"
fi

# --- 8. connect sheet (holds the token → .secrets, 600) -------------------------------------------
SHEET="$SECRETS_DIR/mcp-$USER_NS-$VAULT-connect.md"
step "Connect sheet"
if [ "${DRY_RUN:-0}" = 1 ]; then
  log "[dry-run] would write $SHEET"
else
  TOKEN="$(jq -r .token "$CREDS")"
  if [ -n "$PASSWORD_HASH" ]; then
    WEB_SECTION="Add a custom connector with this URL — no token, no header:

\`\`\`
$ENDPOINT
\`\`\`

The client runs OAuth against the server itself: it opens a consent page, you enter the **vault
passphrase** you set during install, approve, and it is connected. Add \`?scope=vault.read\` support
by asking the client for read-only access if you want a look-but-don't-touch connector."
  else
    WEB_SECTION="Not enabled for this deployment: these paste a URL into a connector dialog and
cannot send a static header, so they need the OAuth mode. Re-run the installer with
\`--passphrase '<your passphrase>'\` to switch it on."
  fi
  umask 077
  cat >"$SHEET" <<SHEETEOF
# Connect an AI assistant to vault \`$VAULT\`

Endpoint: \`$ENDPOINT\`
Auth: static bearer token (below). Full guide: MCP.md in the vault-sync repo.

> This file contains the token. Keep it in .secrets; anyone holding it can read and write the vault.

## Claude Code

\`\`\`bash
claude mcp add --transport http $SERVER_NAME "$ENDPOINT" --header "Authorization: Bearer $TOKEN"
\`\`\`

## Claude Desktop — Settings → Developer → Edit Config

\`\`\`json
{ "mcpServers": { "$SERVER_NAME": { "type": "http", "url": "$ENDPOINT",
    "headers": { "Authorization": "Bearer $TOKEN" } } } }
\`\`\`

## Gemini CLI — ~/.gemini/settings.json

\`\`\`json
{ "mcpServers": { "$SERVER_NAME": { "httpUrl": "$ENDPOINT",
    "headers": { "Authorization": "Bearer $TOKEN" } } } }
\`\`\`

## Obsidian (any device)

Settings → S3 Vault Sync → **AI assistants (MCP)** → paste the token:

\`\`\`
$TOKEN
\`\`\`

## claude.ai · ChatGPT · Gemini app

$WEB_SECTION
SHEETEOF
  chmod 600 "$SHEET"
  log "written → $SHEET"
fi

# --- 9. verify + summary --------------------------------------------------------------------------
step "Verify"
if [ "${DRY_RUN:-0}" = 1 ]; then
  log "[dry-run] would POST an MCP initialize to $ENDPOINT"
elif command -v curl >/dev/null 2>&1; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST "$ENDPOINT" \
    -H "Authorization: Bearer $(jq -r .token "$CREDS")" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"installer","version":"1"}}}' || echo 000)"
  case "$CODE" in
    200) log "handshake OK (HTTP 200)" ;;
    401) warn "handshake rejected (401) — the function may still be applying the new token; retry in a moment" ;;
    *)   warn "handshake returned HTTP $CODE — check: aws logs tail /aws/lambda/$FUNC --follow" ;;
  esac
  if [ -n "$PASSWORD_HASH" ]; then
    for DOC in .well-known/oauth-protected-resource .well-known/oauth-authorization-server; do
      DCODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${URL}${DOC}" || echo 000)"
      [ "$DCODE" = 200 ] && log "$DOC OK" || warn "$DOC returned HTTP $DCODE"
    done
    # A challenge on the 401 is what makes a browser client able to discover any of this.
    CHALLENGE="$(curl -s -o /dev/null -D - --max-time 20 -X POST "$ENDPOINT" -d '{}' 2>/dev/null \
      | tr -d '\r' | awk 'tolower($1) == "www-authenticate:" {$1=""; print substr($0,2)}')"
    case "$CHALLENGE" in
      *resource_metadata=*) log "401 challenge advertises the metadata URL" ;;
      *) warn "401 challenge missing resource_metadata: ${CHALLENGE:-<none>}" ;;
    esac
  fi
else
  warn "curl not found — skipped the handshake check"
fi

step "MCP server ready for '$VAULT'"
log "Endpoint:  $ENDPOINT"
log "Token:     $CREDS   (never printed)"
log "Connect:   $SHEET   (per-client copy-paste, includes the token)"
if [ -n "$PASSWORD_HASH" ]; then
  log "Web clients (claude.ai / ChatGPT / Gemini app): add the endpoint above as a custom connector"
  log "             and sign in with your vault passphrase on the consent page."
else
  log "Web clients: OAuth is off — re-run with --passphrase '<passphrase>' to enable them."
fi
log "In Obsidian: Settings → S3 Vault Sync → 'AI assistants (MCP)' — endpoint and configs appear on every device"
log "Redeploy code only:  AWS_REGION=$REGION MCP_FUNCTION=$FUNC npm run deploy -w @vault-sync/mcp-server"
log "Claude Code:"
printf '    claude mcp add --transport http %s "%s" --header "Authorization: Bearer $(jq -r .token %s)"\n' \
  "$SERVER_NAME" "$ENDPOINT" "$CREDS"
