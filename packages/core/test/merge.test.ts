import { describe, expect, it } from "vitest";
import { unionMerge } from "../src/merge";

/** THE critical suite (§5): both sync legs must produce these exact outputs. */
describe("unionMerge conflict fixtures", () => {
  it("applies non-overlapping edits from both sides", () => {
    const base = "line1\nline2\nline3\n";
    const ours = "line1 EDITED\nline2\nline3\n";
    const theirs = "line1\nline2\nline3 EDITED\n";
    const r = unionMerge(base, ours, theirs);
    expect(r.text).toBe("line1 EDITED\nline2\nline3 EDITED\n");
    expect(r.hadConflicts).toBe(false);
  });

  it("union-merges a same-region conflict: ours lines then theirs lines, no markers", () => {
    const base = "title\noriginal\nfooter\n";
    const ours = "title\nours version\nfooter\n";
    const theirs = "title\ntheirs version\nfooter\n";
    const r = unionMerge(base, ours, theirs);
    expect(r.text).toBe("title\nours version\ntheirs version\nfooter\n");
    expect(r.hadConflicts).toBe(true);
    expect(r.text).not.toContain("<<<<<<<");
  });

  it("collapses identical edits (false conflict) to a single copy", () => {
    const base = "a\nb\nc\n";
    const ours = "a\nB!\nc\n";
    const theirs = "a\nB!\nc\n";
    const r = unionMerge(base, ours, theirs);
    expect(r.text).toBe("a\nB!\nc\n");
    expect(r.hadConflicts).toBe(false);
  });

  it("keeps both sides' appends", () => {
    const base = "shared\n";
    const ours = "shared\nours appended\n";
    const theirs = "shared\ntheirs appended\n";
    const r = unionMerge(base, ours, theirs);
    expect(r.text).toContain("ours appended");
    expect(r.text).toContain("theirs appended");
    expect(r.text.startsWith("shared\n")).toBe(true);
  });

  it("empty base (re-enable / first-run case) = pure union, nothing lost", () => {
    const ours = "local note line\n";
    const theirs = "remote note line\n";
    const r = unionMerge("", ours, theirs);
    expect(r.text).toBe("local note line\nremote note line\n");
    expect(r.hadConflicts).toBe(true);
  });

  it("delete-vs-edit region keeps the edited text (never silently loses content)", () => {
    const base = "keep\ndoomed line\nkeep2\n";
    const ours = "keep\nkeep2\n"; // we deleted the line
    const theirs = "keep\ndoomed line but edited\nkeep2\n"; // they edited it
    const r = unionMerge(base, ours, theirs);
    expect(r.text).toContain("doomed line but edited");
    expect(r.hadConflicts).toBe(true);
  });

  it("no-op fast paths", () => {
    expect(unionMerge("x\n", "x\n", "x\n").text).toBe("x\n");
    expect(unionMerge("x\n", "x\n", "y\n").text).toBe("y\n"); // only theirs changed
    expect(unionMerge("x\n", "y\n", "x\n").text).toBe("y\n"); // only ours changed
  });

  it("is deterministic (same inputs → same output, required for cross-leg parity)", () => {
    const base = "1\n2\n3\n";
    const ours = "1\nA\n3\n";
    const theirs = "1\nB\n3\n";
    const first = unionMerge(base, ours, theirs).text;
    for (let i = 0; i < 5; i++) {
      expect(unionMerge(base, ours, theirs).text).toBe(first);
    }
  });
});

/** Conflict-region dedup (§1.5): within a conflict the two sides are combined by a 2-way LCS
 * union, so lines common to both survive once instead of the whole region being duplicated —
 * the note-block-duplication complaint. Nothing is lost; only genuinely differing lines stack. */
describe("unionMerge conflict-region dedup", () => {
  const rows = Array.from({ length: 12 }, (_, i) => `| item ${i} | val |`);

  it("empty base with near-identical sides keeps the shared block ONCE (was fully duplicated)", () => {
    const ours = ["# Note", ...rows, "ours tail"].join("\n");
    const theirs = ["# Note", ...rows, "theirs tail"].join("\n");
    const r = unionMerge("", ours, theirs);
    // each shared line appears exactly once; only the divergent tail lines are both kept
    for (const row of rows) expect(r.text.split(row).length - 1).toBe(1);
    expect(r.text).toContain("ours tail");
    expect(r.text).toContain("theirs tail");
    expect(r.text.split("\n").length).toBe(rows.length + 3); // header + 12 rows + 2 tails
    expect(r.hadConflicts).toBe(true);
  });

  it("dedups shared context WITHIN a coarse conflict region (stale/empty base)", () => {
    const shared = ["a", "b", "c", "d", "e", "f"];
    const ours = ["OURS", ...shared].join("\n");
    const theirs = ["THEIRS", ...shared].join("\n");
    const r = unionMerge("", ours, theirs);
    for (const line of shared) expect(r.text.split(new RegExp(`^${line}$`, "gm")).length - 1).toBe(1);
    expect(r.text).toContain("OURS");
    expect(r.text).toContain("THEIRS");
  });

  it("still keeps BOTH sides of a genuine same-line conflict (nothing lost)", () => {
    const base = "title\noriginal\nfooter\n";
    const ours = "title\nours version\nfooter\n";
    const theirs = "title\ntheirs version\nfooter\n";
    const r = unionMerge(base, ours, theirs);
    expect(r.text).toContain("ours version");
    expect(r.text).toContain("theirs version");
    expect(r.hadConflicts).toBe(true);
  });

  it("dedup path stays deterministic across repeated runs (cross-leg parity)", () => {
    const ours = ["# Note", ...rows, "ours tail"].join("\n");
    const theirs = ["# Note", ...rows, "theirs tail"].join("\n");
    const first = unionMerge("", ours, theirs).text;
    for (let i = 0; i < 5; i++) expect(unionMerge("", ours, theirs).text).toBe(first);
  });
});
