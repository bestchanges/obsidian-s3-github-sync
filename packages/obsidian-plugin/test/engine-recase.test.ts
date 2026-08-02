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

function makeEngine(vault: any, storage: StorageAdapter, state: SyncState): SyncEngine {
  return new SyncEngine(vault, storage, state, {
    deviceId: "dev-android",
    selfDir: ".obsidian/plugins/vault-s3-sync",
    excludedFolders: [],
    concurrency: 4,
    maxDownloadBytes: 0,
    verbose: false,
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
});
