/** Protocol schemas — see design doc §1.2 */

export const SCHEMA_VERSION = 1;

/** Live file entry carried in a delta. `mtime` is author-time metadata, never a change signal (§1.6). */
export interface FileEntry {
  /** "md5:<hex>" of content — the ONLY change signal */
  hash: string;
  /** S3 version of the object this entry describes (merge base lookup, §1.5) */
  s3VersionId?: string;
  size: number;
  /** ISO-8601 edit time on the source device */
  mtime: string;
}

export interface Tombstone {
  deleted: true;
  /** Set when this delete is the OLD side of a rename (delete(old)+add(new)): the note's content
   * moved to this path. Lets a receiver that still holds a divergent `old` fold its edit onto `new`
   * and drop `old`, instead of resurrecting it (the cross-device rename-duplication fix).
   * Optional and additive: a client that doesn't understand it treats the entry as a plain tombstone
   * and falls back to the freshest-wins delete-vs-edit tiebreak. */
  renamedTo?: string;
}

export type DeltaEntry = FileEntry | Tombstone;

/** One append-only journal object: deltas/<pad10(rev)>.json.gz */
export interface Delta {
  rev: number;
  by: string;
  at: string;
  files: Record<string, DeltaEntry>;
}

/** A delta entry carried into folded/derived state: the raw entry plus the revision and writer that
 * authored it, and `at` — the ISO time of the delta it came from. `at` is the DELETE time for a
 * tombstone (the delete-vs-edit freshness tiebreak, §1.5) and the publish time for a live entry.
 * Optional: entries folded into a snapshot written before `at` existed simply lack it, and readers
 * fall back to the historical behavior. */
export type SnapshotEntry = DeltaEntry & { rev: number; by: string; at?: string };

/** snapshot.json.gz — folded state of all deltas up to `revision` */
export interface Snapshot {
  schemaVersion: number;
  revision: number;
  updatedAt: string;
  files: Record<string, SnapshotEntry>;
}

export function isTombstone(e: DeltaEntry | SnapshotEntry): boolean {
  return (e as Tombstone).deleted === true;
}

export function emptySnapshot(): Snapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    files: {},
  };
}

export function pad10(rev: number): string {
  return String(rev).padStart(10, "0");
}

export function parseDelta(value: unknown): Delta {
  const d = value as Delta;
  if (
    typeof d !== "object" || d === null ||
    typeof d.rev !== "number" || typeof d.by !== "string" ||
    typeof d.files !== "object" || d.files === null
  ) {
    throw new Error("parseDelta: malformed delta object");
  }
  return d;
}
