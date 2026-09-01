import { describe, expect, it } from "vitest";
import type { StorageAdapter } from "@vault-sync/core";
import { SyncEngine, SyncState } from "../src/engine";

/** `busySince()` / `idle()` are the engine half of the poll loop's busy guard (§4.9a): the loop
 * asks whether a cycle newer than its tick is in flight, and parks until the engine is free rather
 * than queueing a duplicate. */

/** Empty remote whose LIST can be held open, so a cycle can be pinned mid-flight. */
class GatedRemote implements StorageAdapter {
  private release: (() => void) | null = null;
  /** Resolves once a cycle has entered list() and is waiting on the gate. */
  entered!: Promise<void>;
  private markEntered!: () => void;

  constructor(private gated = false) {
    this.entered = new Promise<void>((r) => (this.markEntered = r));
  }
  list = async (): Promise<never[]> => {
    if (this.gated) {
      this.markEntered();
      await new Promise<void>((r) => (this.release = r));
      this.gated = false;
    }
    return [];
  };
  head = async (): Promise<null> => null;
  get = async (): Promise<null> => null;
  put = async (): Promise<{ etag: string; versionId: string }> => ({ etag: "e", versionId: "v" });
  delete = async (): Promise<void> => {};
  open(): void {
    this.release?.();
  }
}

function makeVault(): any {
  return {
    configDir: ".obsidian",
    getFiles: () => [],
    adapter: {
      list: async () => ({ files: [], folders: [] }),
      stat: async () => null,
      readBinary: async () => new ArrayBuffer(0),
      writeBinary: async () => {},
      exists: async () => false,
      mkdir: async () => {},
      remove: async () => {},
    },
  };
}

function makeEngine(remote: StorageAdapter): SyncEngine {
  const state: SyncState = { lastSyncedRev: 0, files: {} };
  return new SyncEngine(makeVault(), remote, state, {
    deviceId: "test-device",
    log: () => {},
    selfDir: ".obsidian/plugins/vault-s3-sync",
    excludedFolders: [],
    maxDownloadBytes: 0,
    concurrency: 4,
    verbose: false,
    onStateChanged: async () => {},
  });
}

describe("engine busy/idle introspection", () => {
  it("reports idle before and after a cycle, and busy during one", async () => {
    const remote = new GatedRemote(true);
    const engine = makeEngine(remote);
    expect(engine.busySince()).toBeNull();

    const cycle = engine.sync({ label: "poll" });
    await remote.entered;
    const busySince = engine.busySince();
    expect(busySince).not.toBeNull();
    expect(busySince).toBeLessThanOrEqual(Date.now());

    remote.open();
    await cycle;
    expect(engine.busySince()).toBeNull();
  });

  it("idle() resolves immediately when no cycle is running", async () => {
    const engine = makeEngine(new GatedRemote(false));
    let settled = false;
    void engine.idle().then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  it("idle() waits for the running cycle and does NOT enqueue one of its own", async () => {
    const remote = new GatedRemote(true);
    const engine = makeEngine(remote);
    const cycle = engine.sync({ label: "edit save" });
    await remote.entered;

    let settled = false;
    const parked = engine.idle().then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false); // still parked while the cycle runs

    remote.open();
    await cycle;
    await parked;
    expect(settled).toBe(true);
    // Parking is passive: the engine is free afterwards, not running a cycle idle() requested.
    expect(engine.busySince()).toBeNull();
  });

  it("a cycle queued behind a running one still runs — the guard never drops requested work", async () => {
    const remote = new GatedRemote(true);
    const engine = makeEngine(remote);
    const first = engine.sync({ label: "edit save" });
    await remote.entered;
    // This is the path a tick takes when the running cycle is OLDER than it: request, don't skip.
    const second = engine.sync({ label: "poll" });
    remote.open();
    await Promise.all([first, second]);
    expect(engine.busySince()).toBeNull();
  });
});
