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
import { Delta, FileEntry, SnapshotEntry, Tombstone, isTombstone, parseDelta } from "./schemas";
import { GetResult, StorageAdapter } from "./s3";
import { canonicalKey } from "./casing";
import { DELTA_PREFIX, revFromKey } from "./journal";
import { decodeJsonGz } from "./codec";
import { mapPool } from "./util";

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
  /** True when older entries may exist but aren't in `versions` — pruned journal, or the scan cap
   * below stopped the walk early. Either way the list shown is not the whole trail. */
  truncated: boolean;
  /** How many deltas were actually fetched, and how many exist. Surfaced so a caller can say
   * "searched the last N revisions" instead of implying it read everything. */
  scanned: number;
  available: number;
  /** Deltas that could not be read (transient GET failures). The walk skips them rather than
   * failing the whole query — see the note on `readFileHistory`. */
  unreadable: number;
}

export interface ReadHistoryOptions {
  concurrency?: number;
  /** Stop once this many versions of the path have been found. */
  limit?: number;
  /** Never fetch more than this many deltas, however few versions were found. */
  maxScan?: number;
  /** Deltas per round-trip batch; also the granularity of `onProgress`. */
  chunk?: number;
  /** Stop after this many consecutive batches yield no further versions (once at least one has
   * been found). A file's revisions cluster in time, so once the trail goes quiet it has almost
   * always ended; the alternative is scanning to `maxScan` for every ordinary note. */
  quietChunks?: number;
  onProgress?: (scanned: number, available: number) => void;
}

/** Plenty for a UI list, and reached within one or two chunks for any recently-touched note. */
const DEFAULT_LIMIT = 100;
/** Hard ceiling on work per query. At ~350 B per delta this is a few hundred KB, seconds on mobile. */
const DEFAULT_MAX_SCAN = 1_500;
const DEFAULT_CHUNK = 200;
const DEFAULT_QUIET_CHUNKS = 2;

/**
 * Read the journal and extract one path's history, **newest first, in bounded batches**.
 *
 * The naive version of this — fetch every surviving delta, then filter — is what made the feature
 * unusable in the field: a vault with 3 588 deltas meant 3 588 GETs on every open (~57 s even on a
 * desktop at concurrency 16, minutes on a phone), and because the fetch was all-or-nothing a single
 * transient failure among those thousands threw the whole query away. Across that many requests on
 * mobile, at least one failure is close to certain — so history reliably showed nothing.
 *
 * Instead: LIST the keys (cheap — the journal is one object per revision, so keys sort by rev), then
 * walk backwards from the newest in chunks, stopping as soon as `limit` versions are found or
 * `maxScan` deltas have been read. A note edited this week resolves in the first chunk. Individual
 * unreadable deltas are counted and skipped, never fatal: a hole in the middle of the journal costs
 * one revision of history, not the feature.
 *
 * Walking strictly newest→oldest also keeps rename-following correct (§2.9): the trail switches to
 * the old path only after the rename's own revision has been seen.
 */
export async function readFileHistory(
  storage: StorageAdapter,
  path: string,
  opts: number | ReadHistoryOptions = {},
): Promise<HistoryResult> {
  // Historic signature took a bare concurrency number.
  const o: ReadHistoryOptions = typeof opts === "number" ? { concurrency: opts } : opts;
  const concurrency = o.concurrency ?? 8;
  const limit = o.limit ?? DEFAULT_LIMIT;
  const maxScan = o.maxScan ?? DEFAULT_MAX_SCAN;
  const chunk = o.chunk ?? DEFAULT_CHUNK;
  const quietChunks = o.quietChunks ?? DEFAULT_QUIET_CHUNKS;

  const infos = await storage.list(DELTA_PREFIX);
  // S3 lists lexicographically and keys are zero-padded, so this is already revision order.
  const keys = infos.map((i) => i.key).sort();
  const available = keys.length;
  const oldestRevAvailable = available ? revFromKey(keys[0]) : 0;

  const deltas: Delta[] = [];
  let scanned = 0;
  let unreadable = 0;
  let versions: FileVersion[] = [];
  let quiet = 0;

  for (let end = available; end > 0 && scanned < maxScan && versions.length < limit; end -= chunk) {
    const batch = keys.slice(Math.max(0, end - chunk), end);
    const fetched = await mapPool(batch, concurrency, async (key) => {
      try {
        const obj = await storage.get(key);
        return obj ? parseDelta(decodeJsonGz(obj.body)) : null;
      } catch {
        return null; // counted below; one bad delta must not sink the query
      }
    });
    for (const d of fetched) {
      if (d) deltas.push(d);
      else unreadable++;
    }
    scanned += batch.length;
    // fileHistory is pure and sorts internally, so re-running it over the growing set is correct
    // (and cheap) — and it keeps rename-following consistent as older chunks arrive.
    const before = versions.length;
    versions = fileHistory(deltas, path);
    o.onProgress?.(scanned, available);
    // Trail went quiet: found something earlier, but this batch added nothing.
    quiet = versions.length > before ? 0 : versions.length > 0 ? quiet + 1 : 0;
    if (quiet >= quietChunks) break;
  }

  return {
    versions: versions.slice(0, limit),
    oldestRevAvailable,
    // Either the journal was pruned below rev 1, or we stopped before reading all of it.
    truncated: oldestRevAvailable > 1 || scanned < available || versions.length > limit,
    scanned,
    available,
    unreadable,
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
