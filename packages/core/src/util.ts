/**
 * Freshest-wins timestamp test, shared by BOTH sync legs so they resolve `.obsidian/**` /
 * binary conflicts identically (§2.6). Returns true iff `remoteMtime` is strictly newer than
 * `localMtime` — a tie keeps local, matching the prior rule.
 *
 * The mtimes MUST be compared chronologically, not lexicographically: the two legs emit them in
 * different shapes — git-sync writes `git %aI` (`2026-07-20T11:30:35+00:00`, offset form, no
 * millis) while the plugin writes `new Date(stat.mtime).toISOString()` (`…35.000Z`, `Z` form, with
 * millis) — and users commit in non-UTC offsets. Raw string `>` then diverges from real time order
 * (`…+07:00` sorts above a later `…Z`, and identical instants in the two shapes compare unequal),
 * which let a stale copy win freshest-wins and clobber a newer one. Date.parse handles every ISO
 * shape both legs produce, so epoch-ms comparison is sound across formats and timezones.
 *
 * Fallback: if EITHER side is unparseable (e.g. an empty local mtime when a stat is missing), drop
 * back to the old deterministic string compare so the result stays defined on both legs.
 */
export function remoteIsFresher(remoteMtime: string, localMtime: string): boolean {
  const r = Date.parse(remoteMtime);
  const l = Date.parse(localMtime);
  if (Number.isNaN(r) || Number.isNaN(l)) return remoteMtime > localMtime;
  return r > l;
}

/** Map over items with bounded concurrency (mobile: 8, desktop/CI: 50 — §1.8). */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
