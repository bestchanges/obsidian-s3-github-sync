import { diff3Merge } from "node-diff3";

/**
 * Three-way UNION merge — the single merge implementation for BOTH sync legs
 * (design doc §1.5, §5). Conflict policy: include all changes in one —
 * ours-lines then theirs-lines, no conflict markers, nothing lost.
 * Identical output on both legs is required: divergent merge results would
 * echo back through sync as phantom changes.
 */
export interface UnionMergeResult {
  text: string;
  hadConflicts: boolean;
}

export function unionMerge(base: string, ours: string, theirs: string): UnionMergeResult {
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
      out.push(...region.conflict.a, ...region.conflict.b);
    }
  }
  return { text: out.join("\n"), hadConflicts };
}
