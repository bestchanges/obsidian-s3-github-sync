import { beforeEach, describe, expect, it } from "vitest";
import {
  contentHash,
  decodeJsonGz,
  decodeText,
  Delta,
  deltaKey,
  encodeJsonGz,
  encodeText,
  parseDelta,
  PreconditionFailedError,
  StorageAdapter,
} from "@vault-sync/core";
import { SyncEngine, SyncState } from "../src/engine";

/**
 * Chunked, resumable cycles (§4.3). A bulk catch-up used to be one indivisible unit: the cursor moved
 * only at the very end, so any interruption threw the whole thing away, and a queued "Sync now"
 * waited behind all of it. These cover the boundaries that make it resumable — and, just as
 * importantly, that an ordinary small cycle is completely unaffected.
 */

class MemStorage {
  blobs = new Map<string, Uint8Array>();
  versioned = new Map<string, Uint8Array>();
  readonly puts: string[] = [];
  private counter = 0;
  /** Fires before each get of a file, so a test can act partway through a chunk. */
  onGet: ((key: string) => void) | null = null;
  /** Throw from here to simulate a failure partway through a push. */
  onPut: ((key: string) => void) | null = null;

  seed(key: string, bytes: Uint8Array, versionId?: string): void {
    this.blobs.set(key, bytes);
    if (versionId) this.versioned.set(`${key} ${versionId}`, bytes);
  }
  seedDelta(delta: Delta): void {
    this.blobs.set(deltaKey(delta.rev), encodeJsonGz(delta));
  }
  deltas(): Delta[] {
    return [...this.blobs.keys()]
      .filter((k) => k.startsWith("deltas/"))
      .sort()
      .map((k) => parseDelta(decodeJsonGz(this.blobs.get(k)!)));
  }
  /** Deltas this device authored, in order — one per published batch. */
  ownDeltas(deviceId = "dev-test"): Delta[] {
    return this.deltas().filter((d) => d.by === deviceId);
  }

  get = async (key: string, opts?: { versionId?: string }) => {
    if (key.startsWith("files/")) this.onGet?.(key);
    if (opts?.versionId) {
      const v = this.versioned.get(`${key} ${opts.versionId}`);
      return v ? { body: v, versionId: opts.versionId } : null;
    }
    const b = this.blobs.get(key);
    return b ? { body: b, versionId: `cur:${key}`, etag: "e" } : null;
  };
  head = async () => null; // no snapshot → warm delta path
  put = async (key: string, body: Uint8Array, opts?: { ifNoneMatch?: boolean }) => {
    if (opts?.ifNoneMatch && this.blobs.has(key)) throw new PreconditionFailedError(key);
    this.onPut?.(key);
    this.puts.push(key);
    this.blobs.set(key, body);
    const versionId = `v${++this.counter}`;
    this.versioned.set(`${key} ${versionId}`, body);
    return { etag: "e", versionId };
  };
  list = async (prefix: string, startAfter?: string) =>
    [...this.blobs.keys()]
      .filter((k) => k.startsWith(prefix) && (!startAfter || k > startAfter))
      .sort()
      .map((key) => ({ key, lastModified: new Date() }));
  delete = async (key: string) => void this.blobs.delete(key);
}

