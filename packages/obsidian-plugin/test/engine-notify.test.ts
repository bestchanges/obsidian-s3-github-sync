import { beforeEach, describe, expect, it } from "vitest";
import type { StorageAdapter } from "@vault-sync/core";
import { SyncEngine, SyncState } from "../src/engine";
// The engine's `obsidian` import is aliased to a stub (vitest.config.ts) whose Notice records here.
import { noticeLog as notices } from "./obsidian-stub";

/** Empty remote: every cycle runs start → pull → push → done and transfers nothing, which is exactly
 * the case that used to leave "Sync now" with no visible outcome at all. */
class EmptyStorage implements StorageAdapter {
  list = async (): Promise<never[]> => [];
  head = async (): Promise<null> => null;
  get = async (): Promise<null> => null;
  put = async (): Promise<{ etag: string; versionId: string }> => ({ etag: "e", versionId: "v" });
  delete = async (): Promise<void> => {};
}

function makeVault(): any {
  return {
    configDir: ".obsidian",
    getFiles: () => [],
    adapter: {
      list: async () => ({ files: [], folders: [] }),
      stat: async () => null,
      readBinary: async () => new ArrayBuffer(0),
      exists: async () => false,
      writeBinary: async () => {},
      remove: async () => {},
      mkdir: async () => {},
    },
  };
}

/** verbose:false — the default, and the setting under which manual sync was silent. */
function makeEngine(): SyncEngine {
  const state: SyncState = { lastSyncedRev: 0, files: {} };
  return new SyncEngine(makeVault(), new EmptyStorage() as unknown as StorageAdapter, state, {
    deviceId: "dev-test",
    selfDir: ".obsidian/plugins/vault-s3-sync",
    excludedFolders: [],
    concurrency: 4,
    maxDownloadBytes: 0,
    verbose: false,
    log: () => {},
    onStateChanged: async () => {},
  });
}

describe("SyncEngine notices with verbose off", () => {
  beforeEach(() => {
    notices.length = 0;
  });

  it("a forced cycle (\"Sync now\") always reports start and finish", async () => {
    await makeEngine().sync({ scanConfig: true, label: "manual sync", announce: true, force: true });

    expect(notices).toEqual([
      "Sync: started (manual sync)",
      "Sync: done (manual sync) ↓0 ↑0",
    ]);
  });

  it("an unforced cycle that transferred nothing stays silent (polls must not toast)", async () => {
    await makeEngine().sync({ scanConfig: true, label: "poll" });

    expect(notices).toEqual([]);
  });

  it("a forced cycle queued behind a running one still tells the user it was queued", async () => {
    const engine = makeEngine();
    const first = engine.sync({ label: "poll" }); // holds the lock
    const manual = engine.sync({ label: "manual sync", announce: true, force: true });
    await Promise.all([first, manual]);

    expect(notices.some((n) => n.includes("queued (manual sync)"))).toBe(true);
    expect(notices.some((n) => n.startsWith("Sync: done"))).toBe(true);
  });
});
