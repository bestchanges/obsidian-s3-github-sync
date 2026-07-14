import { Snapshot } from "@vault-sync/core";

/** Default max snapshot age (hours) before compaction runs again; env `SNAPSHOT_MAX_AGE_HOURS`. */
export const DEFAULT_SNAPSHOT_MAX_AGE_HOURS = 24;

/**
 * Age gate for compaction (§2.5): git-sync runs often (push + 4-hourly cron) but the snapshot only
 * needs rebuilding about daily — clients always fold `snapshot ⊕ newer deltas`, so a fresher
 * snapshot just means fewer deltas to fold. Compact when no snapshot exists yet (cold-path clients
 * need one) or the existing one is at least maxAgeMs old. An unparseable `updatedAt` counts as
 * stale so a corrupt timestamp can't switch compaction off forever.
 */
export function shouldCompact(
  snapshot: Snapshot | null,
  maxAgeMs: number,
  now = Date.now(),
): boolean {
  if (!snapshot) return true;
  const age = now - Date.parse(snapshot.updatedAt);
  return Number.isNaN(age) || age >= maxAgeMs;
}
