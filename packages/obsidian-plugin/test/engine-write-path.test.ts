import { describe, expect, it } from "vitest";
import { contentHash, encodeJsonGz, type Delta, type StorageAdapter } from "@vault-sync/core";
import { SyncEngine, SyncState } from "../src/engine";

/** Pulled notes must be written through Obsidian's Vault API, not the raw adapter (§4.8).
 *
 * The adapter puts bytes on disk but tells Obsidian nothing, so a note open in an editor keeps its
 * stale buffer: it shows old text, and when Obsidian later saves that buffer it lands back on disk
 * as a plausible "local edit" — which the engine publishes, reverting the note everywhere. That is
 * the 2026-08-23 `linux-stkv` rollback: rev 6255 republished two-hour-old content over rev 6254 and
 * cost two paragraphs on every device.
 *
 * The engine can't call the Vault itself (core stays platform-free and `obsidian` is types-only in
 * tests), so the write is injected — same shape as `renameFile`, which exists for the same reason.
 */

const NOTE = "diary/2026/2026-08-22.md";
const BODY = "fresh content from a peer\n";

class RemoteWithNote implements StorageAdapter {
  list = async (prefix: string): Promise<{ key: string; size: number }[]> =>
    prefix.startsWith("deltas/") ? [{ key: "deltas/0000000001.json.gz", size: 100 }] : [];
  head = async (): Promise<null> => null;
  get = async (key: string): Promise<{ body: Uint8Array; versionId?: string } | null> => {
    if (key.startsWith("deltas/")) {
      const delta: Delta = {
        rev: 1,
        by: "peer",
        at: new Date().toISOString(),
        files: {
          [NOTE]: {
            hash: contentHash(new TextEncoder().encode(BODY)),
            size: BODY.length,
            mtime: new Date().toISOString(),
          },
        },
      };
      return { body: encodeJsonGz(delta) };
    }
    return { body: new TextEncoder().encode(BODY), versionId: "v1" };
  };
  put = async (): Promise<{ etag: string; versionId: string }> => ({ etag: "e", versionId: "v" });
  delete = async (): Promise<void> => {};
}

function makeVault(adapterWrites: string[]): any {
  return {
    configDir: ".obsidian",
    getFiles: () => [],
    adapter: {
      list: async () => ({ files: [], folders: [] }),
      stat: async () => null,
      readBinary: async () => new ArrayBuffer(0),
      exists: async () => false,
      writeBinary: async (p: string) => {
        adapterWrites.push(p);
      },
      remove: async () => {},
      mkdir: async () => {},
    },
  };
}

function makeEngine(
  vault: any,
  writeFile?: (path: string, data: Uint8Array, mtimeMs: number) => Promise<boolean>,
): SyncEngine {
  const state: SyncState = { lastSyncedRev: 0, files: {} };
  return new SyncEngine(vault, new RemoteWithNote() as unknown as StorageAdapter, state, {
    deviceId: "dev-test",
    selfDir: ".obsidian/plugins/vault-s3-sync",
    excludedFolders: [],
    concurrency: 4,
    maxDownloadBytes: 0,
    verbose: false,
    log: () => {},
    onStateChanged: async () => {},
    writeFile,
  });
}

describe("pulled notes are written through the Vault API (§4.8)", () => {
  it("uses the injected Vault write and does NOT touch the raw adapter", async () => {
    const adapterWrites: string[] = [];
    const vaultWrites: Array<{ path: string; body: string; mtimeMs: number }> = [];

    await makeEngine(makeVault(adapterWrites), async (path, data, mtimeMs) => {
      vaultWrites.push({ path, body: new TextDecoder().decode(data), mtimeMs });
      return true;
    }).sync({ label: "poll" });

    expect(vaultWrites).toHaveLength(1);
    expect(vaultWrites[0].path).toBe(NOTE);
    expect(vaultWrites[0].body).toBe(BODY);
    // The manifest's mtime still rides along, so sort-by-modified stays consistent across devices.
    expect(vaultWrites[0].mtimeMs).toBeGreaterThan(0);
    expect(adapterWrites).toEqual([]);
  });

  it("falls back to the adapter when the path isn't in the vault index (config files)", async () => {
    const adapterWrites: string[] = [];

    await makeEngine(makeVault(adapterWrites), async () => false).sync({ label: "poll" });

    expect(adapterWrites).toEqual([NOTE]);
  });

  it("falls back to the adapter when the Vault write throws — bytes on disk beat a fresh UI", async () => {
    const adapterWrites: string[] = [];

    await makeEngine(makeVault(adapterWrites), async () => {
      throw new Error("vault refused");
    }).sync({ label: "poll" });

    expect(adapterWrites).toEqual([NOTE]);
  });

  it("still works with no hook injected at all", async () => {
    const adapterWrites: string[] = [];

    await makeEngine(makeVault(adapterWrites)).sync({ label: "poll" });

    expect(adapterWrites).toEqual([NOTE]);
  });
});
