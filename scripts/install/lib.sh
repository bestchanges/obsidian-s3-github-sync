#!/usr/bin/env bash
# Shared helpers for the install scripts. Source it, don't run it.
# shellcheck shell=bash

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$INSTALL_DIR/../.." && pwd)"
SECRETS_DIR="$INSTALL_DIR/.secrets"

# --- logging -----------------------------------------------------------------
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; Z=$'\033[0m'; else B=; G=; Y=; R=; Z=; fi
log()  { printf '%s•%s %s\n' "$G" "$Z" "$*"; }
step() { printf '\n%s== %s ==%s\n' "$B" "$*" "$Z"; }
warn() { printf '%s! %s%s\n' "$Y" "$*" "$Z" >&2; }
die()  { printf '%s✗ %s%s\n' "$R" "$*" "$Z" >&2; exit 1; }

# --- env ---------------------------------------------------------------------
# Load scripts/install/.env if present (shared settings; CLI flags still override).
load_env() {
  if [ -f "$INSTALL_DIR/.env" ]; then
    set -a; # shellcheck disable=SC1091
    . "$INSTALL_DIR/.env"; set +a
  fi
}

# --- prerequisites -----------------------------------------------------------
require_tools() {
  local missing=()
  for t in "$@"; do command -v "$t" >/dev/null 2>&1 || missing+=("$t"); done
  [ ${#missing[@]} -eq 0 ] || die "missing required tools: ${missing[*]}"
}

require_aws() {
  aws sts get-caller-identity >/dev/null 2>&1 || die "AWS not authenticated — run 'aws configure' / 'aws sso login'"
}
require_gh() {
  # Verify the ACTIVE account's token works — tolerant of other (stale) accounts in the keyring,
  # which make `gh auth status` exit non-zero even when the active login is fine.
  gh api user >/dev/null 2>&1 || die "GitHub CLI not authenticated for the active account — run 'gh auth login' (or 'gh auth switch')"
}

aws_account_id() { aws sts get-caller-identity --query Account --output text; }

# Namespace = your AWS IAM username. Prefer VAULT_USER, else derive from the caller ARN.
derive_user() {
  if [ -n "${VAULT_USER:-}" ]; then printf '%s' "$VAULT_USER"; return; fi
  local arn user
  arn="$(aws sts get-caller-identity --query Arn --output text)"
  # arn:aws:iam::acct:user/NAME  → NAME
  case "$arn" in
    */user/*) user="${arn##*/user/}"; printf '%s' "$user" ;;
    *) die "could not derive an IAM username from '$arn' — set VAULT_USER (or pass --user)" ;;
  esac
}

# --- misc --------------------------------------------------------------------
# The S3 key prefix for one vault: <user>/vaults/<vault>/
vault_prefix() { printf '%s/vaults/%s/' "$1" "$2"; }

confirm() {
  [ "${ASSUME_YES:-0}" = "1" ] && return 0
  local ans; read -r -p "$1 [y/N] " ans; [ "$ans" = "y" ] || [ "$ans" = "Y" ]
}

# DRY_RUN=1 → print the command instead of running it (mutating aws/gh calls wrap in this).
run() {
  if [ "${DRY_RUN:-0}" = "1" ]; then printf '%s[dry-run]%s %s\n' "$Y" "$Z" "$*"; else "$@"; fi
}

# ── change notifications (IMPLEMENTATION.md §4.14) ───────────────────────────
# The region every script should use: .env first, then the environment, then the CLI default.
# A silent fall-back to us-east-1 would mint endpoints and policy ARNs in a region where the
# grants don't apply, so an unresolvable region is a hard error at the call site.
vault_region() { printf '%s' "${VAULT_REGION:-${AWS_REGION:-$(aws configure get region || true)}}"; }

# MQTT topic for one vault. MUST match revTopic() in packages/obsidian-plugin/src/notify.ts and
# packages/git-sync/src/notify.ts — the three are one wire contract (see §4.14, §6 lockstep).
vault_topic() {
  local slug; slug="$(printf '%s' "$(vault_prefix "$1" "$2")" |
    sed -e 's/[^A-Za-z0-9_-]\{1,\}/-/g' -e 's/^-*//' -e 's/-*$//')"
  printf 'vaultsync/%s/rev' "${slug:-default}"
}

# Topic ARN pattern covering EVERY vault of one user: vaultsync/<user>-vaults-*/rev
#
# Deliberately wildcarded rather than per-vault. These policies are attached by name ('iot' on the
# plugin user, 'iot-publish' on the sync role) to per-USER identities, so a per-vault document would
# be overwritten the moment a second vault was set up — silently killing push for the first. The
# wildcard is also no wider in practice: the identity it is attached to already has S3 access to
# every one of that user's vaults.
vault_topic_arn_pattern() { # <user> <region> <account> [topic|topicfilter]
  printf 'arn:aws:iot:%s:%s:%s/vaultsync/%s-vaults-*/rev' "$2" "$3" "${4:-topic}" "$1"
}

# Inline IAM policy granting a plugin device connect/subscribe/receive/publish on that user's
# topics. Written identically by 02 (at user creation) and 06 (when enabling push on an existing
# deployment), so re-running either is a no-op rather than a fight.
vault_iot_policy_json() { # <user> <region> <account>
  cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "Connect", "Effect": "Allow", "Action": "iot:Connect",
      "Resource": "arn:aws:iot:$2:$3:client/*" },
    { "Sid": "Subscribe", "Effect": "Allow", "Action": "iot:Subscribe",
      "Resource": "$(vault_topic_arn_pattern "$1" "$2" "$3" topicfilter)" },
    { "Sid": "ReceivePublish", "Effect": "Allow", "Action": ["iot:Receive", "iot:Publish"],
      "Resource": "$(vault_topic_arn_pattern "$1" "$2" "$3" topic)" }
  ]
}
JSON
}
