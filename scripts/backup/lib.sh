#!/usr/bin/env bash
# Shared helpers for the backup scripts. Source it, don't run it.
# Self-contained (modeled on scripts/install/lib.sh) so backup.sh/restore.sh keep working
# even when copied to a home machine outside this repo.
# shellcheck shell=bash

BACKUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- logging -----------------------------------------------------------------
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; Z=$'\033[0m'; else B=; G=; Y=; R=; Z=; fi
log()  { printf '%s•%s %s\n' "$G" "$Z" "$*"; }
step() { printf '\n%s== %s ==%s\n' "$B" "$*" "$Z"; }
warn() { printf '%s! %s%s\n' "$Y" "$*" "$Z" >&2; }
die()  { printf '%s✗ %s%s\n' "$R" "$*" "$Z" >&2; exit 1; }

# --- env ---------------------------------------------------------------------
# Load scripts/backup/.env if present (shared settings; CLI flags / real env still override).
load_env() {
  if [ -f "$BACKUP_DIR/.env" ]; then
    set -a; # shellcheck disable=SC1091
    . "$BACKUP_DIR/.env"; set +a
  fi
}

# --- prerequisites -----------------------------------------------------------
require_tools() {
  local missing=()
  for t in "$@"; do command -v "$t" >/dev/null 2>&1 || missing+=("$t"); done
  [ ${#missing[@]} -eq 0 ] || die "missing required tools: ${missing[*]}"
}

# --- restic repo resolution --------------------------------------------------
# Map a destination alias (drive|b2|gdrive) to its restic repo string via *_REPO env.
# Prints the repo string on stdout, or dies.
resolve_repo() {
  case "$1" in
    drive)  printf '%s' "${DRIVE_REPO:?DRIVE_REPO not set (e.g. /Volumes/Backup/vault-restic)}" ;;
    b2)     printf '%s' "${B2_REPO:?B2_REPO not set (e.g. b2:my-bucket:vault-restic)}" ;;
    gdrive) printf '%s' "${GDRIVE_REPO:?GDRIVE_REPO not set (e.g. rclone:gdrive:vault-restic)}" ;;
    *)      printf '%s' "$1" ;;  # allow passing a raw restic repo string
  esac
}

# A local restic repo (starts with '/') needs its parent dir present — i.e. the drive mounted.
# Returns non-zero (with a warning) when the parent is missing so callers can skip cleanly.
repo_reachable() {
  local repo="$1"
  case "$repo" in
    /*) if [ ! -d "$(dirname "$repo")" ]; then
          warn "drive not mounted for '$repo' — skipping"; return 1
        fi ;;
  esac
  return 0
}

# restic wrapper pinned to a repo; RESTIC_PASSWORD_FILE / RESTIC_PASSWORD must be in the env.
rc() { restic -r "$RESTIC_REPO" "$@"; }
