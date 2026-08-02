import { describe, expect, it } from "vitest";
import { type StorageAdapter, decodeJsonGz } from "@vault-sync/core";
import { SyncEngine, SyncState } from "../src/engine";

// Regression tests for the case-only rename duplicate (macOS/iOS). Renaming a note so only the
// LETTER CASE changes (e.g. "My Note" → "My note") leaves the old-cased path dirty. On a
// case-INSENSITIVE filesystem stat() resolves it to the new file, so push() used to re-push it as a
// live entry — a phantom duplicate that only materializes on case-SENSITIVE (Android/Linux) peers.
// push() must instead confirm the exact-case basename on disk and tombstone a renamed-away path.

interface DeltaLike {
  files: Record<string, { deleted?: boolean; hash?: string }>;
}

/** Captures pushed deltas (decoded) and the `files/…` keys uploaded, so a test can assert exactly
 * what push() wrote. Every op no-ops otherwise; list() returns no incoming deltas → pull is inert. */
class CapturingStorage implements StorageAdapter {
  deltas: DeltaLike[] = [];
  uploaded: string[] = [];
  listThrows = false;

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

/** Vault whose stat() is case-INSENSITIVE (mimics APFS/HFS+: any case-variant of an on-disk path
 * stats as a live file) but whose list() is case-SENSITIVE (returns real, exact-case basenames) —
 * the exact split that produced the bug. `diskFiles` are the vault-relative paths actually on disk. */
function makeVault(diskFiles: string[], listThrows = false): any {
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
      list: async (dir: string) => {
        if (listThrows) throw new Error("list unavailable");
        return { files: inDir(dir === "/" ? "" : dir), folders: [] };
      },
      readBinary: async () => new TextEncoder().encode("weight-data").buffer,
      exists: async () => true,
      writeBinary: async () => {},
      remove: async () => {},
      mkdir: async () => {},
    },
  };
}

function makeEngine(
  vault: any,
  state: SyncState,
  storage: StorageAdapter,
  caseInsensitiveFS = true, // the macOS/iOS default these tests model; false = case-sensitive (Android/Linux)
): SyncEngine {
  return new SyncEngine(vault, storage, state, {
    deviceId: "dev-mbp",
    selfDir: ".obsidian/plugins/vault-s3-sync",
    excludedFolders: [],
    concurrency: 4,
    maxDownloadBytes: 0,
    verbose: false,
    caseInsensitiveFS,
    log: () => {},
    onStateChanged: async () => {},
  });
}

/** Vault on a case-SENSITIVE filesystem (Android/Linux): stat() resolves ONLY the exact path, and
 * list() returns exact basenames — optionally run through `mangle` to model the real failure trigger
 * (an NFD-normalized listing entry, or a stale listing that still shows a case-sibling). `diskFiles`
 * are the exact vault-relative paths on disk. */
function makeVaultCS(diskFiles: string[], listNames?: string[]): any {
  const exact = new Set(diskFiles);
  const inDir = (dir: string, names: string[]) =>
    names.filter((f) => {
      const slash = f.lastIndexOf("/");
      return (slash === -1 ? "" : f.slice(0, slash)) === dir;
    });
  return {
    configDir: ".obsidian",
    getFiles: () => [],
    adapter: {
      stat: async (p: string) =>
        exact.has(p) ? { type: "file", mtime: 1000, size: 11, ctime: 1000 } : null,
      list: async (dir: string) => ({
        files: inDir(dir === "/" ? "" : dir, listNames ?? diskFiles),
        folders: [],
      }),
      readBinary: async () => new TextEncoder().encode("weight-data").buffer,
      exists: async () => true,
      writeBinary: async () => {},
      remove: async () => {},
      mkdir: async () => {},
    },
  };
}

