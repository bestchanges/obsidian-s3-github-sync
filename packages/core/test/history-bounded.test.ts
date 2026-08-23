import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "../src/memory";
import { appendDelta } from "../src/journal";
import { readFileHistory, readStoredVersionContent, readStoredVersions } from "../src/history";
import type { Delta } from "../src/schemas";

/** Build a journal of `n` revisions; `touch` decides which revs touch the tracked path. */
async function seed(n: number, touch: (rev: number) => boolean, path = "note.md") {
  const s = new InMemoryStorage();
  for (let rev = 1; rev <= n; rev++) {
    const p = touch(rev) ? path : `other/${rev}.md`;
    await appendDelta(s, rev, (r): Delta => ({
      rev: r,
      by: "dev",
      at: new Date(1700000000000 + r * 1000).toISOString(),
      files: { [p]: { hash: `md5:${r}`, size: r, mtime: new Date().toISOString() } },
    }));
  }
  return s;
}

describe("readFileHistory — bounded newest-first walk (§2.9)", () => {
  it("finds recent history without reading the whole journal", async () => {
    // 1200 revisions, the tracked note touched only in the last 5.
    const s = await seed(1200, (rev) => rev > 1195);
    const r = await readFileHistory(s, "note.md", { chunk: 100, maxScan: 300 });

    // All five live in the newest chunk, so they are found immediately…
    expect(r.versions.map((v) => v.rev)).toEqual([1200, 1199, 1198, 1197, 1196]);
    expect(r.available).toBe(1200);
    // …and the walk stops at the scan cap instead of reading the other 900 deltas. This is the
    // whole fix: the old implementation fetched every delta in the journal on every open.
    expect(r.scanned).toBeLessThanOrEqual(300);
    expect(r.truncated).toBe(true); // honest: older entries were not searched
  });

  it("returns newest first", async () => {
    const s = await seed(20, () => true);
    const r = await readFileHistory(s, "note.md", { chunk: 5 });
    const revs = r.versions.map((v) => v.rev);
    expect(revs).toEqual([...revs].sort((a, b) => b - a));
  });

  it("stops at `limit` versions and reports the list as truncated", async () => {
    const s = await seed(100, () => true);
    const r = await readFileHistory(s, "note.md", { chunk: 10, limit: 12 });

    expect(r.versions).toHaveLength(12);
    expect(r.versions[0].rev).toBe(100); // newest, not oldest
    expect(r.truncated).toBe(true);
  });

  it("honours maxScan and says the result is partial", async () => {
    const s = await seed(500, (rev) => rev < 10); // only OLD revs touch the note
    const r = await readFileHistory(s, "note.md", { chunk: 50, maxScan: 100 });

    expect(r.versions).toEqual([]);
    expect(r.scanned).toBeLessThanOrEqual(100);
    expect(r.truncated).toBe(true); // "searched the recent part", not "no history"
  });

  it("skips unreadable deltas instead of failing the whole query", async () => {
    const s = await seed(30, () => true);
    // Delegate explicitly — spreading a class instance drops its prototype methods.
    const broken = {
      list: (prefix: string, startAfter?: string) => s.list(prefix, startAfter),
      head: (key: string) => s.head(key),
      put: (key: string, body: Uint8Array, opts?: unknown) => (s as any).put(key, body, opts),
      delete: (key: string) => s.delete(key),
      get: async (key: string) => (key.endsWith("0000000025.json.gz") ? null : s.get(key)),
    };

    const r = await readFileHistory(broken as any, "note.md", { chunk: 10 });

    expect(r.unreadable).toBe(1);
    expect(r.versions.map((v) => v.rev)).not.toContain(25);
    expect(r.versions.length).toBe(29); // every other revision still there
  });

  it("reports a complete read as not truncated", async () => {
    const s = await seed(5, () => true);
    const r = await readFileHistory(s, "note.md", { chunk: 10 });

    expect(r.scanned).toBe(5);
    expect(r.available).toBe(5);
    expect(r.truncated).toBe(false);
  });
});

describe("readStoredVersions — S3 object versions as history (§2.9)", () => {
  it("returns one entry per stored version, newest first, with the hash from the ETag", async () => {
    const s = new InMemoryStorage();
    for (const body of ["one\n", "two\n", "three\n"]) {
      await s.put("files/note.md", new TextEncoder().encode(body));
    }

    const versions = await readStoredVersions(s, "note.md");

    expect(versions).toHaveLength(3);
    expect(versions[0].isLatest).toBe(true);
    expect(versions.map((v) => v.size)).toEqual([6, 4, 4]); // three\n, two\n, one\n
    expect(versions.every((v) => v.hash.startsWith("md5:"))).toBe(true);
    // newest first
    expect(versions[0].at.getTime()).toBeGreaterThanOrEqual(versions[1].at.getTime());
  });

  it("reads the exact bytes of an older version", async () => {
    const s = new InMemoryStorage();
    await s.put("files/note.md", new TextEncoder().encode("first\n"));
    await s.put("files/note.md", new TextEncoder().encode("second\n"));

    const versions = await readStoredVersions(s, "note.md");
    const older = await readStoredVersionContent(s, "note.md", versions[1].versionId);

    expect(new TextDecoder().decode(older!)).toBe("first\n");
  });

  it("is empty for a path that was never stored — e.g. just after a rename", async () => {
    const s = new InMemoryStorage();
    await s.put("files/old.md", new TextEncoder().encode("x\n"));

    expect(await readStoredVersions(s, "new.md")).toEqual([]);
  });

  it("fails loudly when the adapter cannot list versions", async () => {
    const noVersions = { get: async () => null } as never;
    await expect(readStoredVersions(noVersions, "note.md")).rejects.toThrow(/cannot list object versions/);
  });
});
