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

const NOTE = "projects/family.md";

/** The note as it was when this machine last pushed — i.e. what a restored backup holds. */
const OLD = encodeText(
  "## Задачи\n- [ ] #task звонить семье 🔁 every 2 days when done ⏳ 2026-08-04\n",
);
/** The same note after the cloud rolled the recurring task forward. */
const NEW = encodeText(
  "## Задачи\n" +
    "- [ ] #task звонить семье 🔁 every 2 days when done ⏳ 2026-08-12\n" +
    "- [x] #task звонить семье 🔁 every 2 days when done ⏳ 2026-08-04 ✅ 2026-08-10\n",
);
/** A genuine local edit made after the backup was taken — diverges from BOTH sides. */
const LOCAL_EDIT = encodeText(
  "## Задачи\n- [ ] #task звонить семье 🔁 every 2 days when done ⏳ 2026-08-04\n- [ ] #task купить билеты\n",
);

class MemStorage implements StorageAdapter {
  private blobs = new Map<string, Uint8Array>();
  readonly puts: string[] = [];

  seed(key: string, bytes: Uint8Array): void {
    this.blobs.set(key, bytes);
  }
  get = async (key: string, opts?: { versionId?: string }) => {
    // Versioned reads serve the merge base: "vOLD" is the revision this device last saw.
    if (opts?.versionId === "vOLD") return { body: OLD, versionId: "vOLD" };
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
    // Notes only — the real getFiles() omits the config dir, which this harness has none of.
    getFiles: () =>
      [...disk.keys()]
        .filter((p) => !p.startsWith(".obsidian/"))
        .map((path) => ({ path, stat: { mtime: 1 } })),
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
  state: SyncState,
  opts: { adopted?: boolean; defer?: boolean } = {},
) {
  return new SyncEngine(makeVault(disk), storage as unknown as StorageAdapter, state, {
    deviceId: "egors-macbook-air-p01f",
    selfDir: ".obsidian/plugins/vault-s3-sync",
    excludedFolders: [],
    concurrency: 4,
    maxDownloadBytes: 0,
    verbose: false,
    log: () => {},
    firstRun: false, // a copied vault is never a first run — its content is real
    adoptedForeignState: opts.adopted ?? false,
    deferConflicts: opts.defer ?? false,
    onStateChanged: async () => {},
  });
}

/** State as it survives a vault restore: baselines for content this machine had already pushed. */
function adoptedState(): SyncState {
  return {
    lastSyncedRev: 0, // cursor rewound by the foreign-state adoption
    files: { [NOTE]: { hash: contentHash(OLD), s3VersionId: "vOLD", mtime: "2026-08-04T00:00:00.000Z" } },
  };
}

describe("SyncEngine foreign-state adoption (vault restored onto a new machine)", () => {
  let storage: MemStorage;
  let disk: Map<string, Uint8Array>;

  beforeEach(() => {
    storage = new MemStorage();
    disk = new Map();
    const snapshot: Snapshot = {
      schemaVersion: 1,
      revision: 3,
      updatedAt: "2026-01-01T00:00:00.000Z",
      files: { [NOTE]: remoteEntry(NEW) },
    };
    storage.seed("snapshot.json.gz", encodeJsonGz(snapshot));
    storage.seed(`files/${NOTE}`, NEW);
    disk.set(NOTE, OLD); // the restored backup
  });

  it("retained baselines make a restore a clean fast-forward — no merge, no duplicated task", async () => {
    const state = adoptedState();
    const engine = makeEngine(storage, disk, state, { adopted: true, defer: true });
    await engine.sync({ scanOffline: true });

    // The restored copy still matches its recorded baseline, so it is NOT a local edit: remote lands
    // byte-for-byte and the open task exists exactly once.
    expect(decodeText(disk.get(NOTE)!)).toBe(decodeText(NEW));
    expect(decodeText(disk.get(NOTE)!).match(/- \[ \] #task звонить семье/g)).toHaveLength(1);
    expect(engine.deferredConflicts()).toEqual([]); // not a collision at all
    expect(storage.puts).toEqual([]); // nothing pushed back up
    expect(state.files[NOTE]?.hash).toBe(contentHash(NEW));
  });

  it("REGRESSION: dropping the baselines instead duplicates the rolled-forward task", async () => {
    // What the old adoption did — wipe state.files. With no baseline the conflict has no merge base,
    // and unionMerge("", ours, theirs) keeps both sides of every changed line. This is the exact
    // mechanism that doubled every recurring task after a Mac rebuild.
    const state: SyncState = { lastSyncedRev: 0, files: {} };
    const engine = makeEngine(storage, disk, state, { adopted: false, defer: false });
    await engine.sync({ scanOffline: true });

    const merged = decodeText(disk.get(NOTE)!);
    expect(merged.match(/- \[ \] #task звонить семье/g)).toHaveLength(2); // ⏳08-04 AND ⏳08-12
    expect(merged).toContain("⏳ 2026-08-04\n");
    expect(merged).toContain("⏳ 2026-08-12");
  });

  it("a genuinely divergent local file is deferred, not merged: both copies left untouched", async () => {
    disk.set(NOTE, LOCAL_EDIT); // edited after the backup — differs from baseline AND from remote
    const state = adoptedState();
    const engine = makeEngine(storage, disk, state, { adopted: true, defer: true });
    await engine.sync({ scanOffline: true });

    expect(engine.deferredConflicts()).toEqual([NOTE]);
    expect(decodeText(disk.get(NOTE)!)).toBe(decodeText(LOCAL_EDIT)); // local untouched
    expect(storage.puts).toEqual([]); // and never pushed over the cloud copy
    expect(state.files[NOTE]?.hash).toBe(contentHash(OLD)); // baseline unchanged
  });

  it('"use cloud" resolves every deferred collision from S3', async () => {
    disk.set(NOTE, LOCAL_EDIT);
    const state = adoptedState();
    const engine = makeEngine(storage, disk, state, { adopted: true, defer: true });
    await engine.sync({ scanOffline: true });
    expect(engine.deferredConflicts()).toEqual([NOTE]);

    await engine.resolveDeferredFromCloud();

    expect(decodeText(disk.get(NOTE)!)).toBe(decodeText(NEW)); // cloud copy, as-is
    expect(decodeText(disk.get(NOTE)!).match(/- \[ \] #task звонить семье/g)).toHaveLength(1);
    expect(engine.deferredConflicts()).toEqual([]);
    expect(storage.puts).toEqual([]); // remote already correct — nothing to publish
  });

  it('"merge" resolves them by union-merging against the retained base (lossless)', async () => {
    disk.set(NOTE, LOCAL_EDIT);
    const state = adoptedState();
    const engine = makeEngine(storage, disk, state, { adopted: true, defer: true });
    await engine.sync({ scanOffline: true });

    await engine.resolveDeferredByMerging();

    const merged = decodeText(disk.get(NOTE)!);
    // A real three-way merge against the retained base (vOLD): nothing is lost — the local addition
    // and the cloud's roll-forward both survive.
    expect(merged).toContain("#task купить билеты");
    expect(merged).toContain("⏳ 2026-08-12");
    // But the two edits land in the same region, so union merge keeps BOTH copies of the recurring
    // task. Lossless is not the same as right, which is why "merge" is offered as a named choice
    // with that cost spelled out rather than applied silently — and why "use cloud" exists.
    expect(merged.match(/- \[ \] #task звонить семье/g)).toHaveLength(2);
    expect(engine.deferredConflicts()).toEqual([]);
    expect(storage.puts).toContain(`files/${NOTE}`); // merged result goes back up
  });

  it("a tracked file the restore is missing is re-downloaded, never tombstoned", async () => {
    disk.delete(NOTE); // the backup didn't include it
    const state = adoptedState();
    const engine = makeEngine(storage, disk, state, { adopted: true, defer: true });
    await engine.sync({ scanOffline: true });

    // Below the mass-missing threshold, so without the adoption guard this would have propagated a
    // tombstone and deleted the note off every other device.
    expect(disk.has(NOTE)).toBe(true);
    expect(decodeText(disk.get(NOTE)!)).toBe(decodeText(NEW));
    expect(storage.puts).toEqual([]);
  });
});
