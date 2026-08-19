import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { CycleAbandonedError, SyncEngine, SyncState } from "../src/engine";

/**
 * Regressions for the 2026-08-19 data loss: a cycle that publishes bytes reconciled against a
 * baseline that has since moved. Two independent defenses are covered here — push() revalidating the
 * baseline before it writes, and onLostRace resolving (rather than discarding) a winner delta that
 * touches a path the push is already carrying — plus the stall watchdog that stops a wedged cycle
 * from holding the single-flight lock indefinitely.
 */

/** In-memory storage on the warm delta path (head → null, so no snapshot). Versions are addressable
 * independently of the live object, which is what lets a test prove the engine resolved against the
 * bytes a delta NAMES rather than whatever happens to be live at the key. */
class MemStorage {
  blobs = new Map<string, Uint8Array>();
  versioned = new Map<string, Uint8Array>();
  readonly puts: string[] = [];
  private counter = 0;
  /** Fires after each successful put, before it returns — the hook a test uses to make remote move
   * at an exact point in the cycle. */
  onPut: ((key: string) => void) | null = null;
  /** Fires before each list(); returning nothing is fine. Lets a test make remote advance between
   * the cycle's first pull and its revalidation pull. */
  onList: ((prefix: string, call: number) => void) | null = null;
  listCalls = 0;

  seed(key: string, bytes: Uint8Array, versionId?: string): void {
    this.blobs.set(key, bytes);
    if (versionId) this.versioned.set(`${key} ${versionId}`, bytes);
  }
  /** Seed bytes reachable ONLY by versionId — the live object keeps whatever it had. */
  seedVersion(key: string, bytes: Uint8Array, versionId: string): void {
    this.versioned.set(`${key} ${versionId}`, bytes);
  }
  seedDelta(delta: Delta): void {
    this.blobs.set(deltaKey(delta.rev), encodeJsonGz(delta));
  }
  /** Deltas this storage holds, ascending — i.e. what the fleet would actually see. */
  deltas(): Delta[] {
    return [...this.blobs.keys()]
      .filter((k) => k.startsWith("deltas/"))
      .sort()
      .map((k) => parseDelta(decodeJsonGz(this.blobs.get(k)!)));
  }

