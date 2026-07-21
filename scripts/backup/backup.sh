#!/usr/bin/env bash
#
# backup.sh — pull the vault's S3 hub state (read-only) and snapshot it into one or more
# independent restic repositories: external drive, Backblaze B2, Google Drive (via rclone).
# Design & rationale: ../../BACKUP.md.
#
# Two stages per run:
#   1. FETCH   aws s3 sync  s3://<bucket>/<prefix>  → staging   (minus _logs/**)
#   2. SNAPSHOT  restic backup staging  → each destination, then optional forget/prune/check
#
# Usage: ./backup.sh [--dests drive,b2,gdrive] [--prune] [--check light|full] [--dry-run]
#   Config comes from env / scripts/backup/.env (see .env.shadow). CLI flags override.
#
# Required env:
#   BUCKET, PREFIX, AWS_REGION           S3 source (PREFIX ends with '/')
#   RESTIC_PASSWORD_FILE | RESTIC_PASSWORD
#   DRIVE_REPO | B2_REPO | GDRIVE_REPO    per chosen destination (+ backend creds, see .env.shadow)
# Optional env (defaults):
#   DESTS=drive          KEEP_DAILY=14 KEEP_WEEKLY=8 KEEP_MONTHLY=12 KEEP_YEARLY=3
#   MAX_AGE_HOURS=36     VAULT_TAG=vault  STAGING=<tmp>
#
set -euo pipefail
. "$(dirname "$0")/lib.sh"
load_env

DESTS="${DESTS:-drive}"; PRUNE=0; CHECK="${CHECK:-0}"; DRY_RUN=0
KEEP_DAILY="${KEEP_DAILY:-14}"; KEEP_WEEKLY="${KEEP_WEEKLY:-8}"
KEEP_MONTHLY="${KEEP_MONTHLY:-12}"; KEEP_YEARLY="${KEEP_YEARLY:-3}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-36}"; VAULT_TAG="${VAULT_TAG:-vault}"

while [ $# -gt 0 ]; do case "$1" in
  --dests)   DESTS="$2"; shift 2 ;;
  --prune)   PRUNE=1; shift ;;
  --check)   CHECK="$2"; shift 2 ;;
  --dry-run) DRY_RUN=1; shift ;;
  -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  *) die "unknown arg: $1" ;;
esac; done

require_tools aws restic
: "${BUCKET:?BUCKET required}"; : "${PREFIX:?PREFIX required (must end with /)}"
: "${AWS_REGION:?AWS_REGION required}"
[ -n "${RESTIC_PASSWORD_FILE:-}" ] || [ -n "${RESTIC_PASSWORD:-}" ] \
  || die "set RESTIC_PASSWORD_FILE or RESTIC_PASSWORD (the master backup secret)"
export AWS_REGION
case "$PREFIX" in */) ;; *) die "PREFIX must end with '/': $PREFIX" ;; esac

run() { if [ "$DRY_RUN" = 1 ]; then printf '%s[dry-run]%s %s\n' "$Y" "$Z" "$*"; else "$@"; fi; }

# ── Stage 1: read-only pull of the S3 prefix ─────────────────────────────────
STAGING="${STAGING:-$(mktemp -d "${TMPDIR:-/tmp}/vault-backup.XXXXXX")}"
CLEAN_STAGING=0
[ -n "${STAGING_KEEP:-}" ] || CLEAN_STAGING=1
cleanup() { [ "$CLEAN_STAGING" = 1 ] && rm -rf "$STAGING"; }
trap cleanup EXIT

step "Fetch s3://$BUCKET/$PREFIX → $STAGING (read-only, excluding _logs/)"
# --delete keeps staging an exact mirror; _logs/** is a diagnostics side-channel, never backed up.
run aws s3 sync "s3://$BUCKET/$PREFIX" "$STAGING" --delete --exclude "_logs/*" --only-show-errors

if [ "$DRY_RUN" != 1 ]; then
  files=$(find "$STAGING/files" -type f 2>/dev/null | wc -l | tr -d ' ')
  [ "${files:-0}" -gt 0 ] || die "refusing to back up: staging has 0 files under files/ (bad pull? empty vault?)"
  log "staged $files file objects"
fi

# ── Stage 2: snapshot into each destination ──────────────────────────────────
backup_one() {
  local dest="$1" repo; repo="$(resolve_repo "$dest")"
  repo_reachable "$repo" || return 0
  export RESTIC_REPO="$repo"

  step "restic → $dest ($repo)"
  # init on first use (idempotent: only when the repo can't be opened)
  if ! rc snapshots >/dev/null 2>&1; then
    log "initializing new restic repo"
    run rc init
  fi

  run rc backup "$STAGING" --tag "$VAULT_TAG" --host vault-backup --compression auto

  if [ "$PRUNE" = 1 ]; then
    log "forget --prune (trusted leg)"
    run rc forget --tag "$VAULT_TAG" --group-by host,tags \
      --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" \
      --keep-monthly "$KEEP_MONTHLY" --keep-yearly "$KEEP_YEARLY" --prune
  fi

  case "$CHECK" in
    light) log "restic check (structure)";        run rc check ;;
    full)  log "restic check --read-data-subset"; run rc check --read-data-subset=5% ;;
    0|"")  ;;
    *) warn "unknown --check '$CHECK' (use light|full) — skipping check" ;;
  esac

  # Staleness alarm: newest snapshot must be younger than MAX_AGE_HOURS.
  if [ "$DRY_RUN" != 1 ] && [ "${MAX_AGE_HOURS:-0}" -gt 0 ]; then
    local latest snap snap_epoch now age_h
    latest="$(rc snapshots --tag "$VAULT_TAG" --latest 1 --json 2>/dev/null || echo '[]')"
    snap="$(printf '%s' "$latest" | sed -n 's/.*"time":"\([^"]*\)".*/\1/p' | head -1)"
    # strip fractional seconds / trailing zone for portable date parsing
    snap="${snap%%.*}"; snap="${snap%Z}"
    snap_epoch=""
    if [ -n "$snap" ]; then
      snap_epoch="$(date -u -d "$snap" +%s 2>/dev/null \
                    || date -u -jf "%Y-%m-%dT%H:%M:%S" "$snap" +%s 2>/dev/null || true)"
    fi
    if [ -n "$snap_epoch" ]; then
      now=$(date -u +%s)
      age_h=$(( (now - snap_epoch) / 3600 ))
      [ "$age_h" -le "$MAX_AGE_HOURS" ] || die "newest '$dest' snapshot is ${age_h}h old (> ${MAX_AGE_HOURS}h)"
      log "newest snapshot ${age_h}h old — OK"
    else
      warn "could not read newest snapshot time for staleness check"
    fi
  fi
  log "$dest done"
}

IFS=',' read -r -a dest_arr <<< "$DESTS"
for d in "${dest_arr[@]}"; do
  d="$(printf '%s' "$d" | tr -d ' ')"; [ -n "$d" ] || continue
  backup_one "$d"
done

step "Backup complete: [$DESTS]"
