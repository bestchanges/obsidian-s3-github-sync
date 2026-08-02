import { describe, expect, it } from "vitest";
import { canonicalKey, sameNode, collapseNodes } from "../src/casing";
import { changedEntries, foldDeltas } from "../src/journal";
import { Delta, SnapshotEntry, isTombstone } from "../src/schemas";
import { contentHash } from "../src/hash";

const H = (s: string) => contentHash(s);
function live(rev: number, by: string, content = "x"): SnapshotEntry {
  return { hash: H(content), size: content.length, mtime: "2026-08-02T00:00:00Z", rev, by, at: `t${rev}` };
}
function dead(rev: number, by: string, renamedTo?: string): SnapshotEntry {
  return { deleted: true, ...(renamedTo ? { renamedTo } : {}), rev, by, at: `t${rev}` };
}

describe("canonicalKey / sameNode", () => {
  it("folds case and NFC", () => {
    expect(canonicalKey("Foo/Bar.md")).toBe("foo/bar.md");
    // "ё" composed (NFC, U+0451) vs decomposed (NFD, "е"+U+0308) collapse to one identity.
    expect(canonicalKey("её.md".normalize("NFC"))).toBe(canonicalKey("её.md".normalize("NFD")));
    expect(sameNode("Мой Вес.md", "мой вес.md")).toBe(true);
    expect(sameNode("a.md", "b.md")).toBe(false);
  });
});

describe("collapseNodes", () => {
  it("keeps the freshest of case-variant keys", () => {
    const out = collapseNodes<SnapshotEntry>([
      ["Foo.md", live(1, "a")],
      ["foo.md", live(3, "b")],
    ]);
    expect([...out.keys()]).toEqual(["foo.md"]); // rev 3 wins, its display case
    expect(out.get("foo.md")!.rev).toBe(3);
  });

  it("a live rename destination beats the old-cased tombstone at the same rev", () => {
    // delete(Foo)+add(foo) at one rev — the surviving node is the live destination, never the delete.
    const out = collapseNodes<SnapshotEntry>([
      ["Foo.md", dead(5, "a", "foo.md")],
      ["foo.md", live(5, "a")],
    ]);
    expect([...out.keys()]).toEqual(["foo.md"]);
    expect(isTombstone(out.get("foo.md")!)).toBe(false);
  });

  it("leaves genuinely distinct names untouched", () => {
    const out = collapseNodes<SnapshotEntry>([
      ["a.md", live(1, "a")],
      ["b.md", live(1, "a")],
    ]);
    expect(new Set(out.keys())).toEqual(new Set(["a.md", "b.md"]));
  });
});

// The protocol-level fix for the real data loss: a case-only rename must NOT reach a client as a
// separate deleting tombstone. Before the fix, foldDeltas/changedEntries carried both `Foo`(tombstone)
// and `foo`(live); a case-insensitive client applied the tombstone and deleted the shared file.
describe("case-only rename through the journal", () => {
  const renameDelta: Delta = {
    rev: 2,
    by: "mac",
    at: "t2",
    files: {
      "health/Мой Вес.md": { deleted: true, renamedTo: "health/мой вес.md" },
      "health/мой вес.md": { hash: H("weight"), size: 6, mtime: "2026-08-02T00:00:00Z" },
    },
  };
  const seedDelta: Delta = {
    rev: 1,
    by: "mac",
    at: "t1",
    files: { "health/Мой Вес.md": { hash: H("weight"), size: 6, mtime: "2026-08-02T00:00:00Z" } },
  };

  it("foldDeltas yields ONE live node, not a live+tombstone pair", () => {
    const snap = foldDeltas(null, [seedDelta, renameDelta]);
    const keys = Object.keys(snap.files);
    expect(keys).toEqual(["health/мой вес.md"]);
    expect(isTombstone(snap.files["health/мой вес.md"])).toBe(false);
  });

  it("changedEntries hands a client the live destination only — no deleting tombstone", () => {
    // A peer whose cursor is at rev 0 pulls both deltas at once.
    const changed = changedEntries([seedDelta, renameDelta], 0);
    expect([...changed.keys()]).toEqual(["health/мой вес.md"]);
    expect(isTombstone(changed.get("health/мой вес.md")!)).toBe(false);
    // The old-cased key is absent, so the client can't tombstone the shared inode.
    expect(changed.has("health/Мой Вес.md")).toBe(false);
  });
});
