import { diff3Merge, diffComm } from "node-diff3";
import { mergeNoteWithFrontmatter } from "./frontmatter";

/**
 * Three-way UNION merge — the single merge implementation for BOTH sync legs
 * (design doc §1.5, §5). Conflict policy: include all changes in one, no
 * conflict markers, nothing lost. Within a conflict region the two sides are
 * combined by a 2-way LCS union (see mergeConflictSides) rather than blind
 * concatenation, so lines common to both sides survive ONCE instead of being
 * duplicated — which matters most on the empty/unusable-base path, where diff3
 * collapses the whole overlap into one giant conflict region.
 * Identical output on both legs is required: divergent merge results would
 * echo back through sync as phantom changes. Both diff3Merge and diffComm are
 * pure and deterministic, so the two legs stay byte-identical.
 *
 * YAML frontmatter is a special case: line-stacking two edits of the same
 * property duplicates the key and breaks Obsidian's parser, so when both sides
 * carry a frontmatter block we merge it structurally (per-key) and union-merge
 * only the body — see frontmatter.ts.
 */
export interface UnionMergeResult {
  text: string;
  hadConflicts: boolean;
}

/**
 * Alignment key for a line: ignore a trailing run of spaces/tabs and any CR, so pure formatting
 * noise between two devices — CRLF vs LF, a stray trailing space on a ``` fence — does NOT defeat
 * line alignment and stack an otherwise-identical block twice. Used ONLY to decide what is "common";
 * the original bytes are always what's emitted, so nothing is normalized away in the output. Leading
 * whitespace (indentation: code, nested lists) is significant and never touched.
 */
function alignKey(line: string): string {
  return line.replace(/[ \t\r]+$/, "");
}

/**
 * A line common to both sides under alignKey but whose originals differ only by trailing whitespace:
 * pick a ROLE-INDEPENDENT canonical original so the two sync legs emit byte-identical output no matter
 * which side each holds as "ours". The longer original wins (preserving a meaningful trailing run — a
 * Markdown hard break is two trailing spaces, longer than none), ties broken lexicographically. This
 * is lossless: the more-content side is kept, never the stripped one.
 */
function canonicalCommon(a: string, b: string): string {
  if (a === b) return a;
  if (a.length !== b.length) return a.length > b.length ? a : b;
  return a < b ? a : b;
}

/**
 * Combine the two sides of a conflict region into one, keeping lines common to both exactly once and
 * stacking only the lines that actually differ (ours then theirs). LCS-aligned via diffComm on the
 * NORMALIZED keys (alignKey), so whitespace/EOL noise can't split an identical block — while the
 * ORIGINAL bytes are emitted (canonicalCommon for shared lines, verbatim for divergent ones). Nothing
 * is lost: every unique line from either side survives, and a genuinely-different line still stacks.
 */
function mergeConflictSides(a: string[], b: string[]): string[] {
  const out: string[] = [];
  let ia = 0;
  let ib = 0;
  for (const region of diffComm(a.map(alignKey), b.map(alignKey))) {
    if (region.common) {
      for (let k = 0; k < region.common.length; k++) out.push(canonicalCommon(a[ia++], b[ib++]));
    } else {
      // ours-only, then theirs-only — emit the originals, not the normalized keys.
      for (let k = 0; k < region.buffer1.length; k++) out.push(a[ia++]);
      for (let k = 0; k < region.buffer2.length; k++) out.push(b[ib++]);
    }
  }
  return out;
}

export function unionMerge(base: string, ours: string, theirs: string): UnionMergeResult {
  if (ours === theirs) return { text: ours, hadConflicts: false };
  if (base === ours) return { text: theirs, hadConflicts: false };
  if (base === theirs) return { text: ours, hadConflicts: false };

  // Both sides changed. If both carry YAML frontmatter, merge it per-key so conflicting properties
  // don't stack into duplicate keys; falls back to the plain line merge (text === null) otherwise.
  const fm = mergeNoteWithFrontmatter(base, ours, theirs, unionMergeText);
  if (fm.text !== null) return { text: fm.text, hadConflicts: fm.hadConflicts };

  return unionMergeText(base, ours, theirs);
}

/** The plain line-based union merge (no frontmatter awareness). Used for note bodies and for notes
 * that don't have frontmatter on both sides. */
function unionMergeText(base: string, ours: string, theirs: string): UnionMergeResult {
  if (ours === theirs) return { text: ours, hadConflicts: false };
  if (base === ours) return { text: theirs, hadConflicts: false };
  if (base === theirs) return { text: ours, hadConflicts: false };

  const regions = diff3Merge(ours.split("\n"), base.split("\n"), theirs.split("\n"), {
    excludeFalseConflicts: true,
    stringSeparator: undefined as unknown as string, // we pre-split; keep types happy
  });

  const out: string[] = [];
  let hadConflicts = false;
  for (const region of regions) {
    if (region.ok) {
      out.push(...region.ok);
    } else if (region.conflict) {
      hadConflicts = true;
      out.push(...mergeConflictSides(region.conflict.a, region.conflict.b));
    }
  }
  return { text: out.join("\n"), hadConflicts };
}