function makeVault(disk: Map<string, Uint8Array>, mtimes: Map<string, number>): any {
  const isConfig = (p: string) => p.startsWith(".obsidian/");
  return {
    configDir: ".obsidian",
    getFiles: () =>
      [...disk.keys()]
        .filter((p) => !isConfig(p))
        .map((p) => ({ path: p, stat: { mtime: mtimes.get(p) ?? 1 } })),
    adapter: {
      list: async () => ({ files: [], folders: [] }),
      stat: async (p: string) => (disk.has(p) ? { type: "file", mtime: mtimes.get(p) ?? 1 } : null),
      readBinary: async (p: string) => {
        const b = disk.get(p) ?? new Uint8Array(0);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
      exists: async (p: string) => disk.has(p),
      writeBinary: async (p: string, data: ArrayBuffer, opts?: { mtime?: number }) => {
        disk.set(p, new Uint8Array(data));
        if (opts?.mtime) mtimes.set(p, opts.mtime);
      },
      remove: async (p: string) => {
        disk.delete(p);
        mtimes.delete(p);
      },
      mkdir: async () => {},
    },
  };
}

const iso = (s: string) => new Date(s).toISOString();

describe("SyncEngine — chunked, resumable cycles", () => {
  let storage: MemStorage;
  let disk: Map<string, Uint8Array>;
  let mtimes: Map<string, number>;
  /** lastSyncedRev at each persist — the cursor's committed history. */
  let commits: number[];
  let logs: string[];

  function makeEngine(state: SyncState, chunkFiles: number): SyncEngine {
    return new SyncEngine(makeVault(disk, mtimes), storage as unknown as StorageAdapter, state, {
      deviceId: "dev-test",
      selfDir: ".obsidian/plugins/vault-s3-sync",
      excludedFolders: [],
      concurrency: 4,
      chunkFiles,
      maxDownloadBytes: 0,
      verbose: false,
      log: (_l, m) => void logs.push(m),
      onStateChanged: async (s) => void commits.push(s.lastSyncedRev),
    });
  }

  /** `revs` revisions of `perRev` files each, authored elsewhere. Returns every path seeded. */
  function seedRemote(revs: number, perRev: number): string[] {
    const all: string[] = [];
    for (let r = 1; r <= revs; r++) {
      const files: Record<string, { hash: string; s3VersionId: string; size: number; mtime: string }> = {};
      for (let i = 0; i < perRev; i++) {
        const p = `r${r}-n${i}.md`;
        const body = encodeText(`remote ${r}/${i}\n`);
        storage.seed(`files/${p}`, body, `v-${p}`);
        files[p] = {
          hash: contentHash(body),
          s3VersionId: `v-${p}`,
          size: body.byteLength,
          mtime: iso("2026-06-01"),
        };
        all.push(p);
      }
      storage.seedDelta({ rev: r, by: "other-device", at: iso("2026-06-01"), files });
    }
    return all;
  }

  beforeEach(() => {
    storage = new MemStorage();
    disk = new Map();
    mtimes = new Map();
    commits = [];
    logs = [];
  });

  it("commits the cursor at each chunk boundary instead of only at the end", async () => {
    const paths = seedRemote(6, 2); // 6 revisions × 2 files
    const state: SyncState = { lastSyncedRev: 0, files: {} };
    await makeEngine(state, 4).sync(); // 4-file chunks → 2 revisions per chunk

    // Progress was committed along the way, not just once at the end.
    expect(commits.length).toBeGreaterThan(1);
    // Every committed cursor is a real revision boundary, and they only ever move forward.
    expect(commits).toEqual([...commits].sort((a, b) => a - b));
    for (const c of commits) expect(Number.isInteger(c)).toBe(true);
    expect(state.lastSyncedRev).toBe(6);
    for (const p of paths) expect(disk.has(p)).toBe(true);
  });

  it("never cuts a chunk mid-revision, so a committed cursor is always fully applied", async () => {
    // Revisions of 3 files each with a 4-file cap: a second revision can never fit, so each chunk is
    // exactly one revision and the committed cursors must be exactly the revision boundaries.
    seedRemote(4, 3);
    const state: SyncState = { lastSyncedRev: 0, files: {} };
    await makeEngine(state, 4).sync();

    // 1, 2, 3 from the chunk boundaries; 4 from the cycle's own final persist. A cursor landing
    // anywhere else would mean a revision was committed only half-applied.
    expect(commits).toEqual([1, 2, 3, 4]);
    // At each commit, every file of every revision up to that cursor is on disk.
    for (const cursor of commits) {
      for (let r = 1; r <= cursor; r++) {
        for (let i = 0; i < 3; i++) expect(disk.has(`r${r}-n${i}.md`)).toBe(true);
      }
    }
    expect(state.lastSyncedRev).toBe(4);
  });

  it("resumes an interrupted catch-up from the committed cursor rather than starting over", async () => {
    seedRemote(6, 2);
    const state: SyncState = { lastSyncedRev: 0, files: {} };

    // Kill the catch-up partway: throw once a couple of chunks are in.
    let gets = 0;
    storage.onGet = () => {
      if (++gets === 7) throw new Error("connection lost");
    };
    await expect(makeEngine(state, 4).sync()).rejects.toThrow("connection lost");

    const survived = state.lastSyncedRev;
    expect(survived).toBeGreaterThan(0); // progress was kept, not discarded
    expect(survived).toBeLessThan(6);

    // A fresh cycle picks up where it left off — it must not re-download what is already applied.
    storage.onGet = null;
    const fetched: string[] = [];
    storage.onGet = (k) => void fetched.push(k);
    await makeEngine(state, 4).sync();

    expect(state.lastSyncedRev).toBe(6);
    for (let r = 1; r <= survived; r++) {
      for (let i = 0; i < 2; i++) {
        expect(fetched).not.toContain(`files/r${r}-n${i}.md`); // already applied → not re-fetched
      }
    }
  });

  it("hands the lock to a queued request at a chunk boundary, then finishes the catch-up itself", async () => {
    seedRemote(8, 2);
    const state: SyncState = { lastSyncedRev: 0, files: {} };
    const engine = makeEngine(state, 4);

    // A user action arrives while the catch-up is running.
    let queued: Promise<void> | null = null;
    let gets = 0;
    storage.onGet = () => {
      if (++gets === 3 && !queued) queued = engine.sync({ label: "manual sync", force: true });
    };

    await engine.sync({ label: "startup" });
    await queued; // served without waiting out the whole catch-up

    // The catch-up really did stop early to let it through, rather than running to the end first.
    const paused = logs.filter((l) => l.includes("catch-up paused"));
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatch(/revisions still to apply/);

    // …and it still ran to completion on its own, without waiting for the next poll.
    expect(state.lastSyncedRev).toBe(8);
    for (let r = 1; r <= 8; r++) {
      for (let i = 0; i < 2; i++) expect(disk.has(`r${r}-n${i}.md`)).toBe(true);
    }
  });

  it("splits a bulk push into one delta per batch, and keeps published batches on a later failure", async () => {
    const state: SyncState = { lastSyncedRev: 0, files: {} };
    const engine = makeEngine(state, 2);
    for (let i = 0; i < 6; i++) {
      const p = `local${i}.md`;
      disk.set(p, encodeText(`local ${i}\n`));
      mtimes.set(p, 1);
      engine.markDirty(p);
    }

    // Fail during the third batch's upload.
    let uploads = 0;
    storage.onPut = (key) => {
      if (key.startsWith("files/") && ++uploads === 5) throw new Error("upload failed");
    };
    await expect(engine.sync()).rejects.toThrow("upload failed");

    // The first two batches are published and recorded — not rolled back, not redone.
    expect(storage.ownDeltas()).toHaveLength(2);
    expect(Object.keys(state.files)).toHaveLength(4);

    // Retrying publishes only what is left.
    storage.onPut = null;
    await engine.sync();
    expect(Object.keys(state.files)).toHaveLength(6);
    for (let i = 0; i < 6; i++) expect(storage.blobs.has(`files/local${i}.md`)).toBe(true);
  });

  it("leaves an ordinary small cycle alone — still one delta, one commit", async () => {
    const state: SyncState = { lastSyncedRev: 0, files: {} };
    const engine = makeEngine(state, 500); // production default
    disk.set("note.md", encodeText("hello\n"));
    mtimes.set("note.md", 1);
    engine.markDirty("note.md");

    await engine.sync();

    expect(storage.ownDeltas()).toHaveLength(1);
    expect(commits).toHaveLength(1);
    expect(decodeText(storage.blobs.get("files/note.md")!)).toBe("hello\n");
  });
});
