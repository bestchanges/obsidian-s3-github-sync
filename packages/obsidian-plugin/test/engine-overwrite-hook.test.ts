import { beforeEach, describe, expect, it } from "vitest";
import {
  contentHash,
  decodeText,
  encodeJsonGz,
  encodeText,
  Snapshot,
  SnapshotEntry,
  StorageAdapter,
} from "@vault-sync/core";
import { SyncEngine, SyncState } from "../src/engine";

const NOTE = "notes/kept.md";
const NEW_NOTE = "notes/fresh.md";
const REMOTE = encodeText("remote body\n");
const LOCAL = encodeText("local body that sync is about to replace\n");

/** Cold-pull storage: head() reports the snapshot revision, so the engine diffs against the snapshot. */
class MemStorage implements StorageAdapter {
  private blobs = new Map<string, Uint8Array>();
  readonly puts: string[] = [];

  seed(key: string, bytes: Uint8Array): void {
    this.blobs.set(key, bytes);
  }

  get = async (key: string) => {
    const body = this.blobs.get(key);
    return body ? { body, versionId: "v-" + key } : null;
  };
  head = async (key: string) =>
    key === "snapshot.json.gz" ? { metadata: { revision: "3" }, size: 0, etag: "e" } : null;
  put = async (key: string, body: Uint8Array) => {
    this.puts.push(key);
    this.blobs.set(key, body);
    return { etag: "e", versionId: "v-put" };
  };
  list = async () => [];
  delete = async () => {};
}

function makeVault(disk: Map<string, Uint8Array>): any {
  return {
    configDir: ".obsidian",
    getFiles: () => [],
    adapter: {
      list: async () => ({ files: [], folders: [] }),
      stat: async (p: string) => (disk.has(p) ? { type: "file", mtime: 1 } : null),
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

function makeEngine(
  storage: MemStorage,
  disk: Map<string, Uint8Array>,
  onBeforeOverwrite?: (path: string) => Promise<void>,
) {
  const state: SyncState = { lastSyncedRev: 0, files: {} };
  const engine = new SyncEngine(makeVault(disk), storage as unknown as StorageAdapter, state, {
    deviceId: "dev-test",
    selfDir: ".obsidian/plugins/vault-s3-sync",
    excludedFolders: [],
    concurrency: 4,
    maxDownloadBytes: 0,
    verbose: false,
    log: () => {},
    firstRun: true, // take remote as-is on collision, so the pull actually overwrites
    onBeforeOverwrite,
    onStateChanged: async () => {},
  });
  return { engine, state };
}

describe("SyncEngine onBeforeOverwrite (File recovery safety net, §4.12)", () => {
  let storage: MemStorage;
  let disk: Map<string, Uint8Array>;

  beforeEach(() => {
    storage = new MemStorage();
    disk = new Map();
    const snapshot: Snapshot = {
      schemaVersion: 1,
      revision: 3,
      updatedAt: "2026-01-01T00:00:00.000Z",
      files: { [NOTE]: remoteEntry(REMOTE), [NEW_NOTE]: remoteEntry(REMOTE) },
    };
    storage.seed("snapshot.json.gz", encodeJsonGz(snapshot));
    storage.seed(`files/${NOTE}`, REMOTE);
    storage.seed(`files/${NEW_NOTE}`, REMOTE);
    disk.set(NOTE, LOCAL); // exists locally → the pull replaces it
  });

  it("fires for an existing file, with the pre-overwrite bytes still on disk", async () => {
    const seen: { path: string; contentAtCall: string }[] = [];
    const { engine } = makeEngine(storage, disk, async (path) => {
      // The snapshot must capture what is about to be LOST, so the old bytes are still readable here.
      seen.push({ path, contentAtCall: decodeText(disk.get(path)!) });
    });
    await engine.sync({ scanOffline: true });

    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe(NOTE);
    expect(seen[0].contentAtCall).toBe(decodeText(LOCAL));
    expect(decodeText(disk.get(NOTE)!)).toBe(decodeText(REMOTE)); // and the pull still landed
  });

  it("does not fire for a file that did not exist locally (nothing is being replaced)", async () => {
    const seen: string[] = [];
    const { engine } = makeEngine(storage, disk, async (p) => void seen.push(p));
    await engine.sync({ scanOffline: true });

    expect(seen).not.toContain(NEW_NOTE);
    expect(decodeText(disk.get(NEW_NOTE)!)).toBe(decodeText(REMOTE));
  });

  it("a throwing hook never blocks the write", async () => {
    const { engine } = makeEngine(storage, disk, async () => {
      throw new Error("file-recovery unavailable");
    });
    await engine.sync({ scanOffline: true });
    expect(decodeText(disk.get(NOTE)!)).toBe(decodeText(REMOTE));
  });

  it("is optional — the engine syncs normally without a hook", async () => {
    const { engine } = makeEngine(storage, disk, undefined);
    await engine.sync({ scanOffline: true });
    expect(decodeText(disk.get(NOTE)!)).toBe(decodeText(REMOTE));
  });
});
