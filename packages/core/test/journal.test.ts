import { describe, expect, it } from "vitest";
import {
  appendDelta,
  changedEntries,
  deltaKey,
  foldDeltas,
  hasGap,
  listDeltasSince,
  loadRemoteState,
  pruneDeltas,
  writeSnapshot,
  readSnapshot,
  SNAPSHOT_KEY,
  META_REVISION,
} from "../src/journal";
import { InMemoryStorage } from "../src/memory";
import { Delta } from "../src/schemas";
import { contentHash } from "../src/hash";

function mkDelta(rev: number, by: string, files: Record<string, string | null>): Delta {
  const entries: Delta["files"] = {};
  for (const [path, content] of Object.entries(files)) {
    entries[path] =
      content === null
        ? { deleted: true }
        : { hash: contentHash(content), size: content.length, mtime: "2026-07-11T00:00:00Z" };
  }
  return { rev, by, at: "2026-07-11T00:00:00Z", files: entries };
}

describe("delta journal", () => {
  it("appends sequential revs", async () => {
    const s = new InMemoryStorage();
    const r1 = await appendDelta(s, 1, (rev) => mkDelta(rev, "a", { "n.md": "one" }));
    const r2 = await appendDelta(s, r1.rev + 1, (rev) => mkDelta(rev, "a", { "n.md": "two" }));
    expect(r1.rev).toBe(1);
    expect(r2.rev).toBe(2);
  });

  it("CAS race: loser observes winner's delta and lands on next rev", async () => {
    const s = new InMemoryStorage();
    await appendDelta(s, 1, (rev) => mkDelta(rev, "device:phone", { "a.md": "phone edit" }));

    const seen: Delta[] = [];
    const r = await appendDelta(
      s,
      1, // stale view: laptop also thinks rev 1 is free
      (rev) => mkDelta(rev, "device:laptop", { "b.md": "laptop edit" }),
      (winner) => void seen.push(winner),
    );
    expect(r.rev).toBe(2);
    expect(seen).toHaveLength(1);
    expect(seen[0].by).toBe("device:phone");

    const all = await listDeltasSince(s, 0);
    expect(all.map((d) => d.rev)).toEqual([1, 2]);
  });

  it("listDeltasSince returns only newer deltas, in order", async () => {
    const s = new InMemoryStorage();
    for (let rev = 1; rev <= 5; rev++) {
      await appendDelta(s, rev, (r) => mkDelta(r, "a", { [`f${r}.md`]: `v${r}` }));
    }
    const since3 = await listDeltasSince(s, 3);
    expect(since3.map((d) => d.rev)).toEqual([4, 5]);
    expect(await listDeltasSince(s, 5)).toEqual([]);
  });

  it("detects a pruned-journal gap (snapshot cold path trigger)", async () => {
    const s = new InMemoryStorage();
    await appendDelta(s, 5, (r) => mkDelta(r, "a", { "x.md": "x" }));
    const deltas = await listDeltasSince(s, 1); // client last synced rev 1; revs 2-4 pruned
    expect(hasGap(1, deltas)).toBe(true);
    expect(hasGap(4, deltas)).toBe(false);
  });

  it("fold: last delta per path wins, tombstones apply, revision advances", () => {
    const snap = foldDeltas(null, [
      mkDelta(1, "a", { "note.md": "v1", "other.md": "keep" }),
      mkDelta(2, "b", { "note.md": "v2" }),
      mkDelta(3, "a", { "other.md": null }),
    ]);
    expect(snap.revision).toBe(3);
    expect(snap.files["note.md"]).toMatchObject({ hash: contentHash("v2"), rev: 2, by: "b" });
    expect(snap.files["other.md"]).toMatchObject({ deleted: true, rev: 3 });
    // folding already-folded deltas is a no-op
    const again = foldDeltas(snap, [mkDelta(2, "b", { "note.md": "stale" })]);
    expect(again.files["note.md"]).toMatchObject({ hash: contentHash("v2") });
  });

  it("changedEntries: last-wins + echo suppression", () => {
    const deltas = [
      mkDelta(2, "me", { "mine.md": "m1" }),
      mkDelta(3, "them", { "theirs.md": "t1", "both.md": "t-version" }),
      mkDelta(4, "me", { "both.md": "m-version" }),
    ];
    const changed = changedEntries(deltas, 1, "me");
    expect(changed.has("mine.md")).toBe(false); // mine, skipped
    expect(changed.has("both.md")).toBe(false); // my write is the latest → my own state
    expect(changed.get("theirs.md")).toMatchObject({ by: "them", rev: 3 });
  });

  it("snapshot roundtrip with CAS + revision metadata", async () => {
    const s = new InMemoryStorage();
    const snap = foldDeltas(null, [mkDelta(1, "a", { "n.md": "v" })]);
    await writeSnapshot(s, snap); // create
    const head = await s.head(SNAPSHOT_KEY);
    expect(head?.metadata?.[META_REVISION]).toBe("1");

    const read = await readSnapshot(s);
    expect(read?.snapshot.revision).toBe(1);
    // stale-etag write must fail
    await expect(writeSnapshot(s, snap, '"wrong-etag"')).rejects.toThrow(/Precondition/);
    await writeSnapshot(s, foldDeltas(snap, [mkDelta(2, "b", { "n.md": "v2" })]), read!.etag);
    expect((await readSnapshot(s))?.snapshot.revision).toBe(2);
  });

  it("loadRemoteState = snapshot ⊕ newer deltas", async () => {
    const s = new InMemoryStorage();
    await appendDelta(s, 1, (r) => mkDelta(r, "a", { "one.md": "1" }));
    await appendDelta(s, 2, (r) => mkDelta(r, "a", { "two.md": "2" }));
    await writeSnapshot(s, foldDeltas(null, await listDeltasSince(s, 0)));
    await appendDelta(s, 3, (r) => mkDelta(r, "b", { "three.md": "3" }));
    const { state } = await loadRemoteState(s);
    expect(state.revision).toBe(3);
    expect(Object.keys(state.files).sort()).toEqual(["one.md", "three.md", "two.md"]);
  });

  it("prunes only folded deltas older than retention", async () => {
    const s = new InMemoryStorage();
    s.now = () => new Date("2026-06-01T00:00:00Z"); // old writes
    await appendDelta(s, 1, (r) => mkDelta(r, "a", { "a.md": "1" }));
    await appendDelta(s, 2, (r) => mkDelta(r, "a", { "b.md": "2" }));
    s.now = () => new Date("2026-07-11T00:00:00Z"); // recent write
    await appendDelta(s, 3, (r) => mkDelta(r, "a", { "c.md": "3" }));

    const cutoff = new Date("2026-06-11T00:00:00Z"); // 30 days before "today"
    const pruned = await pruneDeltas(s, 2 /* folded up to */, cutoff);
    expect(pruned).toBe(2);
    const remaining = await s.list("deltas/");
    expect(remaining.map((i) => i.key)).toEqual([deltaKey(3)]);
  });
});
