import { describe, expect, it } from "vitest";
import { contentHash, encodeJsonGz, type Delta, type StorageAdapter } from "@vault-sync/core";
import { SyncEngine, SyncState } from "../src/engine";

/** `onRemoteActivity` is what arms the ACTIVE poll tier (§4.9a), and the whole point of the hook is
 * that it fires for **remote** arrivals only.
 *
 * The regression it exists to prevent (observed 2026-08-23 on linux-5791): the tier was armed by
 * *any* movement, including our own pushes. Every cycle pulls **and** pushes, so a device that was
 * merely being typed into stayed permanently in the fast tier, and each poll shipped another copy
 * of the file being typed — 14 deltas and 14 S3 versions across 70 s of typing, where the debounce
 * alone would have produced one or two.
 */

const PATH = "note.md";

/** Remote holding exactly one delta authored by someone else, so a pull has something to apply. */
class RemoteWithOneDelta implements StorageAdapter {
  constructor(private body = "hello from a peer\n") {}
  list = async (prefix: string): Promise<{ key: string; size: number }[]> =>
    prefix.startsWith("deltas/") ? [{ key: "deltas/0000000001.json.gz", size: 100 }] : [];
  head = async (): Promise<null> => null;
  get = async (key: string): Promise<{ body: Uint8Array; versionId?: string } | null> => {
    if (key.startsWith("deltas/")) {
      const delta: Delta = {
        rev: 1,
        by: "some-other-device",
        at: new Date().toISOString(),
        files: {
          [PATH]: {
            hash: contentHash(new TextEncoder().encode(this.body)),
            size: this.body.length,
            mtime: new Date().toISOString(),
          },
        },
      };
      return { body: encodeJsonGz(delta) };
    }
    return { body: new TextEncoder().encode(this.body), versionId: "v1" };
  };
  put = async (): Promise<{ etag: string; versionId: string }> => ({ etag: "e", versionId: "v" });
  delete = async (): Promise<void> => {};
}

class EmptyRemote implements StorageAdapter {
  list = async (): Promise<never[]> => [];
  head = async (): Promise<null> => null;
  get = async (): Promise<null> => null;
  put = async (): Promise<{ etag: string; versionId: string }> => ({ etag: "e", versionId: "v" });
  delete = async (): Promise<void> => {};
}

function makeVault(localFiles: Record<string, string> = {}): any {
  const files = { ...localFiles };
  return {
    configDir: ".obsidian",
    getFiles: () => Object.keys(files).map((path) => ({ path })),
    adapter: {
      list: async () => ({ files: [], folders: [] }),
      stat: async (p: string) =>
        p in files ? { type: "file", size: files[p].length, mtime: Date.now(), ctime: Date.now() } : null,
      readBinary: async (p: string) => new TextEncoder().encode(files[p] ?? "").buffer,
      exists: async (p: string) => p in files,
      writeBinary: async (p: string, data: ArrayBuffer) => {
        files[p] = new TextDecoder().decode(data);
      },
      remove: async (p: string) => {
        delete files[p];
      },
      mkdir: async () => {},
    },
  };
}

function makeEngine(
  storage: StorageAdapter,
  vault: any,
  state: SyncState,
  onRemoteActivity: () => void,
): SyncEngine {
  return new SyncEngine(vault, storage, state, {
    deviceId: "dev-test",
    selfDir: ".obsidian/plugins/vault-s3-sync",
    excludedFolders: [],
    concurrency: 4,
    maxDownloadBytes: 0,
    verbose: false,
    log: () => {},
    onStateChanged: async () => {},
    onRemoteActivity,
  });
}

describe("onRemoteActivity — arms the ACTIVE poll tier for remote arrivals only (§4.9a)", () => {
  it("fires when a cycle pulls a peer's change", async () => {
    let fired = 0;
    const state: SyncState = { lastSyncedRev: 0, files: {} };
    const engine = makeEngine(new RemoteWithOneDelta(), makeVault(), state, () => fired++);

    await engine.sync({ label: "poll" });

    expect(fired).toBe(1);
  });

  it("does NOT fire for a push-only cycle — the typing regression", async () => {
    let fired = 0;
    const state: SyncState = { lastSyncedRev: 0, files: {} };
    const vault = makeVault({ [PATH]: "something I just typed\n" });
    const engine = makeEngine(new EmptyRemote(), vault, state, () => fired++);

    engine.markDirty(PATH);
    await engine.sync({ label: "poll" });

    // The cycle pushed (that is the point), but nothing arrived from anywhere else — so the fast
    // tier must stay disarmed. Arming it here is what made each poll re-push the file being typed.
    expect(fired).toBe(0);
  });

  it("does not fire for a cycle that transferred nothing at all", async () => {
    let fired = 0;
    const state: SyncState = { lastSyncedRev: 0, files: {} };
    const engine = makeEngine(new EmptyRemote(), makeVault(), state, () => fired++);

    await engine.sync({ label: "poll" });

    expect(fired).toBe(0);
  });

  it("is optional — an engine built without the hook still cycles", async () => {
    const state: SyncState = { lastSyncedRev: 0, files: {} };
    const engine = new SyncEngine(makeVault(), new RemoteWithOneDelta(), state, {
      deviceId: "dev-test",
      selfDir: ".obsidian/plugins/vault-s3-sync",
      excludedFolders: [],
      concurrency: 4,
      maxDownloadBytes: 0,
      verbose: false,
      log: () => {},
      onStateChanged: async () => {},
      // onRemoteActivity deliberately omitted
    });

    await expect(engine.sync({ label: "poll" })).resolves.toBeUndefined();
  });
});
