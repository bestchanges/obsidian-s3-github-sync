import { beforeEach, describe, expect, it } from "vitest";
import {
  contentHash,
  Delta,
  deltaKey,
  encodeJsonGz,
  encodeText,
  StorageAdapter,
} from "@vault-sync/core";
import { SyncEngine, SyncState } from "../src/engine";

/**
 * A fenced cycle must STOP, not drain its queue (§4.3).
 *
 * The stall watchdog abandons a wedged cycle by bumping the cycle counter — a per-cycle flag — which
 * frees the lock for a replacement. The orphan was only ever checked against that flag around
 * `push`, never in the pull/apply path, so an abandoned catch-up kept downloading every remaining
 * file while its replacement did the same work: on 2026-08-23 one poll reported `↓13` for three
 * files, having re-fetched `main.js` seven times. Both cycles also shared the counters, so the
 * numbers belonged to neither.
 */

class Remote {
  blobs = new Map<string, Uint8Array>();
  /** every `files/` GET, in order — the work an abandoned cycle should stop doing */
  fileGets: string[] = [];
  onFileGet: ((n: number) => void) | null = null;

  get = async (key: string, opts?: { versionId?: string }) => {
    if (key.startsWith("files/")) {
      this.fileGets.push(key);
      this.onFileGet?.(this.fileGets.length);
    }
    const b = this.blobs.get(key);
    return b ? { body: b, versionId: opts?.versionId ?? "v1", etag: "e" } : null;
  };
  head = async () => null;
  put = async () => ({ etag: "e", versionId: "v1" });
  list = async (prefix: string, startAfter?: string) =>
    [...this.blobs.keys()]
      .filter((k) => k.startsWith(prefix) && (!startAfter || k > startAfter))
      .sort()
      .map((key) => ({ key, lastModified: new Date() }));
  delete = async () => {};
}

function makeVault(disk: Map<string, Uint8Array>): any {
  return {
    configDir: ".obsidian",
    getFiles: () => [...disk.keys()].map((path) => ({ path, stat: { mtime: 1 } })),
    adapter: {
      list: async () => ({ files: [], folders: [] }),
      stat: async (p: string) => (disk.has(p) ? { type: "file", mtime: 1 } : null),
      readBinary: async (p: string) => {
        const b = disk.get(p) ?? new Uint8Array(0);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
      exists: async (p: string) => disk.has(p),
      writeBinary: async (p: string, data: ArrayBuffer) => void disk.set(p, new Uint8Array(data)),
      remove: async (p: string) => void disk.delete(p),
      mkdir: async () => {},
    },
  };
}

const TOTAL_FILES = 40;

describe("an abandoned cycle stops applying (§4.3)", () => {
  let remote: Remote;
  let disk: Map<string, Uint8Array>;
  let logs: string[];

  beforeEach(() => {
    remote = new Remote();
    disk = new Map();
    logs = [];
    // One revision carrying TOTAL_FILES files, authored elsewhere — a bulk catch-up.
    const files: Record<string, { hash: string; size: number; mtime: string }> = {};
    for (let i = 0; i < TOTAL_FILES; i++) {
      const path = `note-${String(i).padStart(2, "0")}.md`;
      const body = encodeText(`body ${i}\n`);
      remote.blobs.set(`files/${path}`, body);
      files[path] = { hash: contentHash(body), size: body.length, mtime: new Date().toISOString() };
    }
    const delta: Delta = { rev: 1, by: "peer", at: new Date().toISOString(), files };
    remote.blobs.set(deltaKey(1), encodeJsonGz(delta));
  });

  function makeEngine(state: SyncState): SyncEngine {
    return new SyncEngine(makeVault(disk), remote as unknown as StorageAdapter, state, {
      deviceId: "dev-test",
      selfDir: ".obsidian/plugins/vault-s3-sync",
      excludedFolders: [],
      concurrency: 4,
      maxDownloadBytes: 0,
      verbose: false,
      log: (_l, m) => void logs.push(m),
      onStateChanged: async () => {},
    });
  }

  it("stops downloading once fenced, instead of draining the rest of the queue", async () => {
    const state: SyncState = { lastSyncedRev: 0, files: {} };
    const engine = makeEngine(state);

    // Fence the cycle partway through the chunk, exactly as the stall watchdog does.
    remote.onFileGet = (n) => {
      if (n === 5) (engine as unknown as { cycleSeq: number }).cycleSeq++;
    };

    await engine.sync({ label: "poll" }).catch(() => {
      /* the fenced cycle unwinds; the assertion is about what it stopped doing */
    });

    // Concurrency is 4, so a handful already in flight still land — but nothing like all 40.
    expect(remote.fileGets.length).toBeLessThan(TOTAL_FILES);
    expect(remote.fileGets.length).toBeLessThanOrEqual(12);
  });

  it("does not let an orphan's downloads count towards the next cycle", async () => {
    const state: SyncState = { lastSyncedRev: 0, files: {} };
    const first = makeEngine(state);
    remote.onFileGet = (n) => {
      if (n === 5) (first as unknown as { cycleSeq: number }).cycleSeq++;
    };
    await first.sync({ label: "poll" }).catch(() => {});

    // A fresh engine (the replacement cycle) applies the same revision from scratch and must report
    // only its OWN work — the shared-counter bug made one cycle claim another's downloads.
    //
    // Its own empty disk, deliberately: sharing the first cycle's disk would make the files it did
    // write hash-identical to remote, and `applyRemote` records those without downloading — a
    // correct optimisation that would quietly mask what this test is measuring.
    logs.length = 0;
    remote.fileGets.length = 0;
    remote.onFileGet = null;
    disk = new Map();
    const second = makeEngine({ lastSyncedRev: 0, files: {} });
    await second.sync({ label: "poll", announce: true });

    const summary = logs.find((m) => m.startsWith("Sync: done"));
    expect(summary).toBeDefined();
    expect(summary).toContain(`↓${TOTAL_FILES}`);
    expect(remote.fileGets.length).toBe(TOTAL_FILES);
  });

  it("leaves the cursor untouched when it stops early, so the work is simply retried", async () => {
    const state: SyncState = { lastSyncedRev: 0, files: {} };
    const engine = makeEngine(state);
    remote.onFileGet = (n) => {
      if (n === 5) (engine as unknown as { cycleSeq: number }).cycleSeq++;
    };

    await engine.sync({ label: "poll" }).catch(() => {});

    // Never advanced past the revision it failed to finish: the replacement re-applies it whole.
    expect(state.lastSyncedRev).toBe(0);
  });
});
