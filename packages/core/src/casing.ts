import { SnapshotEntry, isTombstone } from "./schemas";

/**
 * Case-insensitive, NFC-normalized path identity (§1.2a). Obsidian treats a note's name as
 * case-INSENSITIVE on every platform — `Foo.md`, `foo.md`, `FOO.md` are one node, wikilinks resolve
 * across case, and the graph shows a single vertex (confirmed against Obsidian's own docs). Our S3
 * keys, by contrast, are case-SENSITIVE, so a case-only rename manufactures two keys for one node —
 * the very "file created with different casing outside Obsidian" case Obsidian itself punts on. To
 * keep the protocol aligned with Obsidian's identity model, BOTH legs collapse case/normalization
 * variants of a key to one logical node via this canonical key.
 *
 * NFC matters as much as case here: macOS/APFS and Android surface Cyrillic/accented names in
 * decomposed (NFD) form, so `"её".normalize("NFD")` and its composed form are byte-different keys for
 * the same node. Normalize THEN casefold.
 */
export function canonicalKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/** Two paths address the same logical node (same file to Obsidian) — differ only by case/normalization. */
export function sameNode(a: string, b: string): boolean {
  return canonicalKey(a) === canonicalKey(b);
}

/**
 * Collapse case/normalization-variant keys of one logical node down to a single winner, keyed by the
 * winner's DISPLAY path (its stored case). This is what makes case-insensitive identity a protocol
 * invariant: derived state (folded snapshots, a client's changed-entry set) never carries two entries
 * for one node, so a case-only rename can neither duplicate the note (two live keys) nor delete it
 * (a stale-cased tombstone applied over the live file — the Android data-loss bug).
 *
 * Winner rule, deterministic on both legs so their state stays byte-identical:
 *   1. highest `rev` wins (freshest write);
 *   2. on a rev tie, a LIVE entry beats a tombstone — a rename emits `delete(old)`+`add(new)` at the
 *      SAME rev, and the surviving node is the live destination;
 *   3. on a further tie (two lives, e.g. a legacy duplicate), the lexicographically-greater path wins
 *      purely for determinism — such entries have identical content, so only the display case differs.
 */
export function collapseNodes<E extends SnapshotEntry>(
  entries: Iterable<readonly [string, E]>,
): Map<string, E> {
  const groups = new Map<string, [string, E][]>();
  for (const [path, entry] of entries) {
    const k = canonicalKey(path);
    const g = groups.get(k);
    if (g) g.push([path, entry]);
    else groups.set(k, [[path, entry]]);
  }
  const out = new Map<string, E>();
  for (const group of groups.values()) {
    let win = group[0];
    for (let i = 1; i < group.length; i++) {
      if (beats(group[i], win)) win = group[i];
    }
    out.set(win[0], win[1]);
  }
  return out;
}

function beats<E extends SnapshotEntry>(a: [string, E], b: [string, E]): boolean {
  if (a[1].rev !== b[1].rev) return a[1].rev > b[1].rev;
  const at = isTombstone(a[1]);
  const bt = isTombstone(b[1]);
  if (at !== bt) return !at; // live beats tombstone at the same rev (the rename destination)
  return a[0] > b[0]; // deterministic final tiebreak; identical content, display case only
}
