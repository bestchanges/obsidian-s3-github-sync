/**
 * Merge-base resolution for git-sync's three-way union merge (§3.5).
 *
 * The base MUST be the last state where git and S3 provably agreed — i.e. git-sync's own most
 * recent sync commit, whose content it wrote verbatim from S3. It must NOT be the pre-commit HEAD
 * cursor (`state.lastSyncedCommit`): that cursor points at the HEAD from *before* git-sync's last
 * sync commit (see main.ts, where lastSyncedCommit is deliberately the pre-commit HEAD to avoid a
 * state-only commit each run). Using it as the base means the base predates content git-sync itself
 * committed. When the same path then also has a newer real S3 edit, the git working tree (git-sync's
 * own last write) and the S3 side both differ from that stale base, so diff3 flags the whole changed
 * block as a two-sided conflict and the union merge DUPLICATES it — the note-triplication bug.
 *
 * Anchoring the base at the last sync commit fixes it: for a path git-sync itself last wrote (no
 * human edit since), base == working tree, so unionMerge short-circuits to the S3 side (clean, no
 * duplication); for a genuine human git edit layered on top, the base is still the correct common
 * ancestor, so the real three-way merge is unaffected.
 */

/** git author (name/email) of git-sync's own sync commits — see Git.commit(). */
export const SYNC_BOT_AUTHOR = "s3-sync-bot";

export interface MergeBaseGit {
  /** SHA of the most recent commit by `author` reachable from HEAD, or null. */
  lastCommitBy(author: string): Promise<string | null>;
  /** decoded file content at a commit, or null if absent there. */
  showAt(commit: string, path: string): Promise<string | null>;
}

export interface DiffBaseGit {
  /** SHA of the most recent commit by `author` reachable from HEAD, or null. */
  lastCommitBy(author: string): Promise<string | null>;
  isAncestor(maybeAncestor: string, of: string): Promise<boolean>;
}

/**
 * Resolve the base commit for the git-side change diff (warm path). Same stale-cursor hazard as the
 * merge base above, but with a worse failure mode: diffing from `cursor` (the pre-commit HEAD)
 * re-reports the last run's OWN sync commit's writes as git edits. For files still live in S3 the
 * hash-idempotence check drops them — but for a file the vault renamed/deleted since, the false
 * "edit" beats the S3 tombstone (delete-vs-edit: edit wins) and git-sync RESURRECTS the old path
 * with stale content (the rename-resurrection bug). Anchoring the diff at git-sync's own last sync
 * commit removes the false upsert at the source: that commit's tree IS the state S3 already has, so
 * only human commits after it can be genuine git-side changes. The ancestry guard keeps the cursor
 * when the bot commit predates it (last run committed nothing) — using an older base would re-widen
 * the diff over already-synced human commits and reopen the same hole.
 */
export async function resolveDiffBase(git: DiffBaseGit, cursor: string): Promise<string> {
  const lastSync = await git.lastCommitBy(SYNC_BOT_AUTHOR);
  return lastSync && (await git.isAncestor(cursor, lastSync)) ? lastSync : cursor;
}

/**
 * Resolve, once per run, the per-path merge-base function for reconcileFile. Prefers git-sync's own
 * last sync commit; falls back to `fallbackCommit` (the last-synced cursor, only when it is a valid
 * warm ancestor) and finally to "" (no common ancestor — e.g. a brand-new repo's first sync).
 */
export async function makeMergeBaseResolver(
  git: MergeBaseGit,
  fallbackCommit: string | null,
): Promise<(path: string) => Promise<string>> {
  const syncBaseCommit = (await git.lastCommitBy(SYNC_BOT_AUTHOR)) ?? fallbackCommit;
  return async (path: string): Promise<string> =>
    syncBaseCommit ? ((await git.showAt(syncBaseCommit, path)) ?? "") : "";
}
