import { describe, expect, it } from "vitest";
import {
  contentHash,
  Delta,
  deltaKey,
  encodeJsonGz,
  InMemoryStorage,
  StorageAdapter,
} from "@vault-sync/core";
import { SyncEngine, SyncState } from "../src/engine";

// Display-case / NFC propagation: when another device makes a case-only rename, a case-INSENSITIVE
// peer must end up showing the WINNING name — not keep the old-cased file forever. core collapses the
// rename to one live node; applyRemote then renames the local on-disk file to the winning case (a pure
// rename, never a delete). The whole point of the earlier fix is that the note is never lost; this
// test guards that the *name* also converges without re-losing it.

const enc = (s: string) => new TextEncoder().encode(s);

/** Case-INSENSITIVE vault (macOS/Android storage): any case-variant of an on-disk path resolves to
 * the same file. `rename` re-cases (or moves) the single disk entry. */
function ciVault(disk: Map<string, Uint8Array>): any {
  const find = (p: string) => [...disk.keys()].find((k) => k.toLowerCase() === p.toLowerCase());
  return {
    configDir: ".obsidian",
    getFiles: () => [...disk.keys()].map((p) => ({ path: p, stat: { mtime: 1 } })),
    adapter: {
      stat: async (p: string) => {
        const k = find(p);
        return k ? { type: "file", mtime: 1, size: disk.get(k)!.byteLength, ctime: 1 } : null;
      },
      readBinary: async (p: string) => {
        const b = disk.get(find(p) ?? p) ?? new Uint8Array(0);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
      writeBinary: async (p: string, data: ArrayBuffer) => {
        const k = find(p);
        if (k) disk.delete(k);
        disk.set(p, new Uint8Array(data));
      },
      rename: async (from: string, to: string) => {
        const k = find(from);
        if (!k) throw new Error(`rename: no source ${from}`);
        const b = disk.get(k)!;
        disk.delete(k);
        disk.set(to, b); // re-cased name, same bytes
      },
      remove: async (p: string) => {
        const k = find(p);
        if (k) disk.delete(k);
      },
      exists: async (p: string) => !!find(p),
      list: async () => ({ files: [], folders: [] }),
      mkdir: async () => {},
    },
  };
}

function makeEngine(
  vault: any,
  storage: StorageAdapter,
  state: SyncState,
  renameFile?: (from: string, to: string) => Promise<boolean>,
): SyncEngine {
  return new SyncEngine(vault, storage, state, {
    deviceId: "dev-android",
    selfDir: ".obsidian/plugins/vault-s3-sync",
    excludedFolders: [],
    concurrency: 4,
    maxDownloadBytes: 0,
    verbose: false,
    renameFile,
    log: () => {},
    onStateChanged: async () => {},
  });
}

describe("SyncEngine display-case propagation", () => {
  it("re-cases the local file when a peer's case-only rename is pulled (no loss, name converges)", async () => {
    const content = "alpha";
    const hash = contentHash(enc(content));
    const storage = new InMemoryStorage();
    // A peer renamed AAA.md → aaa.md (content unchanged): one delta, delete(old)+add(new).
    const delta: Delta = {
      rev: 1,
      by: "peer-mac",
      at: "2026-08-02T00:00:00Z",
      files: {
        "_synctest/AAA.md": { deleted: true, renamedTo: "_synctest/aaa.md" },
        "_synctest/aaa.md": { hash, size: content.length, mtime: "2026-08-02T00:00:00Z" },
      },
    };
    await storage.put(deltaKey(1), encodeJsonGz(delta));

    // This device already had the old-cased note on disk and in state.
    const disk = new Map<string, Uint8Array>([["_synctest/AAA.md", enc(content)]]);
    const state: SyncState = { lastSyncedRev: 0, files: { "_synctest/AAA.md": { hash, mtime: "t" } } };
    const engine = makeEngine(ciVault(disk), storage, state);

    await engine.sync({ label: "poll" });

    // The on-disk file is now the winning case, and it's the ONLY copy (no duplicate, nothing lost).
    expect([...disk.keys()]).toEqual(["_synctest/aaa.md"]);
    expect(new TextDecoder().decode(disk.get("_synctest/aaa.md"))).toBe(content);
    // State migrated to the winning name; the old-cased entry is gone.
    expect(state.files["_synctest/aaa.md"]).toBeTruthy();
    expect(state.files["_synctest/AAA.md"]).toBeUndefined();
    // No new delta was pushed (the re-case is echo-suppressed, not a user edit).
    const deltas = await storage.list("deltas/");
    expect(deltas.map((d) => d.key)).toEqual([deltaKey(1)]);
  });

  it("re-cases via Obsidian's rename API when the raw adapter can't (mobile case-only rename)", async () => {
    // On mobile the storage adapter rejects a case-only rename, so the engine must go through the
    // injected Obsidian rename (fileManager.renameFile) — which re-cases there and refreshes the UI.
    // Model that: adapter.rename THROWS, but the renameFile callback succeeds.
    const content = "alpha";
    const hash = contentHash(enc(content));
    const storage = new InMemoryStorage();
    const delta: Delta = {
      rev: 1,
      by: "peer-mac",
      at: "2026-08-03T00:00:00Z",
      files: {
        "_synctest/aaa.md": { deleted: true, renamedTo: "_synctest/aaA.md" },
        "_synctest/aaA.md": { hash, size: content.length, mtime: "2026-08-03T00:00:00Z" },
      },
    };
    await storage.put(deltaKey(1), encodeJsonGz(delta));

    const disk = new Map<string, Uint8Array>([["_synctest/aaa.md", enc(content)]]);
    const vault = ciVault(disk);
    vault.adapter.rename = async () => {
      throw new Error("EEXIST: case-only rename rejected (mobile FS)");
    };
    let calledWith: [string, string] | null = null;
    const renameFile = async (from: string, to: string): Promise<boolean> => {
      calledWith = [from, to];
      const b = disk.get(from)!; // Obsidian's rename succeeds where the adapter couldn't
      disk.delete(from);
      disk.set(to, b);
      return true;
    };
    const state: SyncState = { lastSyncedRev: 0, files: { "_synctest/aaa.md": { hash, mtime: "t" } } };
    const engine = makeEngine(vault, storage, state, renameFile);

    await engine.sync({ label: "poll" });

    expect(calledWith).toEqual(["_synctest/aaa.md", "_synctest/aaA.md"]); // used Obsidian's API
    expect([...disk.keys()]).toEqual(["_synctest/aaA.md"]); // re-cased despite adapter failure
    expect(state.files["_synctest/aaA.md"]).toBeTruthy();
    expect(await storage.list("deltas/")).toHaveLength(1); // no echo push
  });

  it("offline scan does NOT tombstone a note that's present under a different case (the Mac Mini bug)", async () => {
    // Reproduces rev 4368: a device whose STATE tracks `aaa.md` but whose DISK holds `AAA.md` (a case
    // mismatch left by pulling the rename under old code). The offline scan used exact-case set
    // membership, so `aaa.md` looked "missing" and got tombstoned — deleting the live note on every
    // peer. It must recognize the file is present (canonically) and never tombstone it.
    const content = "alpha";
    const hash = contentHash(enc(content));
    const storage = new InMemoryStorage(); // no deltas → pull is inert; only the offline scan runs
    const disk = new Map<string, Uint8Array>([["_synctest/AAA.md", enc(content)]]); // wrong case on disk
    const state: SyncState = { lastSyncedRev: 0, files: { "_synctest/aaa.md": { hash, mtime: "t" } } };
    const engine = makeEngine(ciVault(disk), storage, state);

    await engine.sync({ label: "startup", scanOffline: true });

    // Nothing was pushed — no tombstone for a note that's still here (just under a different case).
    expect(await storage.list("deltas/")).toEqual([]);
    // Reconciled to the tracked name, still exactly one copy, content intact.
    expect([...disk.keys()]).toEqual(["_synctest/aaa.md"]);
    expect(new TextDecoder().decode(disk.get("_synctest/aaa.md"))).toBe(content);
    expect(state.files["_synctest/aaa.md"]).toBeTruthy();
  });
});
