/**
 * Per-file version history read off the delta journal (§2.9).
 *
 * The journal already records everything a version history needs — every write to a path carries
 * `rev`, `at`, `by` (WHICH DEVICE wrote it), `hash`, `size` and the `s3VersionId` of the bytes — so
 * history is a query over `deltas/`, not a second store. Obsidian exposes no API for a third-party
 * sync to supply history (its "Open version history" belongs to Obsidian Sync), so the plugin renders
 * this itself; keeping the query here means git-sync and the MCP server can serve the same view.
 *
 * Pure except for the storage-backed readers at the bottom, matching `journal.ts`.
 */

import { diffComm } from "node-diff3";
import { Delta, FileEntry, SnapshotEntry, Tombstone, isTombstone } from "./schemas";
import { GetResult, StorageAdapter } from "./s3";
import { canonicalKey } from "./casing";
import { listDeltasSince } from "./journal";

export const FILES_PREFIX = "files/";

export function fileKey(path: string): string {
  return `${FILES_PREFIX}${path}`;
}

/** One journal entry for a path, flattened for display. `path` is the key AS STORED at that rev —
 * it differs from the queried path across a rename, which is exactly what makes the trail readable. */
export interface FileVersion {
  rev: number;
  /** writer id: a device id, or "git-sync" for the Actions leg */
  by: string;
  /** ISO time the delta was published */
  at: string;
  path: string;
  deleted: boolean;
  /** tombstone only: the path this file's content moved to */
  renamedTo?: string;
  hash?: string;
  size?: number;
  /** author-time mtime on the writing device */
  mtime?: string;
  /** S3 version of `files/<path>` holding these exact bytes — the handle for reading content back */
  s3VersionId?: string;
}

/**
 * Every journal entry touching `path`, NEWEST FIRST, following renames backwards.
 *
 * Identity is case-insensitive/NFC-normalized (§2.8a), the same rule the merge legs use, so a
 * case-only rename doesn't split the trail in two.
 *
 * Rename-following: a rename emits `{old: {deleted, renamedTo: new}}` + `{new: FileEntry}` in ONE
 * delta. Walking newest→oldest, when the tracked path is `new` and some entry at that rev is a
 * tombstone whose `renamedTo` is `new`, the content came from `old` — so older revisions are looked
 * up under `old`. Without this, history for a renamed note stops at the rename.
 */
export function fileHistory(deltas: Delta[], path: string): FileVersion[] {
  const byRevDesc = [...deltas].sort((a, b) => b.rev - a.rev);
  const out: FileVersion[] = [];
  let tracked = canonicalKey(path);

  for (const d of byRevDesc) {
    // Resolve the tracked node within this delta (keys are case-sensitive in S3, identity is not).
    let hit: [string, FileEntry | Tombstone] | undefined;
    let renamedFrom: string | undefined;
    for (const [p, entry] of Object.entries(d.files)) {
      if (canonicalKey(p) === tracked) {
        hit = [p, entry as FileEntry | Tombstone];
        continue;
      }
      // old side of a rename INTO the tracked path — the trail continues under `p` below this rev
      const renamedTo = (entry as Tombstone).renamedTo;
      if (renamedTo && canonicalKey(renamedTo) === tracked) renamedFrom = p;
    }

    if (hit) out.push(toVersion(d, hit[0], hit[1]));
    // Switch AFTER recording this rev: the rename's own delta describes the new path.
    if (renamedFrom) tracked = canonicalKey(renamedFrom);
  }
  return out;
}

function toVersion(d: Delta, path: string, entry: FileEntry | Tombstone): FileVersion {
  const base = { rev: d.rev, by: d.by, at: d.at, path };
  if (isTombstone(entry)) {
    const t = entry as Tombstone;
    return { ...base, deleted: true, ...(t.renamedTo ? { renamedTo: t.renamedTo } : {}) };
  }
  const f = entry as FileEntry;
  return {
    ...base,
    deleted: false,
    hash: f.hash,
    size: f.size,
    mtime: f.mtime,
    ...(f.s3VersionId ? { s3VersionId: f.s3VersionId } : {}),
  };
}

/** The live entry a folded snapshot would resolve to, or null if the newest entry is a tombstone. */
export function latestLive(versions: FileVersion[]): FileVersion | null {
  const newest = versions[0];
  if (!newest || newest.deleted) return null;
  return newest;
}

export interface HistoryResult {
  versions: FileVersion[];
  /** Lowest revision still in the journal. History below it was pruned (§2.5) and is unavailable. */
  oldestRevAvailable: number;
  /** True when the journal has been pruned, so `versions` may be missing older entries. */
  truncated: boolean;
}

/**
 * Read the journal and extract one path's history. Fetches every surviving delta — the journal is
 * pruned to a retention window (§2.5), so this is bounded by that window, not by vault age.
 */
export async function readFileHistory(
  storage: StorageAdapter,
  path: string,
  concurrency = 8,
): Promise<HistoryResult> {
  const deltas = await listDeltasSince(storage, 0, concurrency);
  const oldestRevAvailable = deltas.length ? deltas[0].rev : 0;
  return {
    versions: fileHistory(deltas, path),
    oldestRevAvailable,
    // rev 1 present → nothing was ever pruned and the trail is complete back to the vault's first write
    truncated: oldestRevAvailable > 1,
  };
}

/**
 * Fetch the bytes of one version. Pinned by `s3VersionId` when the entry carries one; entries written
 * before the field existed (or by a leg that omitted it) fall back to the object's CURRENT version,
 * which is only correct if the file hasn't changed since — so callers verify against `hash`.
 */
export async function readVersionContent(
  storage: StorageAdapter,
  version: FileVersion,
): Promise<GetResult | null> {
  if (version.deleted) return null;
  return storage.get(
    fileKey(version.path),
    version.s3VersionId ? { versionId: version.s3VersionId } : undefined,
  );
}

export type DiffLineType = "common" | "removed" | "added";
export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/**
 * Two-way line diff for DISPLAY (older → newer). Same `diffComm` primitive the union merge aligns
 * conflict regions with (`merge.ts`), so what the history panel shows lines up with how a merge would
 * actually treat the two sides. Pure — any client (plugin, MCP server) can render the same result.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: DiffLine[] = [];
  for (const region of diffComm(a, b)) {
    if (region.common) {
      for (const text of region.common) out.push({ type: "common", text });
    } else {
      for (const text of region.buffer1) out.push({ type: "removed", text });
      for (const text of region.buffer2) out.push({ type: "added", text });
    }
  }
  return out;
}

/** Snapshot entries carry the same fields; lets callers render a folded state row with one shape. */
export function versionFromSnapshotEntry(path: string, e: SnapshotEntry): FileVersion {
  return toVersion({ rev: e.rev, by: e.by, at: e.at ?? "", files: {} }, path, e as FileEntry | Tombstone);
}
