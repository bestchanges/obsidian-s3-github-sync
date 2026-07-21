#!/usr/bin/env bash
#
# restore.sh — list snapshots and restore the vault from a restic backup repo.
# Design & rationale: ../../BACKUP.md §8.
#
# Panic read ("I just need my notes"):
#   ./restore.sh --repo drive --list
#   ./restore.sh --repo drive --snapshot <id|latest> --target ./restored
#   → ./restored/files/**  is the vault as plain files (open in Obsidian, or read directly).
#
# Rebuild the live hub afterwards (see BACKUP.md §8.2): pause sync on all devices, then
#   aws s3 sync ./restored s3://<bucket>/<prefix> --delete   (needs a WRITE identity, not the backup one)
#
# Usage: ./restore.sh --repo <drive|b2|gdrive|RAW> [--list] [--snapshot ID] [--target DIR] [--include PATH]
#
set -euo pipefail
. "$(dirname "$0")/lib.sh"
load_env

DEST=""; DO_LIST=0; SNAP="latest"; TARGET="./restored"; INCLUDE=""
while [ $# -gt 0 ]; do case "$1" in
  --repo)     DEST="$2"; shift 2 ;;
  --list)     DO_LIST=1; shift ;;
  --snapshot) SNAP="$2"; shift 2 ;;
  --target)   TARGET="$2"; shift 2 ;;
  --include)  INCLUDE="$2"; shift 2 ;;   # e.g. --include /files/Journal to pull one folder back
  -h|--help)  sed -n '2,18p' "$0"; exit 0 ;;
  *) die "unknown arg: $1" ;;
esac; done

require_tools restic
[ -n "$DEST" ] || die "--repo required (drive|b2|gdrive or a raw restic repo string)"
[ -n "${RESTIC_PASSWORD_FILE:-}" ] || [ -n "${RESTIC_PASSWORD:-}" ] \
  || die "set RESTIC_PASSWORD_FILE or RESTIC_PASSWORD"

RESTIC_REPO="$(resolve_repo "$DEST")"; export RESTIC_REPO
repo_reachable "$RESTIC_REPO" || die "repo not reachable: $RESTIC_REPO"

if [ "$DO_LIST" = 1 ]; then
  step "Snapshots in $DEST ($RESTIC_REPO)"
  rc snapshots
  echo; log "pick an ID, then: $0 --repo $DEST --snapshot <id> --target <dir>"
  exit 0
fi

step "Restore $SNAP from $DEST → $TARGET"
mkdir -p "$TARGET"
if [ -n "$INCLUDE" ]; then
  rc restore "$SNAP" --target "$TARGET" --include "$INCLUDE"
else
  rc restore "$SNAP" --target "$TARGET"
fi

# restic restores under the original absolute staging path; surface where files/ actually landed.
vault_root="$(find "$TARGET" -type d -name files -maxdepth 6 2>/dev/null | head -1)"
if [ -n "$vault_root" ]; then
  count="$(find "$vault_root" -type f 2>/dev/null | wc -l | tr -d ' ')"
  log "restored $count files — vault content is at: ${vault_root%/files}"
  log "open '${vault_root%/files}' as an Obsidian vault, or read '$vault_root' directly"
else
  warn "restore finished but no files/ dir found under $TARGET — inspect it manually"
fi
