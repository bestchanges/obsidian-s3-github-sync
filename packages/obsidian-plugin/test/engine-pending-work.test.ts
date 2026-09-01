import { describe, expect, it } from "vitest";
import { InMemoryStorage, type StorageAdapter } from "@vault-sync/core";
import { SyncEngine, SyncState, type PendingWork } from "../src/engine";

/** `pendingWork()` / `seedPending()` exist to close a real data-loss path (§4.4a).
 *
 * 2026-08-25, linux-stkv: a note and three photos were created in the app while the device was
 * offline. Every push failed (`TypeError: Failed to fetch`, ~80 in a row), the app was killed, and
 * the dirty set — which lived only in RAM — went with it. Mobile runs no startup offline scan by
 * design, so nothing rediscovered them. Eleven launches over seven days pulled happily and never
 * pushed those files; they reached S3 only after a manual "Scan for external changes" on 09-01. */

const OFFLINE = "health/events/2026/2026-08-25 МРТ правого колена и ортопед.md";
const PHOTO = "health/events/2026/_files/IMG20260825180131.jpg";

/** Storage whose every network op rejects the way an offline device's fetch does. */
class OfflineStorage implements StorageAdapter {
  list = async (): Promise<never> => {
    throw new TypeError("Failed to fetch");
  };
  head = async (): Promise<never> => {
    throw new TypeError("Failed to fetch");
  };
  get = async (): Promise<never> => {
    throw new TypeError("Failed to fetch");
  };
  put = async (): Promise<never> => {
    throw new TypeError("Failed to fetch");
  };
  delete = async (): Promise<never> => {
    throw new TypeError("Failed to fetch");
  };
}

function makeVault(files: Record<string, string>): any {
  const enc = new TextEncoder();
  return {
    configDir: ".obsidian",
    getFiles: () => Object.keys(files).map((path) => ({ path, stat: { mtime: 1_000 } })),
    adapter: {
      list: async () => ({ files: [], folders: [] }),
      stat: async (p: string) =>
        p in files ? { type: "file", mtime: 1_000, size: files[p].length } : null,
      readBinary: async (p: string) => enc.encode(files[p]).buffer,
      writeBinary: async () => {},
      exists: async (p: string) => p in files,
      mkdir: async () => {},
      remove: async () => {},
    },
  };
}

function makeEngine(vault: any, storage: StorageAdapter, state: SyncState, excluded: string[] = []) {
  return new SyncEngine(vault, storage, state, {
    deviceId: "linux-stkv",
    log: () => {},
    selfDir: ".obsidian/plugins/vault-s3-sync",
    excludedFolders: excluded,
    maxDownloadBytes: 0,
    concurrency: 4,
    verbose: false,
    onStateChanged: async () => {},
  });
}

describe("pending work survives the process", () => {
  it("reports paths marked dirty, and renames, as pending", () => {
    const engine = makeEngine(makeVault({ [OFFLINE]: "mri\n" }), new OfflineStorage(), {
      lastSyncedRev: 0,
      files: {},
    });
    engine.markDirty(OFFLINE);
    engine.recordRename("old.md", "new.md");

    const work = engine.pendingWork();
    expect(work.dirty).toContain(OFFLINE);
    expect(work.renames).toEqual([["old.md", "new.md"]]);
  });

  it("hands the snapshot back on seed, filtered by the CURRENT exclusion rules", () => {
    const engine = makeEngine(
      makeVault({}),
      new OfflineStorage(),
      { lastSyncedRev: 0, files: {} },
      ["health"], // excluded since the snapshot was taken
    );
    engine.seedPending({ dirty: [OFFLINE, "diary/2026-08-25.md"], renames: [] });

    // The excluded path must not be resurrected by a stale snapshot.
    expect(engine.pendingWork().dirty).toEqual(["diary/2026-08-25.md"]);
  });

  it("keeps the marks when the whole cycle fails offline, so the snapshot still has them", async () => {
    const vault = makeVault({ [OFFLINE]: "mri\n", [PHOTO]: "jpegbytes" });
    const engine = makeEngine(vault, new OfflineStorage(), { lastSyncedRev: 0, files: {} });
    engine.markDirty(OFFLINE);
    engine.markDirty(PHOTO);

    await expect(engine.sync({ label: "debounced-edit" })).rejects.toThrow(/Failed to fetch/);

    // This is what the plugin persists. Before §4.4a it lived only here, and the app being killed
    // was the end of it.
    const snapshot: PendingWork = engine.pendingWork();
    expect(snapshot.dirty.sort()).toEqual([PHOTO, OFFLINE].sort());
  });

  it("a NEW engine seeded from that snapshot publishes the files — the 08-25 recovery", async () => {
    const vault = makeVault({ [OFFLINE]: "mri\n", [PHOTO]: "jpegbytes" });

    // Session 1: offline, everything fails, app is killed.
    const offline = makeEngine(vault, new OfflineStorage(), { lastSyncedRev: 0, files: {} });
    offline.markDirty(OFFLINE);
    offline.markDirty(PHOTO);
    await expect(offline.sync({ label: "debounced-edit" })).rejects.toThrow();
    const snapshot = offline.pendingWork();

    // Session 2: fresh process, fresh engine, network back. No vault events will fire for files
    // that already existed, and mobile runs no startup scan — the snapshot is the only thing that
    // knows these files are owed.
    const remote = new InMemoryStorage();
    const next = makeEngine(vault, remote, { lastSyncedRev: 0, files: {} });
    next.seedPending(snapshot);
    await next.sync({ label: "startup (cloud pull)" });

    expect(await remote.get(`files/${OFFLINE}`)).not.toBeNull();
    expect(await remote.get(`files/${PHOTO}`)).not.toBeNull();
    // Published and accounted for: nothing left owing.
    expect(next.pendingWork().dirty).toEqual([]);
  });

  it("without the snapshot the same session syncs cleanly and leaves the files behind", async () => {
    const vault = makeVault({ [OFFLINE]: "mri\n", [PHOTO]: "jpegbytes" });
    const remote = new InMemoryStorage();
    const next = makeEngine(vault, remote, { lastSyncedRev: 0, files: {} });

    await next.sync({ label: "startup (cloud pull)" }); // no scanOffline — mobile's launch path

    expect(await remote.get(`files/${OFFLINE}`)).toBeNull(); // the seven-day silence, reproduced
  });
});