  get = async (key: string, opts?: { versionId?: string }) => {
    if (opts?.versionId) {
      const b = this.versioned.get(`${key} ${opts.versionId}`);
      return b ? { body: b, versionId: opts.versionId } : null;
    }
    const b = this.blobs.get(key);
    return b ? { body: b, versionId: `cur:${key}`, etag: "e" } : null;
  };
  head = async () => null;
  put = async (key: string, body: Uint8Array, opts?: { ifNoneMatch?: boolean }) => {
    if (opts?.ifNoneMatch && this.blobs.has(key)) throw new PreconditionFailedError(key);
    this.puts.push(key);
    this.blobs.set(key, body);
    const versionId = `v${++this.counter}`;
    this.versioned.set(`${key} ${versionId}`, body);
    this.onPut?.(key);
    return { etag: "e", versionId };
  };
  list = async (prefix: string, startAfter?: string) => {
    this.listCalls += 1;
    this.onList?.(prefix, this.listCalls);
    return [...this.blobs.keys()]
      .filter((k) => k.startsWith(prefix) && (!startAfter || k > startAfter))
      .sort()
      .map((key) => ({ key, lastModified: new Date() }));
  };
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
      list: async (dir: string) =>
        dir === ".obsidian"
          ? { files: [...disk.keys()].filter(isConfig), folders: [] }
          : { files: [], folders: [] },
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

function makeEngine(
  storage: MemStorage,
  state: SyncState,
  disk: Map<string, Uint8Array>,
  mtimes: Map<string, number>,
  logs: string[] = [],
) {
  return new SyncEngine(makeVault(disk, mtimes), storage as unknown as StorageAdapter, state, {
    deviceId: "dev-test",
    selfDir: ".obsidian/plugins/vault-s3-sync",
    excludedFolders: [],
    concurrency: 4,
    maxDownloadBytes: 0,
    verbose: false,
    log: (level, msg) => void logs.push(`${level} ${msg}`),
    onStateChanged: async () => {},
  });
}

const iso = (s: string) => new Date(s).toISOString();
/** The entry the fleet ends up with for `path`, folding the journal in order. */
function publishedHash(storage: MemStorage, path: string): string | undefined {
  let hash: string | undefined;
  for (const d of storage.deltas()) {
    const e = d.files[path];
    if (e && !("deleted" in e)) hash = e.hash;
  }
  return hash;
}

describe("SyncEngine — stale write baselines", () => {
  let storage: MemStorage;
  let disk: Map<string, Uint8Array>;
  let mtimes: Map<string, number>;

  const base = "a\nb\nc\nd\ne\n";
  const local = "X\nb\nc\nd\ne\n"; // our edit, to the first line
  const winner = "a\nb\nc\nd\nY\n"; // their edit, to the last — far apart, so a clean 3-way merge
  const merged = "X\nb\nc\nd\nY\n";

  /** Vault + state where note.md is tracked at `base`, edited locally to `local`, and dirty. */
  function seedDivergedNote(): SyncEngine {
    storage.seed("files/note.md", encodeText(base), "vbase");
    disk.set("note.md", encodeText(local));
    mtimes.set("note.md", Date.parse(iso("2026-06-02")));
    const state: SyncState = {
      lastSyncedRev: 0,
      files: {
        "note.md": {
          hash: contentHash(encodeText(base)),
          s3VersionId: "vbase",
          mtime: iso("2026-05-01"),
        },
      },
    };
    const engine = makeEngine(storage, state, disk, mtimes);
    engine.markDirty("note.md");
    return engine;
  }

  const winnerDelta = (rev: number): Delta => ({
    rev,
    by: "other-device",
    at: iso("2026-06-01"),
    files: {
      "note.md": {
        hash: contentHash(encodeText(winner)),
        s3VersionId: "vwinner",
        size: winner.length,
        mtime: iso("2026-06-01"),
      },
    },
  });

  beforeEach(() => {
    storage = new MemStorage();
    disk = new Map();
    mtimes = new Map();
  });

  it("union-merges a lost CAS race instead of publishing our bytes over the winner", async () => {
    const engine = seedDivergedNote();

    // The winner lands in the CAS window: after our pull saw an empty journal and after our content
    // PUT, but before our delta claims rev 1. Its bytes live ONLY under a versionId — the live object
    // is our own upload by then, so an engine resolving against "latest" would compare our content
    // with itself, find no conflict, and publish the revert.
    storage.onPut = (key) => {
      if (key !== "files/note.md") return;
      storage.onPut = null;
      storage.seedVersion("files/note.md", encodeText(winner), "vwinner");
      storage.seedDelta(winnerDelta(1));
    };

    await engine.sync();

    expect(decodeText(disk.get("note.md")!)).toBe(merged);
    // What the rest of the fleet converges on must be the merge — never our pre-race bytes.
    expect(publishedHash(storage, "note.md")).toBe(contentHash(encodeText(merged)));
    expect(publishedHash(storage, "note.md")).not.toBe(contentHash(encodeText(local)));
  });

  it("still applies a lost race's entries for paths the push is NOT carrying", async () => {
    const engine = seedDivergedNote();
    const other = "other note\n";

    storage.onPut = (key) => {
      if (key !== "files/note.md") return;
      storage.onPut = null;
      storage.seed("files/other.md", encodeText(other), "vother");
      storage.seedDelta({
        rev: 1,
        by: "other-device",
        at: iso("2026-06-01"),
        files: {
          "other.md": {
            hash: contentHash(encodeText(other)),
            s3VersionId: "vother",
            size: other.length,
            mtime: iso("2026-06-01"),
          },
        },
      });
    };

    await engine.sync();

    // Non-colliding winner entries are folded in as an ordinary pull would.
    expect(decodeText(disk.get("other.md")!)).toBe(other);
    // …and our own uncontested edit still goes up.
    expect(publishedHash(storage, "note.md")).toBe(contentHash(encodeText(local)));
  });

  it("revalidates the baseline before pushing, so a cycle that ran long can't revert remote", async () => {
    const engine = seedDivergedNote();

    // Remote advances AFTER the cycle's first pull has already read the journal — the shape of a long
    // cycle (big changeset, slow link, a device suspended mid-pull). Seeding on the second LIST is
    // what isolates this defense: with no revalidation there is no second LIST at all, the winner is
    // never seen, and push() claims rev 1 uncontested with our stale bytes — no CAS collision to fall
    // back on. So this test fails unless the baseline is genuinely re-read before writing.
    storage.onList = (prefix, call) => {
      if (prefix !== "deltas/" || call !== 2) return;
      storage.seed("files/note.md", encodeText(winner), "vwinner");
      storage.seedDelta(winnerDelta(1));
    };

    await engine.sync();

    expect(decodeText(disk.get("note.md")!)).toBe(merged);
    expect(publishedHash(storage, "note.md")).toBe(contentHash(encodeText(merged)));
  });

  it("skips the revalidation LIST when there is nothing to push (the idle-poll case)", async () => {
    // An idle poll must stay a single LIST — the revalidation is gated on having a payload, so
    // routine polling doesn't double its request volume.
    const state: SyncState = { lastSyncedRev: 0, files: {} };
    const engine = makeEngine(storage, state, disk, mtimes);
    await engine.sync();
    expect(storage.listCalls).toBe(1);
  });
});

describe("SyncEngine — stalled cycles", () => {
  /** Storage that can pin a cycle mid-flight: `gateList` blocks the deltas/ LIST (the first async op
   * of a cycle — nothing has completed yet, so the progress clock is frozen), `gateGet` blocks each
   * file download (releasing one models a slow-but-advancing transfer). */
  class GatedStorage extends MemStorage {
    gateList = false;
    gateGet = false;
    private gates: Array<() => void> = [];
    get pending(): number {
      return this.gates.length;
    }
    releaseOne(): void {
      this.gates.shift()?.();
    }
    private block(): Promise<void> {
      return new Promise<void>((res) => this.gates.push(res));
    }
    override list = async (prefix: string, startAfter?: string) => {
      this.listCalls += 1;
      this.onList?.(prefix, this.listCalls);
      if (this.gateList && prefix === "deltas/") await this.block();
      return [...this.blobs.keys()]
        .filter((k) => k.startsWith(prefix) && (!startAfter || k > startAfter))
        .sort()
        .map((key) => ({ key, lastModified: new Date() }));
    };
    override get = async (key: string, opts?: { versionId?: string }) => {
      if (this.gateGet && key.startsWith("files/")) await this.block();
      if (opts?.versionId) {
        const v = this.versioned.get(`${key} ${opts.versionId}`);
        return v ? { body: v, versionId: opts.versionId } : null;
      }
      const b = this.blobs.get(key);
      return b ? { body: b, versionId: `cur:${key}`, etag: "e" } : null;
    };
  }

  let storage: GatedStorage;
  let disk: Map<string, Uint8Array>;
  let mtimes: Map<string, number>;
  let logs: string[];

  /** Let released promises run. Fake timers are active, so drain microtasks explicitly. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 100; i++) await Promise.resolve();
  }

  beforeEach(() => {
    storage = new GatedStorage();
    disk = new Map();
    mtimes = new Map();
    logs = [];
    vi.useFakeTimers();
  });

  function dirtyEngine(): SyncEngine {
    disk.set("note.md", encodeText("local\n"));
    mtimes.set("note.md", 1);
    const engine = makeEngine(
      storage as unknown as MemStorage,
      { lastSyncedRev: 0, files: {} },
      disk,
      mtimes,
      logs,
    );
    engine.markDirty("note.md");
    return engine;
  }

  it("does NOT abandon a long cycle that is still making progress", async () => {
    // A pull of several files, each download released 90 s apart: nine minutes of wall clock — far
    // past the stall threshold — with no single gap reaching it. This is the "large changeset over a
    // slow link" case, and abandoning it would be a regression, not a fix.
    const nFiles = 6;
    const files: Record<string, { hash: string; s3VersionId: string; size: number; mtime: string }> = {};
    for (let i = 0; i < nFiles; i++) {
      const body = encodeText(`remote ${i}\n`);
      storage.seed(`files/n${i}.md`, body, `v${i}`);
      files[`n${i}.md`] = {
        hash: contentHash(body),
        s3VersionId: `v${i}`,
        size: body.byteLength,
        mtime: iso("2026-06-01"),
      };
    }
    storage.seedDelta({ rev: 1, by: "other-device", at: iso("2026-06-01"), files });

    const engine = makeEngine(
      storage as unknown as MemStorage,
      { lastSyncedRev: 0, files: {} },
      disk,
      mtimes,
      logs,
    );
    storage.gateGet = true;
    const p = engine.sync({ label: "poll" });
    const settled = p.then(() => "ok" as const).catch((e) => e as Error);
    await settle();

    for (let i = 0; i < nFiles; i++) {
      await vi.advanceTimersByTimeAsync(90_000); // under the 120 s threshold…
      await settle();
      storage.releaseOne(); // …and each release completes an op, ticking the progress clock
      await settle();
    }

    expect(logs.some((l) => l.includes("abandoned"))).toBe(false);
    expect(await settled).toBe("ok");
    expect(disk.get("n0.md")).toBeDefined(); // the long cycle ran to completion
  });

  it("abandons a cycle that makes no progress, frees the lock, and fences it out of writing", async () => {
    storage.gateList = true;
    const engine = dirtyEngine();
    const stalled = engine.sync({ label: "poll" });
    const rejected = stalled.catch((e) => e as Error);
    await settle();
    expect(storage.pending).toBe(1); // pinned in pull, nothing completed

    await vi.advanceTimersByTimeAsync(3 * 60_000); // past STALL_TIMEOUT_MS with zero progress
    await settle();

    expect(await rejected).toBeInstanceOf(CycleAbandonedError);
    expect(logs.some((l) => l.includes("abandoned"))).toBe(true);

    // The lock is free: a new cycle actually starts reconciling rather than queueing behind the stall.
    const before = storage.listCalls;
    const next = engine.sync({ label: "manual sync" });
    const nextSettled = next.catch((e) => e as Error);
    await settle();
    expect(storage.listCalls).toBe(before + 1);

    // The orphan finally comes back — and must not publish anything, however far it had got. Before
    // the fence this is precisely where a stalled cycle wrote its hours-old payload.
    storage.releaseOne();
    await settle();
    expect(storage.puts.filter((k) => k.startsWith("deltas/"))).toHaveLength(0);

    storage.gateList = false;
    storage.releaseOne();
    await settle();
    await nextSettled;
  });
});
