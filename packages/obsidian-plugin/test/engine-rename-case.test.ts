import { describe, expect, it } from "vitest";
import { type StorageAdapter, decodeJsonGz } from "@vault-sync/core";
import { SyncEngine, SyncState } from "../src/engine";

// Push-side behavior for renames after the case-insensitive-identity rework. The old data-losing
// `goneByCase` guard is gone: the OLD path of a rename is tombstoned only because Obsidian's rename
// event told us so (engine.recordRename), never because a directory listing looked case-shifted. A
// dirty file that is simply present (no rename event) is always re-pushed live, never tombstoned —
// which is what stopped a freshly-pulled note from being wrongly deleted. Cross-key collapse of a
// case-only rename to one node lives in core (see packages/core/test/casing.test.ts).

interface DeltaLike {
  files: Record<string, { deleted?: boolean; renamedTo?: string; hash?: string }>;
}

/** Captures pushed deltas (decoded) and the `files/…` keys uploaded. list() returns no incoming
 * deltas → the pull pass is inert, so a test sees exactly what push() emitted. */
class CapturingStorage implements StorageAdapter {
  deltas: DeltaLike[] = [];
  uploaded: string[] = [];

  list = async (): Promise<never[]> => [];
  head = async (): Promise<null> => null;
  get = async (): Promise<null> => null;
  delete = async (): Promise<void> => {};
  put = async (key: string, body: Uint8Array): Promise<{ etag: string; versionId: string }> => {
    if (key.startsWith("deltas/")) this.deltas.push(decodeJsonGz<DeltaLike>(body));
    else if (key.startsWith("files/")) this.uploaded.push(key.slice("files/".length));
    return { etag: "e", versionId: "v" };
  };
}

/** Case-INSENSITIVE vault (macOS/Windows/iOS/Android storage): any case-variant of an on-disk path
 * stats as the same live file — the exact condition under which the removed guard used to misfire.
 * `diskFiles` are the vault-relative paths actually on disk. */
function makeVault(diskFiles: string[]): any {
  const lower = new Set(diskFiles.map((f) => f.toLowerCase()));
  const inDir = (dir: string) =>
    diskFiles.filter((f) => {
      const slash = f.lastIndexOf("/");
      return (slash === -1 ? "" : f.slice(0, slash)) === dir;
    });
  return {
    configDir: ".obsidian",
    getFiles: () => [],
    adapter: {
      stat: async (p: string) =>
        lower.has(p.toLowerCase()) ? { type: "file", mtime: 1000, size: 11, ctime: 1000 } : null,
      list: async (dir: string) => ({ files: inDir(dir === "/" ? "" : dir), folders: [] }),
      readBinary: async () => new TextEncoder().encode("weight-data").buffer,
      exists: async () => true,
      writeBinary: async () => {},
      remove: async () => {},
      mkdir: async () => {},
    },
  };
}

function makeEngine(vault: any, state: SyncState, storage: StorageAdapter): SyncEngine {
  return new SyncEngine(vault, storage, state, {
    deviceId: "dev-mbp",
    selfDir: ".obsidian/plugins/vault-s3-sync",
    excludedFolders: [],
    concurrency: 4,
    maxDownloadBytes: 0,
    verbose: false,
    log: () => {},
    onStateChanged: async () => {},
  });
}

describe("SyncEngine rename push", () => {
  it("a recorded case-only rename tombstones the old case (with renamedTo) and pushes the new case", async () => {
    const oldCase = "health/Мой Вес.md";
    const newCase = "health/мой вес.md"; // only letter case changed
    const storage = new CapturingStorage();
    const engine = makeEngine(
      makeVault([newCase]), // disk holds only the new-cased file
      { lastSyncedRev: 5, files: { [oldCase]: { hash: "old", mtime: "t" } } },
      storage,
    );

    engine.recordRename(oldCase, newCase); // Obsidian's rename event
    engine.markDirty(oldCase);
    engine.markDirty(newCase);
    await engine.sync({ label: "manual sync" });

    const files = storage.deltas[0].files;
    expect(files[oldCase]).toEqual({ deleted: true, renamedTo: newCase });
    expect(files[newCase]).toMatchObject({ hash: expect.any(String) });
    expect(storage.uploaded).toEqual([newCase]); // only the live destination's bytes go up
  });

  it("a dirty, present file with NO rename event is re-pushed live, NEVER tombstoned (the misfire fix)", async () => {
    // This is the shape that caused the original loss: a freshly-pulled note sits in the dirty set on
    // a case-insensitive device. Without a rename event it must be treated as a live edit, not a
    // "renamed away by case" tombstone. (A case-sibling in the vault is irrelevant now — no listing
    // heuristic runs.)
    const live = "health/мой вес за всё время.md";
    const storage = new CapturingStorage();
    const engine = makeEngine(makeVault([live]), { lastSyncedRev: 5, files: { [live]: { hash: "old", mtime: "t" } } }, storage);

    engine.markDirty(live);
    await engine.sync({ label: "poll" });

    const files = storage.deltas[0].files;
    expect(files[live]).toMatchObject({ hash: expect.any(String) });
    expect(files[live]).not.toHaveProperty("deleted");
    expect(storage.uploaded).toEqual([live]);
  });

  it("a genuinely deleted file (absent on disk, no rename) tombstones as a plain delete", async () => {
    const gone = "notes/gone.md";
    const storage = new CapturingStorage();
    const engine = makeEngine(makeVault([]), { lastSyncedRev: 1, files: { [gone]: { hash: "h", mtime: "t" } } }, storage);

    engine.markDirty(gone);
    await engine.sync({ label: "manual sync" });

    const files = storage.deltas[0].files;
    expect(files[gone]).toEqual({ deleted: true });
    expect(files[gone]).not.toHaveProperty("renamedTo");
    expect(storage.uploaded).toEqual([]);
  });
});
