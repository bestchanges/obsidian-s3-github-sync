import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Structural three-way merge for a note's YAML frontmatter (design doc §2.6).
 *
 * The line-based union merge stacks conflicting lines ours-then-theirs, which is right for prose but
 * *breaks* YAML: two edits of the same property produce a duplicated key (`updated: A` / `updated: B`)
 * and Obsidian's property parser chokes. Config files (`.obsidian/**`) already dodge this via
 * freshest-wins; note frontmatter can't, because the body around it still wants union merge. So we
 * split the frontmatter off, merge it PER-KEY (never producing a duplicate key), and union-merge only
 * the body.
 *
 * Per-key policy (mirrors the body's "nothing lost where possible"):
 *   - changed on only one side          → take that change (add / edit / delete)
 *   - both sides set it to equal values → keep the value once
 *   - both changed, both are lists       → union the items (base ∪ ours ∪ theirs, order-preserving)
 *   - both changed, one side deleted     → keep the surviving edit (never let a delete drop an edit)
 *   - both changed to differing scalars → take THEIRS (the S3/remote side) — the only genuinely lossy
 *     case, and deterministic so both sync legs converge on the hub's value instead of fighting.
 *
 * Output key order is stable (base order, then ours-added, then theirs-added) and serialization is
 * deterministic, so both legs stay byte-identical. Reserialization only happens on a real conflict —
 * the equal / one-sided fast paths in unionMerge return a side verbatim and never reach here.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export interface SplitNote {
  /** Raw YAML text between the fences (fences excluded), or null when the note has no frontmatter. */
  frontmatter: string | null;
  /** Everything after the closing fence (or the whole note when there's no frontmatter). */
  body: string;
}

/** Split a note into its leading YAML frontmatter block and the body that follows. */
export function splitFrontmatter(text: string): SplitNote {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { frontmatter: null, body: text };
  return { frontmatter: m[1], body: text.slice(m[0].length) };
}

/** Reassemble a note from a merged frontmatter object and a body. */
function joinFrontmatter(obj: Record<string, unknown>, body: string): string {
  // stringifyYaml ends with a newline; trim it so the closing fence sits on its own line.
  const yaml = stringifyYaml(obj).replace(/\n$/, "");
  return `---\n${yaml}\n---\n${body}`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** base ∪ ours ∪ theirs, first-seen order, deduped by deep equality. */
function unionArrays(base: unknown[], ours: unknown[], theirs: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const item of [...base, ...ours, ...theirs]) {
    if (!out.some((existing) => deepEqual(existing, item))) out.push(item);
  }
  return out;
}

export interface FrontmatterMergeResult {
  obj: Record<string, unknown>;
  hadConflicts: boolean;
}

/**
 * Merge three frontmatter objects per-key. `base` may be null (empty/unusable base). A key resolving
 * to `undefined` is treated as deleted and omitted from the result.
 */
export function mergeFrontmatter(
  base: Record<string, unknown> | null,
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
): FrontmatterMergeResult {
  const b = base ?? {};
  // Stable, deterministic key order: base first, then keys ours/theirs introduce.
  const keys: string[] = [];
  for (const k of [...Object.keys(b), ...Object.keys(ours), ...Object.keys(theirs)]) {
    if (!keys.includes(k)) keys.push(k);
  }

  const obj: Record<string, unknown> = {};
  let hadConflicts = false;

  for (const key of keys) {
    const bV = b[key];
    const oV = ours[key];
    const tV = theirs[key];

    let resolved: unknown;
    if (deepEqual(oV, tV)) {
      resolved = oV; // both sides agree (incl. both deleted, both added-same)
    } else if (deepEqual(oV, bV)) {
      resolved = tV; // only theirs changed
    } else if (deepEqual(tV, bV)) {
      resolved = oV; // only ours changed
    } else if (oV === undefined) {
      resolved = tV; // ours deleted, theirs edited → keep the edit
    } else if (tV === undefined) {
      resolved = oV; // theirs deleted, ours edited → keep the edit
    } else if (Array.isArray(oV) && Array.isArray(tV)) {
      resolved = unionArrays(Array.isArray(bV) ? bV : [], oV, tV); // list props: union, lossless
    } else {
      resolved = tV; // differing scalars: prefer remote/S3, converge, no duplicate key
      hadConflicts = true;
    }

    if (resolved !== undefined) obj[key] = resolved;
  }

  return { obj, hadConflicts };
}

export interface FrontmatterNoteMergeResult {
  /** The merged note text, or null when a structural frontmatter merge doesn't apply here. */
  text: string | null;
  hadConflicts: boolean;
}

/**
 * Attempt a frontmatter-aware three-way merge. Returns `{ text: null }` (a signal to fall back to the
 * plain line-based union merge) when it doesn't apply: either ours or theirs has no frontmatter block,
 * or any of the blocks isn't a parseable YAML mapping. The body is merged by the injected `mergeBody`
 * (the same line union merge used everywhere) so behavior there is unchanged.
 */
export function mergeNoteWithFrontmatter(
  base: string,
  ours: string,
  theirs: string,
  mergeBody: (base: string, ours: string, theirs: string) => { text: string; hadConflicts: boolean },
): FrontmatterNoteMergeResult {
  const o = splitFrontmatter(ours);
  const t = splitFrontmatter(theirs);
  // Only structural-merge when BOTH sides carry frontmatter — that's the only shape that can stack
  // duplicate keys. Anything else is left to the line merge.
  if (o.frontmatter === null || t.frontmatter === null) return { text: null, hadConflicts: false };

  const bSplit = splitFrontmatter(base);

  const oObj = parseMapping(o.frontmatter);
  const tObj = parseMapping(t.frontmatter);
  // base may legitimately have no frontmatter (empty/unusable base) → treat as null (all keys added).
  const bObj = bSplit.frontmatter === null ? null : parseMapping(bSplit.frontmatter);
  if (oObj === null || tObj === null || bObj === undefined) return { text: null, hadConflicts: false };

  const fm = mergeFrontmatter(bObj, oObj, tObj);
  // Body base is the base note's body when it had frontmatter, else the whole base text.
  const bodyBase = bSplit.frontmatter === null ? base : bSplit.body;
  const body = mergeBody(bodyBase, o.body, t.body);

  return {
    text: joinFrontmatter(fm.obj, body.text),
    hadConflicts: fm.hadConflicts || body.hadConflicts,
  };
}

/**
 * Parse a YAML block that must be a mapping. Returns the object, or `null` when it doesn't parse or
 * isn't a plain mapping (arrays, scalars, malformed YAML) — the caller then falls back to line merge.
 * Distinct from `undefined`, reserved by the caller for "base had no frontmatter".
 */
function parseMapping(yaml: string): Record<string, unknown> | null {
  try {
    const parsed = parseYaml(yaml);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    // An empty frontmatter block parses to null — treat as an empty mapping, still mergeable.
    if (parsed === null) return {};
    return null;
  } catch {
    return null;
  }
}
