import { describe, expect, it } from "vitest";
import type { ObjectInfo, StorageAdapter } from "@vault-sync/core";
import { SyncLogger, type LogDiskAdapter } from "../src/logger";

const LOG_PATH = ".obsidian/plugins/vault-s3-sync/sync.log";
const BACKUP = LOG_PATH + ".1";

/** In-memory disk backing the logger. stat().size is the byte length of the stored string. */
function makeDisk(): { files: Map<string, string>; adapter: LogDiskAdapter } {
  const files = new Map<string, string>();
  const adapter: LogDiskAdapter = {
    append: async (p, d) => void files.set(p, (files.get(p) ?? "") + d),
    write: async (p, d) => void files.set(p, d),
    read: async (p) => files.get(p) ?? "",
    exists: async (p) => files.has(p),
    stat: async (p) => (files.has(p) ? { size: files.get(p)!.length } : null),
    remove: async (p) => void files.delete(p),
    rename: async (from, to) => {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
  };
  return { files, adapter };
}

/** Records puts/deletes; list() returns whatever was seeded. */
class FakeStorage implements StorageAdapter {
  readonly puts: { key: string; body: Uint8Array }[] = [];
  readonly deletes: string[] = [];
  private objects = new Map<string, { body: Uint8Array; lastModified?: Date }>();

  seed(key: string, text: string, lastModified?: Date): void {
    this.objects.set(key, { body: new TextEncoder().encode(text), lastModified });
  }
  get = async (key: string) => {
    const o = this.objects.get(key);
    return o ? { body: o.body } : null;
  };
  head = async () => null;
  put = async (key: string, body: Uint8Array) => {
    this.puts.push({ key, body });
    this.objects.set(key, { body });
    return {};
  };
  list = async (prefix: string): Promise<ObjectInfo[]> =>
    [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, o]) => ({ key, lastModified: o.lastModified }));
  delete = async (key: string) => {
    this.deletes.push(key);
    this.objects.delete(key);
  };
}

function makeLogger(enabled = true) {
  const { files, adapter } = makeDisk();
  const logger = new SyncLogger({ adapter, logPath: LOG_PATH, enabled: () => enabled });
  return { files, logger };
}

describe("SyncLogger", () => {
  it("writes nothing to disk when disabled", async () => {
    const { files, logger } = makeLogger(false);
    logger.info("hello");
    logger.error("boom", new Error("x"));
    await logger.flush();
    expect(files.size).toBe(0);
  });

  it("appends timestamped, leveled lines when enabled", async () => {
    const { files, logger } = makeLogger();
    logger.info("started");
    logger.warn("careful");
    logger.error("failed", new Error("nope"));
    await logger.flush();
    const text = files.get(LOG_PATH)!;
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z INFO {2}started$/);
    expect(lines[1]).toContain("WARN  careful");
    expect(lines[2]).toContain("ERROR failed: Error: nope");
  });

  it("rotates the active file to .1 once it exceeds the cap, then starts fresh", async () => {
    const { files, logger } = makeLogger();
    logger.info("x".repeat(600 * 1024)); // one line over the 512 KB cap
    await logger.flush();
    expect(files.has(BACKUP)).toBe(true);
    expect(files.has(LOG_PATH)).toBe(false); // rolled away, no fresh active yet

    logger.info("after-rotate");
    await logger.flush();
    expect(files.has(LOG_PATH)).toBe(true);
    expect(files.get(LOG_PATH)).toContain("after-rotate");
  });

  it("tail() concatenates backup + active, newest content last", async () => {
    const { logger } = makeLogger();
    logger.info("x".repeat(600 * 1024));
    await logger.flush(); // rotates → backup
    logger.info("newest-line");
    await logger.flush();
    const tail = await logger.tail();
    expect(tail).toContain("newest-line");
    expect(tail.indexOf("newest-line")).toBeGreaterThan(0);
  });

  it("uploadIfDirty ships to _logs/<deviceId>.log only when there is new content", async () => {
    const { logger } = makeLogger();
    const storage = new FakeStorage();
    logger.setRemote(storage, "laptop-a1b2");

    await logger.uploadIfDirty(); // nothing logged yet → no PUT
    expect(storage.puts).toHaveLength(0);

    logger.info("event");
    await logger.uploadIfDirty();
    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0].key).toBe("_logs/laptop-a1b2.log");
    expect(new TextDecoder().decode(storage.puts[0].body)).toContain("event");

    await logger.uploadIfDirty(); // no new content → no second PUT
    expect(storage.puts).toHaveLength(1);
  });

  it("does not upload when disabled or unwired", async () => {
    const { logger } = makeLogger(false);
    const storage = new FakeStorage();
    logger.setRemote(storage, "dev");
    logger.info("ignored");
    await logger.uploadIfDirty();
    expect(storage.puts).toHaveLength(0);
  });

  it("listRemoteDevices parses keys and sorts newest first", async () => {
    const { logger } = makeLogger();
    const storage = new FakeStorage();
    storage.seed("_logs/old.log", "a", new Date("2026-01-01"));
    storage.seed("_logs/new.log", "b", new Date("2026-06-01"));
    logger.setRemote(storage, "self");
    const devices = await logger.listRemoteDevices();
    expect(devices.map((d) => d.deviceId)).toEqual(["new", "old"]);
  });

  it("readRemote decodes another device's log", async () => {
    const { logger } = makeLogger();
    const storage = new FakeStorage();
    storage.seed("_logs/phone.log", "phone log body");
    logger.setRemote(storage, "self");
    expect(await logger.readRemote("phone")).toBe("phone log body");
    expect(await logger.readRemote("missing")).toBe("");
  });

  it("clear removes local files and this device's remote object only", async () => {
    const { files, logger } = makeLogger();
    const storage = new FakeStorage();
    logger.setRemote(storage, "me");
    logger.info("line");
    await logger.flush();
    expect(files.has(LOG_PATH)).toBe(true);

    await logger.clear();
    expect(files.has(LOG_PATH)).toBe(false);
    expect(files.has(BACKUP)).toBe(false);
    expect(storage.deletes).toEqual(["_logs/me.log"]);
  });
});
