import { describe, expect, it } from "vitest";
import { unionMerge } from "../src/merge";

/**
 * Lossless whitespace/EOL-aware conflict-region alignment (the "create/create daily-note
 * duplication" class). Two devices creating the same templated note collide over an EMPTY base;
 * pure formatting noise between them (CRLF vs LF, a trailing space on a ``` fence, etc.) used to
 * defeat the line-level LCS and stack an otherwise-identical block twice. Alignment now ignores
 * trailing whitespace + CR, so identical blocks collapse to one — while ORIGINAL bytes are emitted,
 * so nothing is normalized away and no genuine edit is ever dropped.
 */

// A synthetic daily-note template with the same STRUCTURE as the failing case: a leading widget line,
// several fenced blocks (so there are many identical bare ``` close-fences), headings, and blank
// lines. Content is neutral placeholder text; only the shape matters to these tests.
const TEMPLATE = [
  "`BUTTON[prev, todo-today, next]`", "", "```meta", "include: summary", "```",
  "## Journal", "", "### What went well", "- ",
  "### What to improve", "- ", "## Today's tasks",
  "```calendar", "```", "```tasks", "not done", "```",
  "```tasks", "done", "```", "", "```budget-period", "```    ",
].join("\n");

const blocks = (t: string, re: RegExp) => (t.match(re) || []).length;

describe("whitespace/EOL-noise no longer seeds block duplication (empty base)", () => {
  it("trailing space on the bare fence lines — block is NOT doubled (was 2 copies)", () => {
    const ours = TEMPLATE;
    const theirs = TEMPLATE.replace(/^```$/gm, "``` "); // bare ``` close-fences gain a trailing space
    const r = unionMerge("", ours, theirs);
    expect(blocks(r.text, /include: summary/g)).toBe(1);
    expect(blocks(r.text, /budget-period/g)).toBe(1);
  });

  it("CRLF vs LF line endings — block is NOT doubled", () => {
    const ours = TEMPLATE;
    const theirs = TEMPLATE.replace(/\n/g, "\r\n"); // theirs came from a CRLF device
    const r = unionMerge("", ours, theirs);
    expect(blocks(r.text, /include: summary/g)).toBe(1);
    expect(blocks(r.text, /## Journal/g)).toBe(1);
  });

  it("mixed noise (CRLF + trailing space on every line) still collapses to one block", () => {
    const ours = TEMPLATE;
    // theirs came from a device that both uses CRLF and left a trailing space on every line
    const theirs = TEMPLATE.split("\n").map((l) => l + " ").join("\r\n");
    const r = unionMerge("", ours, theirs);
    expect(blocks(r.text, /include: summary/g)).toBe(1);
    expect(blocks(r.text, /budget-period/g)).toBe(1);
  });
});

describe("still lossless — every genuine edit survives", () => {
  it("real content difference between the two copies keeps BOTH unique lines", () => {
    const ours = TEMPLATE.replace("### What went well\n- ", "### What went well\n- walked");
    const theirs = TEMPLATE.replace("### What to improve\n- ", "### What to improve\n- slept");
    const r = unionMerge("", ours, theirs);
    expect(r.text).toContain("- walked");
    expect(r.text).toContain("- slept");
    expect(blocks(r.text, /include: summary/g)).toBe(1); // shared block still once
  });

  it("a Markdown hard break (two trailing spaces) is preserved on the common line", () => {
    const ours = "para one  \npara two"; // ours has a hard break (2 trailing spaces)
    const theirs = "para one\npara two"; // theirs lost it (a device stripped trailing ws)
    const r = unionMerge("", ours, theirs);
    // one "para one" line, and the hard break (longer original) is the one kept
    expect(r.text.split("\n").filter((l) => l.startsWith("para one")).length).toBe(1);
    expect(r.text).toContain("para one  ");
  });

  it("same-line genuine conflict still stacks both versions (nothing lost)", () => {
    const base = "title\noriginal\nfooter\n";
    const ours = "title\nours version\nfooter\n";
    const theirs = "title\ntheirs version\nfooter\n";
    const r = unionMerge(base, ours, theirs);
    expect(r.text).toContain("ours version");
    expect(r.text).toContain("theirs version");
  });
});

describe("intentional repeats are NEVER eaten (this is not aggressive dedup)", () => {
  it("a note that deliberately repeats an identical block keeps both copies", () => {
    // user genuinely wrote the same checklist twice; theirs adds an unrelated line elsewhere
    const repeated = ["## Checklist", "- [ ] water plants", "- [ ] water plants", "", "end"].join("\n");
    const ours = repeated;
    const theirs = repeated.replace("end", "end\nps note");
    const r = unionMerge("", ours, theirs);
    expect(blocks(r.text, /- \[ \] water plants/g)).toBe(2); // both intentional copies survive
    expect(r.text).toContain("ps note");
  });
});

describe("KNOWN LIMITATION — an already-doubled note is NOT auto-healed", () => {
  it("a mid-doubled copy merged against a clean copy stays doubled (needs the one-off cleanup)", () => {
    const HEAD = "`BUTTON[prev, todo-today, next]`\n\n";
    const TAIL = "\n\n```budget-period\n```    ";
    const MID = TEMPLATE.slice(HEAD.length, TEMPLATE.length - TAIL.length);
    const midDoubled = HEAD + MID + "\n" + MID + TAIL;
    const r = unionMerge("", midDoubled, TEMPLATE);
    // This is intentional: healing existing on-disk duplication is a separate, reviewable step —
    // auto-collapsing it here risks eating deliberate repeats (see the test above).
    expect(blocks(r.text, /include: summary/g)).toBe(2);
  });
});

describe("determinism / cross-leg parity is preserved", () => {
  it("same inputs → identical output across repeated runs", () => {
    const ours = TEMPLATE.replace(/^```$/gm, "``` ");
    const theirs = TEMPLATE;
    const first = unionMerge("", ours, theirs).text;
    for (let i = 0; i < 5; i++) expect(unionMerge("", ours, theirs).text).toBe(first);
  });

  it("swapping ours/theirs keeps every SHARED line single (role-independent common pick)", () => {
    const a = TEMPLATE.replace(/^```$/gm, "``` ");
    const b = TEMPLATE;
    const ab = unionMerge("", a, b).text;
    const ba = unionMerge("", b, a).text;
    // the shared block collapses to one copy regardless of order (canonicalCommon is symmetric)
    expect(blocks(ab, /include: summary/g)).toBe(1);
    expect(blocks(ba, /include: summary/g)).toBe(1);
  });
});
