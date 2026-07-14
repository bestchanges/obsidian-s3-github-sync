import { beforeEach, describe, expect, it } from "vitest";
import {
  contentHash,
  encodeJsonGz,
  Snapshot,
  SnapshotEntry,
  StorageAdapter,
} from "@vault-sync/core";
import { SyncEngine, SyncState } from "../src/engine";

/** In-memory storage covering the cold (snapshot) pull path — head() reports the seeded snapshot
 * revision so the engine diffs against it — plus recording puts/deletes so a test can assert the
 * push leg. list() returns no deltas: the whole remote state lives in the snapshot. */
class MemStorage implements StorageAdapter {
  private blobs = new Map<string, Uint8Array>();
  readonly puts: string[] = [];
  private snapshotRev = 0;

  seedSnapshot(snap: Snapshot): void {
    this.blobs.set("snapshot.json.gz", encodeJsonGz(snap));
    this.snapshotRev = snap.revision;
  }
  seedFile(path: string, bytes: Uint8Array): void {
    this.blobs.set(`files/${path}`, bytes);
  }

  get = async (key: string) => {
    const body = this.blobs.get(key);
    return body ? { body, versionId: "v-" + key } : null;
  };
  head = async (key: string) =>
    key === "snapshot.json.gz" && this.snapshotRev
      ? { metadata: { revision: String(this.snapshotRev) }, size: 0, etag: "e" }
      : null;
  put = async (key: string, body: Uint8Array) => {
    this.puts.push(key);
    this.blobs.set(key, body);
    return { etag: "e", versionId: "v-put" };
  };
  list = async () => [];
  delete = async () => {};
}

/** Vault backed by an on-disk map. getFiles() returns the non-config files (like the real Obsidian
 * API, which omits the config dir), so the offline scan can mark local edits/deletes dirty. */
function makeVault(disk: Map<string, Uint8Array>, localMtimeMs = 1): any {
  return {
    configDir: ".obsidian",
    getFiles: () =>
      [...disk.keys()]
        .filter((p) => !p.startsWith(".obsidian/"))
        .map((p) => ({ path: p, stat: { mtime: localMtimeMs } })),
    adapter: {
      list: async () => ({ files: [], folders: [] }),
      stat: async (p: string) => (disk.has(p) ? { type: "file", mtime: localMtimeMs } : null),
      readBinary: async (p: string) => {
        const b = disk.get(p) ?? new Uint8Array(0);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
      exists: async (p: string) => disk.has(p),
      writeBinary: async (p: string, data: ArrayBuffer) => {
        disk.set(p, new Uint8Array(data));
      },
      remove: async (p: string) => void disk.delete(p),
      mkdir: async () => {},
    },
  };
}

function remoteEntry(bytes: Uint8Array): SnapshotEntry {
  return {
    hash: contentHash(bytes),
    size: bytes.byteLength,
    mtime: "2026-01-01T00:00:00.000Z",
    s3VersionId: "v1",
    rev: 3,
    by: "other-device",
  } as SnapshotEntry;
}

function tombstone(): SnapshotEntry {
  return { deleted: true, rev: 3, by: "other-device" } as SnapshotEntry;
}

function makeEngine(storage: MemStorage, disk: Map<string, Uint8Array>, state?: SyncState) {
  const logs: string[] = [];
  const engine = new SyncEngine(
    makeVault(disk),
    storage as unknown as StorageAdapter,
    state ?? { lastSyncedRev: 0, files: {} },
    {
      deviceId: "dev-test",
      selfDir: ".obsidian/plugins/vault-s3-sync",
      excludedFolders: [],
      concurrency: 4,
      maxDownloadBytes: 0,
      verbose: false,
      log: (_level, msg) => logs.push(msg),
      onStateChanged: async () => {},
    },
  );
  return { engine, logs };
}

describe("SyncEngine per-cycle file-list logging", () => {
  let storage: MemStorage;
  let disk: Map<string, Uint8Array>;

  beforeEach(() => {
    storage = new MemStorage();
    disk = new Map();
  });

  it("logs each downloaded file with a ↓ pulled line", async () => {
    const a = new Uint8Array([1]);
    const b = new Uint8Array([2]);
    storage.seedSnapshot({
      schemaVersion: 1,
      revision: 3,
      updatedAt: "2026-01-01T00:00:00.000Z",
      files: { "A.md": remoteEntry(a), "sub/B.md": remoteEntry(b) },
    });
    storage.seedFile("A.md", a);
    storage.seedFile("sub/B.md", b);

    const { engine, logs } = makeEngine(storage, disk);
    await engine.sync({});

    expect(logs).toContain("↓ pulled A.md");
    expect(logs).toContain("↓ pulled sub/B.md");
  });

  it("logs each uploaded file with a ↑ pushed line", async () => {
    disk.set("Local.md", new Uint8Array([9]));
    const { engine, logs } = makeEngine(storage, disk);
    await engine.sync({ scanOffline: true });

    expect(logs).toContain("↑ pushed Local.md");
  });

  it("logs a ↓ deleted line when a remote tombstone removes a local file", async () => {
    const bytes = new Uint8Array([7]);
    disk.set("Gone.md", bytes);
    storage.seedSnapshot({
      schemaVersion: 1,
      revision: 3,
      updatedAt: "2026-01-01T00:00:00.000Z",
      files: { "Gone.md": tombstone() },
    });
    const state: SyncState = {
      lastSyncedRev: 0,
      files: { "Gone.md": { hash: contentHash(bytes), mtime: "2026-01-01T00:00:00.000Z" } },
    };

    const { engine, logs } = makeEngine(storage, disk, state);
    await engine.sync({});

    expect(logs).toContain("↓ deleted Gone.md");
    expect(disk.has("Gone.md")).toBe(false);
  });

  it("logs a ↑ deleted line when a local deletion is tombstoned in the cloud", async () => {
    const bytes = new Uint8Array([4]);
    // Tracked in state but absent from disk → the offline scan sees it as a genuine local delete.
    const state: SyncState = {
      lastSyncedRev: 0,
      files: { "Bye.md": { hash: contentHash(bytes), mtime: "2026-01-01T00:00:00.000Z" } },
    };
    const { engine, logs } = makeEngine(storage, disk, state);
    await engine.sync({ scanOffline: true });

    expect(logs).toContain("↑ deleted Bye.md");
  });

  it("caps the list at 20 per direction and collapses the rest to '…and N more'", async () => {
    const files: Record<string, SnapshotEntry> = {};
    for (let i = 0; i < 25; i++) {
      const bytes = new Uint8Array([i]);
      const path = `f${String(i).padStart(2, "0")}.md`;
      files[path] = remoteEntry(bytes);
      storage.seedFile(path, bytes);
    }
    storage.seedSnapshot({
      schemaVersion: 1,
      revision: 3,
      updatedAt: "2026-01-01T00:00:00.000Z",
      files,
    });

    const { engine, logs } = makeEngine(storage, disk);
    await engine.sync({});

    const pulledLines = logs.filter((l) => l.startsWith("↓ pulled ") && !l.includes("…and"));
    expect(pulledLines).toHaveLength(20);
    expect(logs).toContain("↓ pulled …and 5 more");
  });
});
