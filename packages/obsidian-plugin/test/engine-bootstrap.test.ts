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

const APP_JSON = ".obsidian/app.json";
const REMOTE_APP = encodeText('{"promptDelete":false,"alwaysUpdateLinks":true}\n'); // canonical settings
const DEFAULT_APP = encodeText('{"promptDelete":true}\n'); // Obsidian's freshly-generated default

/** In-memory storage that supports the cold (snapshot) pull path — head() reports the snapshot
 * revision so the engine diffs against the snapshot — and records every put() so a test can assert
 * whether a file was pushed back up. list() returns no deltas: the whole state lives in the snapshot. */
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

/** Vault backed by an on-disk map. getFiles() omits the config dir (like the real Obsidian API), so
 * the engine only sees ".obsidian" content by walking it — mirrored here by list()/stat(). The local
 * mtime is configurable so tests can control the freshest-wins outcome for config files. */
function makeVault(disk: Map<string, Uint8Array>, localMtimeMs = 1): any {
  return {
    configDir: ".obsidian",
    getFiles: () => [],
    adapter: {
      list: async (dir: string) =>
        dir === ".obsidian"
          ? { files: [...disk.keys()].filter((p) => p.startsWith(".obsidian/")), folders: [] }
          : { files: [], folders: [] },
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

function makeEngine(
  storage: MemStorage,
  disk: Map<string, Uint8Array>,
  firstRun: boolean,
  localMtimeMs = 1,
) {
  const state: SyncState = { lastSyncedRev: 0, files: {} };
  const engine = new SyncEngine(makeVault(disk, localMtimeMs), storage as unknown as StorageAdapter, state, {
    deviceId: "dev-test",
    selfDir: ".obsidian/plugins/vault-s3-sync",
    excludedFolders: [],
    concurrency: 4,
    maxDownloadBytes: 0,
    verbose: false,
    log: () => {},
    firstRun,
    onStateChanged: async () => {},
  });
  return { engine, state };
}

describe("SyncEngine first-run bootstrap", () => {
  let storage: MemStorage;
  let disk: Map<string, Uint8Array>;

  beforeEach(() => {
    storage = new MemStorage();
    disk = new Map();
    const snapshot: Snapshot = {
      schemaVersion: 1,
      revision: 3,
      updatedAt: "2026-01-01T00:00:00.000Z",
      files: { [APP_JSON]: remoteEntry(REMOTE_APP) },
    };
    storage.seed("snapshot.json.gz", encodeJsonGz(snapshot));
    storage.seed(`files/${APP_JSON}`, REMOTE_APP);
    // The freshly-opened vault already has Obsidian's default app.json on disk.
    disk.set(APP_JSON, DEFAULT_APP);
  });

  it("takes remote as-is on a config collision instead of union-merging the default", async () => {
    const { engine, state } = makeEngine(storage, disk, /* firstRun */ true);
    await engine.sync({ scanOffline: true });

    // Local default was overwritten by the canonical remote content, byte-for-byte...
    expect(decodeText(disk.get(APP_JSON)!)).toBe(decodeText(REMOTE_APP));
    // ...it is now tracked at the remote hash...
    expect(state.files[APP_JSON]?.hash).toBe(contentHash(REMOTE_APP));
    // ...and nothing was pushed back up (no merged/default clobbering the canonical file in S3).
    expect(storage.puts).toEqual([]);
  });

  it("without the bootstrap flag, a newer-mtime default WINS freshest-wins and is pushed (the hazard bootstrap guards)", async () => {
    // Config files no longer union-merge (that duplicated JSON lines) — they resolve by freshest-
    // wins. A freshly-generated default has a *newer* mtime than the canonical remote, so without
    // the bootstrap guard freshest-wins keeps the local default and pushes it, clobbering the
    // canonical settings everywhere. This is exactly why the first-run guard still exists.
    const localNewer = Date.parse("2027-01-01T00:00:00.000Z");
    const { engine } = makeEngine(storage, disk, /* firstRun */ false, localNewer);
    await engine.sync({ scanOffline: true });

    // Local default kept (not overwritten by canonical remote)...
    expect(decodeText(disk.get(APP_JSON)!)).toBe(decodeText(DEFAULT_APP));
    // ...and pushed up — the corruption vector the bootstrap flag prevents.
    expect(storage.puts).toContain(`files/${APP_JSON}`);
  });

  it("WITH the bootstrap flag, the same newer-mtime default is discarded for the canonical remote", async () => {
    const localNewer = Date.parse("2027-01-01T00:00:00.000Z");
    const { engine, state } = makeEngine(storage, disk, /* firstRun */ true, localNewer);
    await engine.sync({ scanOffline: true });

    // Bootstrap overrides freshest-wins: canonical remote wins despite the local default's newer
    // mtime, and nothing is pushed.
    expect(decodeText(disk.get(APP_JSON)!)).toBe(decodeText(REMOTE_APP));
    expect(state.files[APP_JSON]?.hash).toBe(contentHash(REMOTE_APP));
    expect(storage.puts).toEqual([]);
  });
});