describe("SyncEngine case-only rename", () => {
  it("does not push a duplicate for the old-cased path (the reported bug)", async () => {
    // Faithful replay: "My Note" → "My Note Final" → "My note final", all between two syncs. Only
    // the final lowercase file is on disk; "My Note.md" was synced last cycle, while
    // "My Note Final.md" was created and renamed away within this batch (never synced).
    const final = "notes/My note final.md";
    const midDeleted = "notes/My Note.md";
    const midRenamedAway = "notes/My Note Final.md";
    const storage = new CapturingStorage();
    const engine = makeEngine(makeVault([final]), { lastSyncedRev: 3, files: { [midDeleted]: { hash: "old", mtime: "t" } } }, storage);

    engine.markDirty(midDeleted);
    engine.markDirty(midRenamedAway);
    engine.markDirty(final);
    await engine.sync({ label: "manual sync" });

    expect(storage.deltas).toHaveLength(1);
    const files = storage.deltas[0].files;
    // The final note is the only live upload — no case-variant duplicate.
    expect(storage.uploaded).toEqual([final]);
    expect(files[final]).toMatchObject({ hash: expect.any(String) });
    // The intermediate name that WAS synced is tombstoned.
    expect(files[midDeleted]).toEqual({ deleted: true });
    // The case-variant that was renamed away (and never synced) is neither pushed nor tombstoned.
    expect(files).not.toHaveProperty(midRenamedAway);
  });

  it("tombstones the old case and pushes the new case when a synced file is re-cased", async () => {
    const oldCase = "notes/Foo.md";
    const newCase = "notes/foo.md";
    const storage = new CapturingStorage();
    const engine = makeEngine(makeVault([newCase]), { lastSyncedRev: 1, files: { [oldCase]: { hash: "old", mtime: "t" } } }, storage);

    engine.markDirty(oldCase);
    engine.markDirty(newCase);
    await engine.sync({ label: "manual sync" });

    const files = storage.deltas[0].files;
    expect(files[oldCase]).toEqual({ deleted: true });
    expect(files[newCase]).toMatchObject({ hash: expect.any(String) });
    expect(storage.uploaded).toEqual([newCase]);
  });

  it("falls back to trusting stat when the directory can't be listed (no false tombstone)", async () => {
    // A transient list() failure must NOT be read as "renamed away" — that would wrongly tombstone a
    // present file. The path stays pushed.
    const path = "notes/keep.md";
    const storage = new CapturingStorage();
    const engine = makeEngine(makeVault([path], /* listThrows */ true), { lastSyncedRev: 1, files: {} }, storage);

    engine.markDirty(path);
    await engine.sync({ label: "manual sync" });

    const files = storage.deltas[0].files;
    expect(files[path]).toMatchObject({ hash: expect.any(String) });
    expect(files[path]).not.toHaveProperty("deleted");
    expect(storage.uploaded).toEqual([path]);
  });

  it("NFC-normalizes basename comparison so a decomposed listing entry isn't a false tombstone", async () => {
    // On macOS/APFS a listing can surface a name in NFD (decomposed) while the tracked path is NFC.
    // Byte-exact comparison would read the file as "gone by case" and tombstone it. The guard must
    // compare NFC-normalized. "ё" is the giveaway: NFC = U+0451, NFD = "е"+U+0308.
    const nfcPath = "notes/её.md".normalize("NFC");
    const nfdListing = "notes/её.md".normalize("NFD");
    expect(nfcPath).not.toEqual(nfdListing); // sanity: the two byte-forms really differ
    const storage = new CapturingStorage();
    // On disk (stat) resolves the NFC path; the directory listing returns the NFD form.
    const engine = makeEngine(
      makeVaultCS([nfcPath], [nfdListing]),
      { lastSyncedRev: 1, files: {} },
      storage,
      /* caseInsensitiveFS */ true,
    );

    engine.markDirty(nfcPath);
    await engine.sync({ label: "manual sync" });

    const files = storage.deltas[0].files;
    expect(files[nfcPath]).not.toHaveProperty("deleted");
    expect(storage.uploaded).toEqual([nfcPath]);
  });
});

// The real-world data-loss regression (2026-08-02, vault gsd2): a case-only rename on macOS
// ("Мой Вес…" → "Мой вес…") propagated a clean rename-aware delta. An ANDROID peer (case-SENSITIVE
// filesystem) pulled the new lowercase note, then in the SAME cycle's push its case-only guard read
// the freshly-pulled file as "gone by case" — a listing gap after the rename showed the old capital
// sibling but not yet the exact lowercase name — and TOMBSTONED it. That tombstone deleted the note
// on every device. The guard must never run on a case-sensitive filesystem: stat() there is
// authoritative (the same reason git-sync needs no guard), so a live file is always re-pushed, never
// tombstoned by case.
describe("SyncEngine case-only rename on a case-sensitive filesystem (Android/Linux)", () => {
  it("does NOT tombstone a live pulled note when a case-sibling lingers in the listing", async () => {
    const live = "health/Мой вес за всё время.md"; // freshly pulled (lowercase в), on disk
    const sibling = "health/Мой Вес за всё время.md"; // the pre-rename capital, still in a stale listing
    const storage = new CapturingStorage();
    // Disk holds only the live lowercase note; the directory listing still shows the capital sibling
    // and NOT the exact lowercase name — the exact gap that fired the guard on Android.
    const engine = makeEngine(
      makeVaultCS([live], [sibling]),
      { lastSyncedRev: 5, files: { [live]: { hash: "old", mtime: "t" } } },
      storage,
      /* caseInsensitiveFS */ false,
    );

    engine.markDirty(live);
    await engine.sync({ label: "poll" });

    const files = storage.deltas[0].files;
    // The live note is re-pushed (harmless), NOT tombstoned. This is the whole fix.
    expect(files[live]).not.toHaveProperty("deleted");
    expect(files[live]).toMatchObject({ hash: expect.any(String) });
    expect(storage.uploaded).toEqual([live]);
    // And under no circumstance is a delete emitted for it.
    expect(files[live]?.deleted).toBeUndefined();
  });
});
