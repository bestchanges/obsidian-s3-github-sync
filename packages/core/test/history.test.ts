import { describe, expect, it } from "vitest";
import { fileHistory, latestLive, readFileHistory, readVersionContent } from "../src/history";
import { appendDelta } from "../src/journal";
import { InMemoryStorage } from "../src/memory";
import { Delta, DeltaEntry } from "../src/schemas";
import { contentHash } from "../src/hash";

function live(content: string, s3VersionId?: string): DeltaEntry {
  return {
    hash: contentHash(content),
    size: content.length,
    mtime: "2026-07-11T00:00:00Z",
    ...(s3VersionId ? { s3VersionId } : {}),
  };
}

function mkDelta(rev: number, by: string, files: Record<string, DeltaEntry>, at?: string): Delta {
  return { rev, by, at: at ?? `2026-07-${String(rev).padStart(2, "0")}T00:00:00Z`, files };
}

describe("fileHistory", () => {
  it("returns a path's entries newest first, carrying rev/by/at", () => {
    const deltas = [
      mkDelta(1, "laptop", { "a.md": live("one") }),
      mkDelta(2, "phone", { "b.md": live("other") }),
      mkDelta(3, "git-sync", { "a.md": live("two") }),
    ];
    const h = fileHistory(deltas, "a.md");
    expect(h.map((v) => v.rev)).toEqual([3, 1]);
    expect(h[0].by).toBe("git-sync");
    expect(h[0].at).toBe("2026-07-03T00:00:00Z");
    expect(h[1].by).toBe("laptop");
  });

  it("marks tombstones and exposes renamedTo", () => {
    const deltas = [
      mkDelta(1, "laptop", { "a.md": live("one") }),
      mkDelta(2, "laptop", { "a.md": { deleted: true } }),
    ];
    const h = fileHistory(deltas, "a.md");
    expect(h[0].deleted).toBe(true);
    expect(h[0].hash).toBeUndefined();
    expect(latestLive(h)).toBeNull();
    expect(latestLive(fileHistory([deltas[0]], "a.md"))?.rev).toBe(1);
  });

  it("follows a rename backwards so history survives the move", () => {
    const deltas = [
      mkDelta(1, "laptop", { "old.md": live("v1") }),
      mkDelta(2, "laptop", { "old.md": live("v2") }),
      // rename: tombstone(old, renamedTo) + live(new), one delta
      mkDelta(3, "phone", { "old.md": { deleted: true, renamedTo: "new.md" }, "new.md": live("v2") }),
      mkDelta(4, "phone", { "new.md": live("v3") }),
    ];
    const h = fileHistory(deltas, "new.md");
    expect(h.map((v) => v.rev)).toEqual([4, 3, 2, 1]);
    // the trail shows the pre-rename path on the older entries
    expect(h.map((v) => v.path)).toEqual(["new.md", "new.md", "old.md", "old.md"]);
  });

  it("does not follow an unrelated tombstone at the same rev", () => {
    const deltas = [
      mkDelta(1, "laptop", { "other.md": live("x") }),
      mkDelta(2, "laptop", { "other.md": { deleted: true, renamedTo: "somewhere.md" }, "new.md": live("v1") }),
    ];
    expect(fileHistory(deltas, "new.md").map((v) => v.rev)).toEqual([2]);
  });

  it("treats case/NFC variants as one node (§2.8a identity)", () => {
    const deltas = [
      mkDelta(1, "laptop", { "Мой Вес.md": live("v1") }),
      mkDelta(2, "phone", { "мой вес.md": live("v2") }),
    ];
    expect(fileHistory(deltas, "МОЙ ВЕС.md").map((v) => v.rev)).toEqual([2, 1]);
    const decomposed = "Мой Вес.md".normalize("NFD");
    expect(fileHistory(deltas, decomposed).map((v) => v.rev)).toEqual([2, 1]);
  });

  it("returns nothing for a path the journal never saw", () => {
    expect(fileHistory([mkDelta(1, "laptop", { "a.md": live("one") })], "ghost.md")).toEqual([]);
  });
});

describe("readFileHistory / readVersionContent", () => {
  it("reads history off a real journal and fetches pinned bytes back", async () => {
    const s = new InMemoryStorage();
    const v1 = await s.put("files/note.md", new TextEncoder().encode("first"));
    await appendDelta(s, 1, (rev) => mkDelta(rev, "laptop", { "note.md": live("first", v1.versionId) }));
    const v2 = await s.put("files/note.md", new TextEncoder().encode("second"));
    await appendDelta(s, 2, (rev) => mkDelta(rev, "phone", { "note.md": live("second", v2.versionId) }));

    const h = await readFileHistory(s, "note.md");
    expect(h.versions.map((v) => v.rev)).toEqual([2, 1]);
    expect(h.oldestRevAvailable).toBe(1);
    expect(h.truncated).toBe(false);

    const older = await readVersionContent(s, h.versions[1]);
    expect(new TextDecoder().decode(older!.body)).toBe("first");
    const newer = await readVersionContent(s, h.versions[0]);
    expect(new TextDecoder().decode(newer!.body)).toBe("second");
  });

  it("flags truncation when the journal has been pruned below rev 1", async () => {
    const s = new InMemoryStorage();
    await appendDelta(s, 5, (rev) => mkDelta(rev, "laptop", { "note.md": live("x") }));
    const h = await readFileHistory(s, "note.md");
    expect(h.oldestRevAvailable).toBe(5);
    expect(h.truncated).toBe(true);
  });

  it("returns null content for a tombstone", async () => {
    const s = new InMemoryStorage();
    await appendDelta(s, 1, (rev) => mkDelta(rev, "laptop", { "note.md": { deleted: true } }));
    const h = await readFileHistory(s, "note.md");
    expect(await readVersionContent(s, h.versions[0])).toBeNull();
  });
});
