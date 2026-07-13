import { beforeEach, describe, expect, it } from "vitest";
import {
  contentHash,
  encodeJsonGz,
  Snapshot,
  SnapshotEntry,
  StorageAdapter,
} from "@vault-sync/core";
import { SyncEngine, SyncState } from "../src/engine";

const MB = 1024 * 1024;

/** Minimal in-memory StorageAdapter: a keyed blob store seeded with a snapshot + file objects.
 * loadRemoteState() reads SNAPSHOT_KEY, lists deltas (none here), then get()s files/<path>. */
class MemStorage implements StorageAdapter {
  private blobs = new Map<string, Uint8Array>();

  seed(key: string, bytes: Uint8Array): void {
    this.blobs.set(key, bytes);
  }

  get = async (key: string) => {
    const body = this.blobs.get(key);
    return body ? { body, versionId: "v-" + key } : null;
  };
  head = async () => null;
  put = async () => ({ etag: "e", versionId: "v" });
  list = async () => [];
  delete = async () => {};
}

/** Vault that records force-written files so we can assert what landed on disk. Everything starts
 * absent (stat → null), matching a capped device that never downloaded the big attachments. */
function makeVault(written: Map<string, Uint8Array>): any {
  return {
    configDir: ".obsidian",
    getFiles: () => [],
    adapter: {
      list: async () => ({ files: [], folders: [] }),
      stat: async (p: string) => (written.has(p) ? { type: "file", mtime: 0 } : null),
      readBinary: async (p: string) => {
        const b = written.get(p);
        return b ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : new ArrayBuffer(0);
      },
      exists: async () => false,
      writeBinary: async (p: string, data: ArrayBuffer) => {
        written.set(p, new Uint8Array(data));
      },
      remove: async () => {},
      mkdir: async () => {},
    },
  };
}

function entry(bytes: Uint8Array, size: number): SnapshotEntry {
  return {
    hash: contentHash(bytes),
    size,
    mtime: "2026-01-01T00:00:00.000Z",
    s3VersionId: "v1",
    rev: 3,
    by: "other-device",
  } as SnapshotEntry;
}

function makeEngine(storage: MemStorage, written: Map<string, Uint8Array>, maxDownloadBytes = 5 * MB) {
  const state: SyncState = { lastSyncedRev: 0, files: {} };
  const engine = new SyncEngine(makeVault(written), storage as unknown as StorageAdapter, state, {
    deviceId: "dev-test",
    selfDir: ".obsidian/plugins/vault-s3-sync",
    excludedFolders: [],
    concurrency: 4,
    maxDownloadBytes, // cap is deliberately small; forceDownload must ignore it
    verbose: false,
    log: () => {},
    onStateChanged: async () => {},
  });
  return { engine, state };
}

describe("SyncEngine forceDownloadPaths", () => {
  let storage: MemStorage;
  let written: Map<string, Uint8Array>;
  const bigBytes = new Uint8Array([1, 2, 3, 4]);
  const noteBytes = new Uint8Array([5, 6]);

  beforeEach(() => {
    storage = new MemStorage();
    written = new Map();
    const snapshot: Snapshot = {
      schemaVersion: 1,
      revision: 3,
      updatedAt: "2026-01-01T00:00:00.000Z",
      files: {
        "attachments/big.png": entry(bigBytes, 20 * MB), // way over the 5 MB cap
        "Note.md": entry(noteBytes, 100),
        "gone.pdf": { deleted: true, rev: 3, by: "other-device" } as SnapshotEntry,
      },
    };
    storage.seed("snapshot.json.gz", encodeJsonGz(snapshot));
    storage.seed("files/attachments/big.png", bigBytes);
    storage.seed("files/Note.md", noteBytes);
  });

  it("downloads an over-cap file, bypassing the per-device size limit", async () => {
    const { engine, state } = makeEngine(storage, written);
    const r = await engine.forceDownloadPaths(["attachments/big.png"]);

    expect(r).toMatchObject({ requested: 1, downloaded: 1, upToDate: 0, notFound: [] });
    expect(written.has("attachments/big.png")).toBe(true); // fetched despite 20 MB > 5 MB cap
    expect(state.files["attachments/big.png"]?.hash).toBe(contentHash(bigBytes)); // now tracked
  });

  it("resolves a bare filename and a wikilink note name against live remote state", async () => {
    const { engine } = makeEngine(storage, written);
    // "big.png" (basename only) and "Note" (wikilink without .md) must both resolve.
    const r = await engine.forceDownloadPaths(["big.png", "Note"]);

    expect(r.downloaded).toBe(2);
    expect(written.has("attachments/big.png")).toBe(true);
    expect(written.has("Note.md")).toBe(true);
  });

  it("reports candidates with no live remote object as not found (missing or tombstoned)", async () => {
    const { engine } = makeEngine(storage, written);
    const r = await engine.forceDownloadPaths(["does-not-exist.mov", "gone.pdf"]);

    expect(r.downloaded).toBe(0);
    expect(r.notFound.sort()).toEqual(["does-not-exist.mov", "gone.pdf"]);
    expect(written.size).toBe(0);
  });

  it("counts an already-present, current file as up-to-date without re-downloading", async () => {
    const { engine } = makeEngine(storage, written);
    written.set("attachments/big.png", bigBytes); // already on disk, identical bytes

    const r = await engine.forceDownloadPaths(["attachments/big.png"]);
    expect(r).toMatchObject({ downloaded: 0, upToDate: 1, notFound: [] });
  });
});
