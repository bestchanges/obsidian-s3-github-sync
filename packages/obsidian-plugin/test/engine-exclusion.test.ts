import { describe, expect, it } from "vitest";
import type { StorageAdapter } from "@vault-sync/core";
import { SyncEngine, type SyncState } from "../src/engine";

const SELF_DIR = ".obsidian/plugins/vault-s3-sync";

// isExcluded touches neither the vault nor storage, so trivial stubs are enough.
function makeEngine() {
  const state: SyncState = { lastSyncedRev: 0, files: {} };
  return new SyncEngine({} as never, {} as StorageAdapter, state, {
    deviceId: "dev",
    selfDir: SELF_DIR,
    excludedFolders: [],
    concurrency: 1,
    maxDownloadBytes: 0,
    verbose: false,
    log: () => {},
    onStateChanged: async () => {},
  });
}

describe("isExcluded — per-device plugin files", () => {
  const engine = makeEngine();

  it("holds the log file and its rotation backup out of sync", () => {
    expect(engine.isExcluded(`${SELF_DIR}/sync.log`)).toBe(true);
    expect(engine.isExcluded(`${SELF_DIR}/sync.log.1`)).toBe(true);
  });

  it("still holds back creds and per-device state", () => {
    expect(engine.isExcluded(`${SELF_DIR}/data.json`)).toBe(true);
    expect(engine.isExcluded(`${SELF_DIR}/state.json.gz`)).toBe(true);
  });

  it("holds back the unsynced-work snapshot (§4.4a)", () => {
    // The plugin dir otherwise syncs (self-deploy channel), so one device's pending set would
    // otherwise land on every other device as ordinary vault content.
    expect(engine.isExcluded(`${SELF_DIR}/pending.json`)).toBe(true);
    // …but only ours: another plugin's pending.json is just a file.
    expect(engine.isExcluded(".obsidian/plugins/other/pending.json")).toBe(false);
  });

  it("does not exclude a sync.log living outside our own plugin dir", () => {
    // Another plugin's file that happens to share the basename must still sync.
    expect(engine.isExcluded(".obsidian/plugins/other/sync.log")).toBe(false);
    expect(engine.isExcluded("Notes/sync.log")).toBe(false);
  });
});
