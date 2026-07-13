import { describe, expect, it } from "vitest";
import { contentHash, decodeText, encodeText, SnapshotEntry } from "@vault-sync/core";
import { makeMergeBaseResolver, MergeBaseGit, SYNC_BOT_AUTHOR } from "../src/merge-base";
import { reconcileFile, ReconcileIO } from "../src/reconcile";

/** Fake Git backed by an in-memory commit→(path→content) map. `lastBot` names git-sync's most
 * recent sync commit (what lastCommitBy(SYNC_BOT_AUTHOR) returns). */
function fakeGit(
  commits: Record<string, Record<string, string>>,
  lastBot: string | null,
): MergeBaseGit & { calls: string[] } {
  return {
    calls: [],
    async lastCommitBy(author) {
      this.calls.push(`lastCommitBy:${author}`);
      return author === SYNC_BOT_AUTHOR ? lastBot : null;
    },
    async showAt(commit, path) {
      return commits[commit]?.[path] ?? null;
    },
  };
}

const enc = encodeText;

describe("makeMergeBaseResolver", () => {
  it("prefers git-sync's own last sync commit over the pre-commit cursor", async () => {
    const git = fakeGit({ SYNC: { "n.md": "from-sync" }, CURSOR: { "n.md": "from-cursor" } }, "SYNC");
    const base = await makeMergeBaseResolver(git, "CURSOR");
    expect(await base("n.md")).toBe("from-sync");
  });

  it("falls back to the warm cursor when there is no sync commit yet", async () => {
    const git = fakeGit({ CURSOR: { "n.md": "from-cursor" } }, null);
    const base = await makeMergeBaseResolver(git, "CURSOR");
    expect(await base("n.md")).toBe("from-cursor");
  });

  it("returns '' when neither a sync commit nor a warm cursor exists (fresh repo)", async () => {
    const git = fakeGit({}, null);
    const base = await makeMergeBaseResolver(git, null);
    expect(await base("anything.md")).toBe("");
  });

  it("returns '' for a path absent from the base commit", async () => {
    const git = fakeGit({ SYNC: { "other.md": "x" } }, "SYNC");
    const base = await makeMergeBaseResolver(git, "CURSOR");
    expect(await base("n.md")).toBe("");
  });

  it("resolves the bot commit once per run, not once per path", async () => {
    const git = fakeGit({ SYNC: { "a.md": "1", "b.md": "2" } }, "SYNC");
    const base = await makeMergeBaseResolver(git, "CURSOR");
    await base("a.md");
    await base("b.md");
    expect(git.calls.filter((c) => c.startsWith("lastCommitBy")).length).toBe(1);
  });
});

// The note-triplication regression. Timeline (single editing device, no second client):
//   C_MINUS1  older content, at the pre-commit-HEAD cursor (`state.lastSyncedCommit`)
//   C0        the device's first edit — git-sync wrote it into git from S3 last run (its SYNC commit)
//   C1        the device's NEXT edit, now live in S3 (same Инвентаризация table, +a row)
// This run sees the note as BOTH inGit (git-sync's own C0 commit) and inS3 (the device's C1), so it
// three-way merges. With the stale cursor base (C_MINUS1) the whole table duplicates; with the fix
// the base is C0 (the SYNC commit), so ours==base and the merge takes C1 cleanly.
describe("regression: single-device table triplication via stale merge base", () => {
  const C_MINUS1 = "# datahub\n\nintro\n";
  const C0 = "# datahub\n\nintro\n\n| Инвентаризация |\n| a |\n";
  const C1 = "# datahub\n\nintro\n\n| Инвентаризация |\n| a |\n| b |\n";
  const tableCount = (s: string) => s.match(/Инвентаризация/g)?.length ?? 0;

  function runReconcile(base: (p: string) => Promise<string>) {
    const remote: SnapshotEntry = {
      hash: contentHash(enc(C1)),
      size: enc(C1).byteLength,
      mtime: "2026-07-13T00:00:00.000Z",
      s3VersionId: "v1",
      rev: 5,
      by: "obsidian", // NOT git-sync, so it is a real S3-side change
    } as SnapshotEntry;
    let written: string | null = null;
    const io: ReconcileIO = {
      readLocal: async () => enc(C0), // working tree = git-sync's own last write
      fetchRemote: async () => enc(C1), // live S3 = device's newer edit
      writeLocal: async (_p, b) => void (written = decodeText(b)),
      removeLocal: async () => {},
      mergeBase: base,
      authorDate: async () => "2026-07-13T00:00:00.000Z",
      log: () => {},
    };
    return { io, remote, getWritten: () => written };
  }

  it("defense-in-depth: even a STALE base no longer duplicates (conflict-region dedup)", async () => {
    // No bot commit → resolver falls back to the stale CURSOR base (the pre-fix failure input).
    // The merge-base fix is the primary guard; unionMerge's conflict-region dedup is the safety net,
    // so this once-corrupting input now yields a single clean table instead of a duplicated one.
    const git = fakeGit({ CURSOR: { "n.md": C_MINUS1 }, SYNC: { "n.md": C0 } }, null);
    const base = await makeMergeBaseResolver(git, "CURSOR");
    const { io, remote, getWritten } = runReconcile(base);
    await reconcileFile("n.md", "upsert", remote, { files: { "n.md": remote } }, io);
    expect(tableCount(getWritten()!)).toBe(1); // no duplication despite the stale base
  });

  it("fixed base (git-sync's own sync commit) merges cleanly — no duplication, no bad re-upload", async () => {
    const git = fakeGit({ CURSOR: { "n.md": C_MINUS1 }, SYNC: { "n.md": C0 } }, "SYNC");
    const base = await makeMergeBaseResolver(git, "CURSOR");
    const { io, remote, getWritten } = runReconcile(base);
    const action = await reconcileFile("n.md", "upsert", remote, { files: { "n.md": remote } }, io);

    expect(tableCount(getWritten()!)).toBe(1); // git working tree ends at the single clean table
    expect(getWritten()).toBe(C1); // took the device's edit
    expect(action).toBeNull(); // ours==base ⇒ result==S3 ⇒ nothing pushed back (no dup echo)
  });
});
