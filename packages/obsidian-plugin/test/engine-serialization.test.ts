import { beforeEach, describe, expect, it } from "vitest";
import type { StorageAdapter } from "@vault-sync/core";
import { SyncEngine, SyncState } from "../src/engine";
// The engine's `obsidian` import is aliased to a stub (vitest.config.ts) whose Notice records into
// this log, letting us assert the queued/started/done lifecycle.
import { noticeLog as notices } from "./obsidian-stub";

/** StorageAdapter whose list() (the first async op every cycle reaches, in pull) blocks until the
 * test releases it. That pins a cycle mid-flight so we can probe what concurrent requests do, and
 * listCalls == the number of cycles that actually started reconciling. Everything else no-ops, so
 * an empty vault + empty storage means each cycle does one list, one head, then finishes. */
class GatedStorage implements StorageAdapter {
  listCalls = 0;
  private gates: Array<() => void> = [];
  private failNext = 0;

  failOnce(): void {
    this.failNext += 1;
  }
  get pending(): number {
    return this.gates.length;
  }
  releaseOne(): void {
    this.gates.shift()?.();
  }

  list = async (): Promise<never[]> => {
    this.listCalls += 1;
    await new Promise<void>((res) => this.gates.push(res));
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("boom");
    }
    return [];
  };
  head = async (): Promise<null> => null;
  get = async (): Promise<null> => null;
  put = async (): Promise<{ etag: string; versionId: string }> => ({ etag: "e", versionId: "v" });
  delete = async (): Promise<void> => {};
}

/** Minimal Vault: an empty vault whose config dir lists empty. Enough to drive a full cycle
 * (scan → pull → push) without touching disk. */
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

function makeEngine(state: SyncState, storage: GatedStorage) {
  const persisted: SyncState[] = [];
  const engine = new SyncEngine(makeVault(), storage as unknown as StorageAdapter, state, {
    deviceId: "dev-test",
    selfDir: ".obsidian/plugins/vault-s3-sync",
    excludedFolders: [],
    concurrency: 4,
    maxDownloadBytes: 0,
    verbose: true, // fire notices for non-forced (poll/edit) cycles too, so we can assert them
    onStateChanged: async (s) => {
      persisted.push(s);
    },
  });
  return { engine, persisted };
}

/** Flush pending microtasks (plus one macrotask, for safety) so a released cycle can run to its
 * next gate. The empty-vault path uses no real timers, so microtask draining is sufficient. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe("SyncEngine serialization", () => {
  beforeEach(() => {
    notices.length = 0;
  });

  it("runs one cycle at a time and coalesces concurrent requests into a single follow-up", async () => {
    const storage = new GatedStorage();
    const { engine } = makeEngine({ lastSyncedRev: 0, files: {} }, storage);

    // Cycle A starts and blocks at its list().
    const pA = engine.sync({ scanConfig: true, label: "poll" });
    await settle();
    expect(storage.listCalls).toBe(1);
    expect(storage.pending).toBe(1);

    // Two more requests arrive while A holds the lock — neither may start.
    const pB = engine.sync({ label: "edit save" });
    const pC = engine.sync({ scanConfig: true, label: "poll" });
    await settle();
    expect(storage.listCalls).toBe(1); // still just A running — no concurrency

    // Only the first queuer announces the wait; the rest coalesce silently.
    expect(notices.filter((n) => n.includes("queued")).length).toBe(1);

    // Releasing A lets exactly ONE coalesced follow-up run (not one per queued request).
    storage.releaseOne();
    await settle();
    expect(storage.listCalls).toBe(2);
    expect(storage.pending).toBe(1);

    storage.releaseOne();
    await settle();
    await expect(Promise.all([pA, pB, pC])).resolves.toBeDefined();
    expect(storage.listCalls).toBe(2); // no extra cycles after everything drained
  });

  it("a resync requested mid-cycle queues behind the running cycle, then actually runs and resets state", async () => {
    const storage = new GatedStorage();
    // Seed non-trivial state so we can prove the resync's reset took effect (and didn't run early).
    const state: SyncState = { lastSyncedRev: 5, files: { "old.md": { hash: "h", mtime: "t" } } };
    const { engine, persisted } = makeEngine(state, storage);

    const pPoll = engine.sync({ scanConfig: true, label: "poll" });
    await settle();
    expect(storage.listCalls).toBe(1);

    const pEdit = engine.sync({ label: "edit save" });
    const pResync = engine.resyncEverything();
    await settle();

    // State must be untouched while the poll cycle owns the lock — the old bug reset it here.
    expect(state.lastSyncedRev).toBe(5);
    expect(Object.keys(state.files)).toEqual(["old.md"]);
    expect(storage.listCalls).toBe(1); // resync did NOT start concurrently

    // The mid-cycle edit and the resync both announced their wait (resync always does).
    expect(notices).toContain("Sync: queued (edit save) — a cycle is already running");
    expect(notices).toContain("Sync: queued (resync) — a cycle is already running");

    // Release the poll cycle → the coalesced follow-up runs, upgraded to a resync.
    storage.releaseOne();
    await settle();
    expect(storage.listCalls).toBe(2); // regression guard: the resync actually ran (didn't no-op)
    expect(notices).toContain("Sync: started (resync)");

    storage.releaseOne();
    await settle();
    await Promise.all([pPoll, pEdit, pResync]);

    // The resync's reset stuck: cursor cleared and file state emptied.
    expect(state.lastSyncedRev).toBe(0);
    expect(state.files).toEqual({});
    expect(notices.some((n) => n.startsWith("Sync: done (resync)"))).toBe(true);
    expect(persisted.length).toBeGreaterThan(0); // resync force-persists the reset
  });

  it("a failing cycle rejects only its own waiters; the queue keeps draining", async () => {
    const storage = new GatedStorage();
    const { engine } = makeEngine({ lastSyncedRev: 0, files: {} }, storage);
    storage.failOnce(); // the first cycle to reach list() will throw

    const pA = engine.sync({ label: "poll" });
    pA.catch(() => {}); // mark handled; we assert the rejection below
    await settle();
    expect(storage.listCalls).toBe(1);

    const pB = engine.sync({ label: "poll" });
    await settle();
    expect(storage.listCalls).toBe(1); // B queued behind A

    storage.releaseOne(); // A resumes → throws
    await settle();
    expect(storage.listCalls).toBe(2); // B still ran despite A failing

    storage.releaseOne(); // B completes
    await settle();

    await expect(pA).rejects.toThrow("boom");
    await expect(pB).resolves.toBeUndefined();
  });

  it("an idle sync starts immediately", async () => {
    const storage = new GatedStorage();
    const { engine } = makeEngine({ lastSyncedRev: 0, files: {} }, storage);

    const p = engine.sync({ label: "manual sync", announce: true });
    await settle();
    expect(storage.listCalls).toBe(1); // ran without waiting
    expect(notices).toContain("Sync: started (manual sync)");

    storage.releaseOne();
    await settle();
    await expect(p).resolves.toBeUndefined();
  });
});
