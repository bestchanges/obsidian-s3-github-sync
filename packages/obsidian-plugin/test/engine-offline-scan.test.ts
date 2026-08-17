import { beforeEach, describe, expect, it } from "vitest";
import type { StorageAdapter } from "@vault-sync/core";
import { contentHash } from "@vault-sync/core";
import { SyncEngine, SyncState } from "../src/engine";

/** Storage whose list() (the first async op a reconcile cycle reaches, in pull) blocks until the test
 * releases it — the same gate the serialization test uses. It lets us pin a reconcile cycle mid-flight
 * and prove the offline WALK runs while that lock is held. Everything else no-ops. */
class GatedStorage implements StorageAdapter {
  listCalls = 0;
  putCalls: string[] = [];
  private gates: Array<() => void> = [];

  get pending(): number {
    return this.gates.length;
  }
  releaseOne(): void {
    this.gates.shift()?.();
  }

  list = async (): Promise<never[]> => {
    this.listCalls += 1;
    await new Promise<void>((res) => this.gates.push(res));
    return [];
  };
  head = async (): Promise<null> => null;
  get = async (): Promise<null> => null;
  put = async (key: string): Promise<{ etag: string; versionId: string }> => {
    this.putCalls.push(key);
    return { etag: "e", versionId: "v" };
  };
  delete = async (): Promise<void> => {};
}

/** Vault backed by an on-disk map. Records readBinary calls so a test can prove the walk actually
 * hashed a file (i.e. ran) even while a cycle held the reconcile lock. `existsFor` overrides the
 * exists() answer independently of `disk`, to simulate a file a concurrent pull wrote after the walk
 * had already passed it (the race the finalize re-verify guards against). */
function makeVault(
  disk: Map<string, Uint8Array>,
  opts: { readLog?: string[]; existsFor?: (p: string) => boolean; mtimeMs?: number } = {},
): any {
  const mtimeMs = opts.mtimeMs ?? 1;
  return {
    configDir: ".obsidian",
    getFiles: () =>
      [...disk.keys()]
        .filter((p) => !p.startsWith(".obsidian/"))
        .map((p) => ({ path: p, stat: { mtime: mtimeMs } })),
    adapter: {
      list: async () => ({ files: [], folders: [] }),
      stat: async (p: string) => (disk.has(p) ? { type: "file", mtime: mtimeMs } : null),
      readBinary: async (p: string) => {
        opts.readLog?.push(p);
        const b = disk.get(p) ?? new Uint8Array(0);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
      exists: async (p: string) => (opts.existsFor ? opts.existsFor(p) : disk.has(p)),
      writeBinary: async (p: string, data: ArrayBuffer) => void disk.set(p, new Uint8Array(data)),
      remove: async (p: string) => void disk.delete(p),
      mkdir: async () => {},
    },
  };
}

function makeEngine(vault: any, storage: GatedStorage, state: SyncState) {
  const persisted: SyncState[] = [];
  const engine = new SyncEngine(vault, storage as unknown as StorageAdapter, state, {
    deviceId: "dev-test",
    selfDir: ".obsidian/plugins/vault-s3-sync",
    excludedFolders: [],
    concurrency: 4,
    maxDownloadBytes: 0,
    verbose: false,
    log: () => {},
    onStateChanged: async (s) => void persisted.push(s),
  });
  return { engine, persisted };
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe("SyncEngine deferred offline scan", () => {
  let storage: GatedStorage;
  beforeEach(() => {
    storage = new GatedStorage();
  });

  it("runs the expensive walk WITHOUT holding the reconcile lock", async () => {
    // "a.md" is on disk with content that differs from its tracked hash → the walk should mark it
    // dirty. Its tracked mtime differs too, so markIfChanged reaches the hash check (reads the file).
    const disk = new Map<string, Uint8Array>([["a.md", new Uint8Array([9, 9, 9])]]);
    const readLog: string[] = [];
    const state: SyncState = {
      lastSyncedRev: 3,
      files: { "a.md": { hash: "stale-hash", mtime: "1970-01-01T00:00:00.000Z" } },
    };
    const { engine } = makeEngine(makeVault(disk, { readLog }), storage, state);

    // Cycle A starts and blocks at list(), holding the reconcile lock.
    const pA = engine.sync({ label: "poll", scanConfig: true });
    await settle();
    expect(storage.listCalls).toBe(1);
    expect(storage.pending).toBe(1);

    // The deferred scan's walk must run to completion even though A owns the lock.
    const pScan = engine.scanForOfflineChanges();
    await settle();
    expect(readLog).toContain("a.md"); // the walk hashed the file — it ran off-lock…
    expect(storage.listCalls).toBe(1); // …and its finalize did NOT start reconciling (A still holds lock)
    expect(storage.pending).toBe(1);

    // Release A → the queued finalize cycle runs and pushes the dirty file the walk found.
    storage.releaseOne();
    await settle();
    expect(storage.listCalls).toBe(2);
    storage.releaseOne(); // let the finalize's own pull unblock
    await settle();
    await Promise.all([pA, pScan]);
    expect(storage.putCalls).toContain("files/a.md");
  });

  it("re-verifies against the live disk, so a file present at finalize time is never tombstoned", async () => {
    // The walk sees NOTHING (getFiles empty) → every tracked file looks missing. But exists() reports
    // them present (as if a concurrent pull materialised them mid-walk), so the finalize re-verify
    // must keep them alive: no cursor reset, no tombstones.
    const disk = new Map<string, Uint8Array>();
    const files: Record<string, { hash: string; mtime: string }> = {};
    for (let i = 0; i < 12; i++) files[`n${i}.md`] = { hash: `h${i}`, mtime: "t" };
    const state: SyncState = { lastSyncedRev: 7, files };
    const { engine } = makeEngine(makeVault(disk, { existsFor: () => true }), storage, state);

    const p = engine.scanForOfflineChanges();
    await settle();
    storage.releaseOne(); // finalize's pull
    await settle();
    await p;

    expect(state.lastSyncedRev).toBe(7); // NOT reset — the mass-missing guard didn't fire
    expect(storage.putCalls).toHaveLength(0); // nothing tombstoned/pushed
  });

  it("restores (resets the cursor) when a genuine mass of files is missing", async () => {
    // Same setup, but the files truly aren't on disk (exists=false) → the mass-missing guard resets
    // the cursor to re-pull from S3 instead of tombstoning the vault everywhere.
    const disk = new Map<string, Uint8Array>();
    const files: Record<string, { hash: string; mtime: string }> = {};
    for (let i = 0; i < 12; i++) files[`n${i}.md`] = { hash: `h${i}`, mtime: "t" };
    const state: SyncState = { lastSyncedRev: 7, files };
    const { engine } = makeEngine(makeVault(disk, { existsFor: () => false }), storage, state);

    const p = engine.scanForOfflineChanges();
    await settle();
    storage.releaseOne(); // finalize's pull
    await settle();
    await p;

    expect(state.lastSyncedRev).toBe(0); // cursor reset → cold re-pull restores the "missing" files
    expect(storage.putCalls).toHaveLength(0); // restored from S3, never tombstoned
  });
});
