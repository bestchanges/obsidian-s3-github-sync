import {
  Delta,
  Snapshot,
  SnapshotEntry,
  emptySnapshot,
  pad10,
  parseDelta,
  SCHEMA_VERSION,
} from "./schemas";
import { PreconditionFailedError, StorageAdapter } from "./s3";
import { decodeJsonGz, encodeJsonGz } from "./codec";
import { mapPool } from "./util";

export const SNAPSHOT_KEY = "snapshot.json.gz";
export const DELTA_PREFIX = "deltas/";
/** snapshot metadata key carrying its revision — lets clients detect "behind retention" via one HEAD */
export const META_REVISION = "revision";

export function deltaKey(rev: number): string {
  return `${DELTA_PREFIX}${pad10(rev)}.json.gz`;
}

export function revFromKey(key: string): number {
  return parseInt(key.slice(DELTA_PREFIX.length, DELTA_PREFIX.length + 10), 10);
}

export interface AppendResult {
  rev: number;
  delta: Delta;
}

/**
 * CAS append (§1.3): claim rev N via `If-None-Match: *`; on 412 someone else took it —
 * surface their delta via `onLostRace` (caller applies it / re-merges), then retry at N+1.
 * Revisions come out DENSE (every integer claimed), which read-side gap detection relies on.
 */
export async function appendDelta(
  storage: StorageAdapter,
  startRev: number,
  build: (rev: number) => Delta,
  onLostRace?: (winner: Delta) => void | Promise<void>,
  maxAttempts = 100,
): Promise<AppendResult> {
  let rev = startRev;
  for (let attempt = 0; attempt < maxAttempts; attempt++, rev++) {
    const delta = build(rev);
    try {
      await storage.put(deltaKey(rev), encodeJsonGz(delta), { ifNoneMatch: true });
      return { rev, delta };
    } catch (err) {
      if (!(err instanceof PreconditionFailedError)) throw err;
      const winner = await storage.get(deltaKey(rev));
      if (winner && onLostRace) await onLostRace(parseDelta(decodeJsonGz(winner.body)));
    }
  }
  throw new Error(`appendDelta: gave up after ${maxAttempts} CAS attempts (rev ${startRev}..${rev - 1})`);
}

/** LIST + fetch deltas with rev > sinceRev, ascending. One LIST answers "anything new?" (§1.4). */
export async function listDeltasSince(
  storage: StorageAdapter,
  sinceRev: number,
  concurrency = 8,
): Promise<Delta[]> {
  const infos = await storage.list(DELTA_PREFIX, deltaKey(sinceRev));
  const deltas = await mapPool(infos, concurrency, async (info) => {
    const obj = await storage.get(info.key);
    if (!obj) throw new Error(`delta vanished mid-read: ${info.key}`);
    return parseDelta(decodeJsonGz(obj.body));
  });
  return deltas.sort((a, b) => a.rev - b.rev);
}

/** True when deltas don't connect to sinceRev — pruned journal → snapshot cold path (§1.4). */
export function hasGap(sinceRev: number, deltas: Delta[]): boolean {
  return deltas.length > 0 && deltas[0].rev !== sinceRev + 1;
}

/** Fold deltas into a snapshot (last delta per path wins). Pure. */
export function foldDeltas(snapshot: Snapshot | null, deltas: Delta[]): Snapshot {
  const base = snapshot ?? emptySnapshot();
  const files: Record<string, SnapshotEntry> = { ...base.files };
  let revision = base.revision;
  for (const d of [...deltas].sort((a, b) => a.rev - b.rev)) {
    if (d.rev <= revision) continue; // already folded
    for (const [path, entry] of Object.entries(d.files)) {
      files[path] = { ...entry, rev: d.rev, by: d.by, at: d.at };
    }
    revision = d.rev;
  }
  return { schemaVersion: SCHEMA_VERSION, revision, updatedAt: new Date().toISOString(), files };
}

/** Last-wins changed entries after sinceRev, excluding a writer (echo suppression, §1.7). */
export function changedEntries(
  deltas: Delta[],
  sinceRev: number,
  excludeBy?: string,
): Map<string, SnapshotEntry> {
  const out = new Map<string, SnapshotEntry>();
  for (const d of [...deltas].sort((a, b) => a.rev - b.rev)) {
    if (d.rev <= sinceRev) continue;
    for (const [path, entry] of Object.entries(d.files)) {
      out.set(path, { ...entry, rev: d.rev, by: d.by, at: d.at });
    }
  }
  if (excludeBy) {
    for (const [path, entry] of out) {
      if (entry.by === excludeBy) out.delete(path);
    }
  }
  return out;
}

export async function readSnapshot(
  storage: StorageAdapter,
): Promise<{ snapshot: Snapshot; etag?: string } | null> {
  const obj = await storage.get(SNAPSHOT_KEY);
  if (!obj) return null;
  return { snapshot: decodeJsonGz<Snapshot>(obj.body), etag: obj.etag };
}

/** Full remote state = snapshot ⊕ newer deltas. Used by git-sync every run; plugin cold path only. */
export async function loadRemoteState(
  storage: StorageAdapter,
  concurrency = 8,
): Promise<{ state: Snapshot; snapshotEtag?: string }> {
  const snap = await readSnapshot(storage);
  const deltas = await listDeltasSince(storage, snap?.snapshot.revision ?? 0, concurrency);
  return { state: foldDeltas(snap?.snapshot ?? null, deltas), snapshotEtag: snap?.etag };
}

/** CAS snapshot write. Only git-sync calls this (single compactor, §3.3). */
export async function writeSnapshot(
  storage: StorageAdapter,
  snapshot: Snapshot,
  expectedEtag?: string,
): Promise<void> {
  await storage.put(SNAPSHOT_KEY, encodeJsonGz(snapshot), {
    ...(expectedEtag ? { ifMatch: expectedEtag } : { ifNoneMatch: true }),
    metadata: { [META_REVISION]: String(snapshot.revision) },
  });
}

/** Prune folded deltas older than the retention window (30 days, §1.3/§5-decided). */
export async function pruneDeltas(
  storage: StorageAdapter,
  foldedUpToRev: number,
  olderThan: Date,
  concurrency = 8,
): Promise<number> {
  const infos = await storage.list(DELTA_PREFIX);
  const doomed = infos.filter(
    (i) =>
      revFromKey(i.key) <= foldedUpToRev &&
      i.lastModified !== undefined &&
      i.lastModified < olderThan,
  );
  await mapPool(doomed, concurrency, (i) => storage.delete(i.key));
  return doomed.length;
}
