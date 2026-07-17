import { describe, expect, it } from "vitest";
import {
  appendDelta,
  InMemoryStorage,
  isTombstone,
  listDeltasSince,
  type Delta,
} from "@vault-sync/core";
import { FILES_PREFIX, isSafeVaultPath, PathError, VaultClient, WRITER_ID } from "../src/vault";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function setup() {
  const storage = new InMemoryStorage();
  return { storage, vault: new VaultClient(storage) };
}

/** Seed a delta as another client would (file object first, then journal entry). */
async function foreignWrite(storage: InMemoryStorage, rev: number, path: string, text: string, by = "laptop-1") {
  const bytes = enc(text);
  const put = await storage.put(FILES_PREFIX + path, bytes);
  await appendDelta(storage, rev, (r): Delta => ({
    rev: r,
    by,
    at: new Date().toISOString(),
    files: { [path]: { hash: "md5:x", size: bytes.byteLength, mtime: new Date().toISOString(), s3VersionId: put.versionId } },
  }));
}

describe("isSafeVaultPath", () => {
  it("accepts plain vault content paths", () => {
    expect(isSafeVaultPath("a.md")).toBe(true);
    expect(isSafeVaultPath("dir/sub/имя файла.png")).toBe(true);
  });
  it("rejects traversal, absolute, malformed, and dot-paths", () => {
    for (const p of ["", "/abs.md", "../a.md", "a/../b.md", "a//b.md", "a\\b.md", "a/", ".obsidian/app.json", "dir/.hidden/x.md", ".gitignore"]) {
      expect(isSafeVaultPath(p), p).toBe(false);
    }
  });
});

describe("VaultClient", () => {
  it("write puts the file object and appends a delta by 'mcp' at rev 1", async () => {
    const { storage, vault } = setup();
    const res = await vault.write("notes/a.md", enc("hello"));
    expect(res.rev).toBe(1);
    expect(res.hash).toMatch(/^md5:/);

    expect(await storage.get(FILES_PREFIX + "notes/a.md")).not.toBeNull();
    const deltas = await listDeltasSince(storage, 0);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].by).toBe(WRITER_ID);
    const entry = deltas[0].files["notes/a.md"];
    expect(isTombstone(entry)).toBe(false);
    expect(entry).toMatchObject({ hash: res.hash, size: 5 });

    const read = await vault.read("notes/a.md");
    expect(dec(read!.bytes)).toBe("hello");
  });

  it("a second write lands at the next rev and read returns the latest content", async () => {
    const { vault } = setup();
    await vault.write("a.md", enc("v1"));
    const res = await vault.write("a.md", enc("v2"));
    expect(res.rev).toBe(2);
    expect(dec((await vault.read("a.md"))!.bytes)).toBe("v2");
  });

  it("write appends after a foreign journal head", async () => {
    const { storage, vault } = setup();
    await foreignWrite(storage, 1, "theirs.md", "x");
    const res = await vault.write("mine.md", enc("y"));
    expect(res.rev).toBe(2);
  });

  it("remove tombstones in the journal but keeps the files/ object", async () => {
    const { storage, vault } = setup();
    await vault.write("a.md", enc("v1"));
    const res = await vault.remove("a.md");
    expect(res).toEqual({ rev: 2 });

    const deltas = await listDeltasSince(storage, 1);
    expect(isTombstone(deltas[0].files["a.md"])).toBe(true);
    expect(await storage.get(FILES_PREFIX + "a.md")).not.toBeNull();
    expect(await vault.read("a.md")).toBeNull();
    expect(await vault.list("note")).toEqual([]);
  });

  it("remove of an absent or already-tombstoned path returns null", async () => {
    const { vault } = setup();
    expect(await vault.remove("nope.md")).toBeNull();
    await vault.write("a.md", enc("v1"));
    await vault.remove("a.md");
    expect(await vault.remove("a.md")).toBeNull();
  });

  it("list scopes by kind, dir, and recursion", async () => {
    const { vault } = setup();
    await vault.write("a.md", enc("1"));
    await vault.write("dir/b.md", enc("2"));
    await vault.write("dir/sub/c.md", enc("3"));
    await vault.write("dir/img.png", enc("4"));

    expect((await vault.list("note")).map((e) => e.path)).toEqual(["a.md", "dir/b.md", "dir/sub/c.md"]);
    expect((await vault.list("note", "dir")).map((e) => e.path)).toEqual(["dir/b.md", "dir/sub/c.md"]);
    expect((await vault.list("note", "dir", false)).map((e) => e.path)).toEqual(["dir/b.md"]);
    expect((await vault.list("file", "dir")).map((e) => e.path)).toEqual(["dir/img.png"]);
    const entry = (await vault.list("note"))[0];
    expect(entry.size).toBe(1);
    expect(entry.mtime).toBeTruthy();
  });

  it("rejects unsafe paths and keeps dot-paths invisible even when present remotely", async () => {
    const { storage, vault } = setup();
    await expect(vault.write(".obsidian/app.json", enc("{}"))).rejects.toThrow(PathError);
    await expect(vault.read("../escape.md")).rejects.toThrow(PathError);
    await expect(vault.remove("/abs.md")).rejects.toThrow(PathError);
    await expect(vault.list("note", "../up")).rejects.toThrow(PathError);

    // another leg synced a config file — it must not surface through the MCP scope
    await foreignWrite(storage, 1, ".obsidian/app.json", "{}");
    expect(await vault.list("file")).toEqual([]);
    await expect(vault.read(".obsidian/app.json")).rejects.toThrow(PathError);
  });

  it("read pins to the journal-recorded version when a newer object has no delta yet", async () => {
    const { storage, vault } = setup();
    await vault.write("a.md", enc("committed"));
    // racing writer: object PUT landed, delta not yet appended (files-before-delta window)
    await storage.put(FILES_PREFIX + "a.md", enc("in-flight"));
    expect(dec((await vault.read("a.md"))!.bytes)).toBe("committed");
  });
});
