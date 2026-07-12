#!/usr/bin/env tsx
/**
 * git-sync: two-way sync between the checked-out repo (cwd or REPO_DIR) and S3.
 * Design doc §3. Runs in GitHub Actions on push / cron / manual dispatch.
 *
 * Env: BUCKET (required), PREFIX, AWS_REGION, REPO_DIR, RETENTION_DAYS
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import ignoreFactory from "ignore";
import {
  appendDelta,
  Delta,
  DeltaEntry,
  FileEntry,
  foldDeltas,
  isTombstone,
  listDeltasSince,
  mapPool,
  pruneDeltas,
  readSnapshot,
  SnapshotEntry,
  writeSnapshot,
} from "@vault-sync/core";
import { Git } from "./git";
import { S3SdkAdapter } from "./s3-adapter";
import { reconcileFile, ReconcileIO, UploadAction } from "./reconcile";
import { makeMergeBaseResolver } from "./merge-base";

const WRITER_ID = "git-sync";
const STATE_PATH = ".sync/state.json";
const S3SYNCIGNORE = ".s3syncignore";
const CONCURRENCY = 50;
/** Files larger than this stay S3-only — never pulled into git (GitHub's 100MB hard limit; keeps the repo lean). */
const DEFAULT_MAX_GIT_FILE_BYTES = 25 * 1024 * 1024;

interface SyncStateFile {
  lastSyncedRev: number;
  lastSyncedCommit: string | null;
}

function log(msg: string): void {
  console.log(`[git-sync] ${msg}`);
}

/** Reject anything that could escape the repo. */
function isSafeRelPath(p: string): boolean {
  return (
    p.length > 0 &&
    !path.isAbsolute(p) &&
    !p.split("/").includes("..") &&
    !p.startsWith(".git/") &&
    p !== ".git"
  );
}

async function main(): Promise<void> {
  const bucket = process.env.BUCKET;
  if (!bucket) throw new Error("BUCKET env var is required");
  const repoDir = path.resolve(process.env.REPO_DIR ?? process.cwd());
  const retentionDays = Number(process.env.RETENTION_DAYS ?? "30");
  const storage = new S3SdkAdapter(bucket, process.env.PREFIX ?? "", process.env.AWS_REGION);
  const git = new Git(repoDir);

  // ---- load local state -------------------------------------------------
  let state: SyncStateFile = { lastSyncedRev: 0, lastSyncedCommit: null };
  try {
    state = JSON.parse(await fs.readFile(path.join(repoDir, STATE_PATH), "utf8")) as SyncStateFile;
  } catch {
    log("no .sync/state.json — first run (full sync)");
  }

  const head = await git.headSha();

  // ---- GitHub-only exclusions (.s3syncignore, §3.4) ----------------------
  const ig = ignoreFactory();
  try {
    ig.add(await fs.readFile(path.join(repoDir, S3SYNCIGNORE), "utf8"));
  } catch {
    /* optional file */
  }
  // git-side-only metadata stays out of S3 in BOTH directions: never pushed, and an S3 tombstone
  // for one is ignored (so a vault that lacks .gitignore can't delete it from the repo).
  ig.add([
    STATE_PATH, S3SYNCIGNORE, ".sync/", ".github/", ".sync-tool/",
    ".gitignore", ".gitattributes", ".gitmodules", ".git/",
    // per-device / never-sync — kept in lockstep with the plugin's isExcluded() so neither leg
    // tombstones what the other keeps. Enforced here (not only via .gitignore) so a missing or
    // misconfigured .gitignore can't leak them. NOTE: only vault-s3-sync's OWN data.json is
    // per-device; other plugins' data.json syncs so their settings distribute across devices.
    ".DS_Store", ".trash/",
    ".obsidian/workspace*.json", "state.json.gz",
    ".obsidian/plugins/vault-s3-sync/data.json",
  ]);

  // ---- detect git-side changes (§3.3 step 3) -----------------------------
  let gitChanged: Map<string, "upsert" | "delete">;
  const warmGit =
    state.lastSyncedCommit !== null && (await git.isAncestor(state.lastSyncedCommit, head));
  if (warmGit) {
    gitChanged = new Map(
      (await git.diffNameStatus(state.lastSyncedCommit!, head)).map((c) => [
        c.path,
        c.status === "D" ? "delete" : "upsert",
      ]),
    );
  } else {
    if (state.lastSyncedCommit) log("history rewritten — falling back to full-state diff");
    gitChanged = new Map((await git.trackedFiles()).map((p) => [p, "upsert"]));
  }
  for (const p of [...gitChanged.keys()]) {
    if (ig.ignores(p) || !isSafeRelPath(p)) gitChanged.delete(p);
  }

  // ---- detect S3-side changes (§3.3 steps 2+4) ---------------------------
  // Always fold snapshot ⊕ deltas: uniform warm/cold path, Actions bandwidth is free.
  const snap = await readSnapshot(storage);
  const snapshotRev = snap?.snapshot.revision ?? 0;
  const deltasAfterSnapshot = await listDeltasSince(storage, snapshotRev, CONCURRENCY);
  const remote = foldDeltas(snap?.snapshot ?? null, deltasAfterSnapshot);

  const s3Changed = new Map<string, SnapshotEntry>();
  for (const [p, entry] of Object.entries(remote.files)) {
    if (entry.rev > state.lastSyncedRev && entry.by !== WRITER_ID) s3Changed.set(p, entry);
  }
  for (const p of [...s3Changed.keys()]) {
    if (!isSafeRelPath(p)) {
      log(`WARN: unsafe path from S3 skipped: ${p}`);
      s3Changed.delete(p);
    } else if (ig.ignores(p)) {
      log(`WARN: S3 delta under GitHub-only path skipped: ${p}`);
      s3Changed.delete(p);
    }
  }
  // .gitignore'd paths from S3 stay S3-only (§3.4)
  const gitIgnored = await git.checkIgnore([...s3Changed.keys()]);
  for (const p of gitIgnored) {
    log(`skip (.gitignore, stays S3-only): ${p}`);
    s3Changed.delete(p);
  }
  // Oversized files stay S3-only: never write them into the git tree (size is in the manifest,
  // so no download needed). Guards against GitHub's file-size limit wedging the push.
  const maxGitFileBytes = Number(process.env.GIT_MAX_FILE_BYTES ?? DEFAULT_MAX_GIT_FILE_BYTES);
  for (const [p, entry] of [...s3Changed]) {
    const size = (entry as FileEntry & SnapshotEntry).size;
    if (!isTombstone(entry) && typeof size === "number" && size > maxGitFileBytes) {
      log(`skip (${size}B > ${maxGitFileBytes}B, stays S3-only): ${p}`);
      s3Changed.delete(p);
    }
  }

  log(
    `HEAD=${head.slice(0, 8)} lastRev=${state.lastSyncedRev} remoteRev=${remote.revision} ` +
      `gitChanged=${gitChanged.size} s3Changed=${s3Changed.size}`,
  );

  // ---- reconcile (§3.3 step 5) -------------------------------------------
  // Content is handled as RAW BYTES throughout; text is decoded only inside the union-merge branch.
  // Reading/writing binary files as UTF-8 corrupts and inflates them (invalid bytes → U+FFFD).
  const uploads = new Map<string, UploadAction>();
  const allPaths = new Set([...gitChanged.keys(), ...s3Changed.keys()]);

  // Anchor the merge base at git-sync's OWN last sync commit (where git and S3 last agreed), NOT the
  // pre-commit HEAD cursor which predates that commit's own writes — a stale base makes a self-
  // committed file that also has a newer S3 edit duplicate the whole changed block (§3.5, merge-base.ts).
  const mergeBase = await makeMergeBaseResolver(git, warmGit ? state.lastSyncedCommit : null);

  const io: ReconcileIO = {
    readLocal: async (p) => {
      try {
        return await fs.readFile(path.join(repoDir, p)); // no encoding → raw Buffer (a Uint8Array)
      } catch {
        return null;
      }
    },
    fetchRemote: async (p, entry) => {
      const obj = await storage.get(`files/${p}`, {
        versionId: (entry as FileEntry & SnapshotEntry).s3VersionId,
      });
      return obj ? obj.body : null;
    },
    writeLocal: async (p, bytes) => {
      const abs = path.join(repoDir, p);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, bytes); // raw bytes, no encoding
    },
    removeLocal: async (p) => {
      await fs.rm(path.join(repoDir, p), { force: true });
    },
    mergeBase,
    authorDate: (p) => git.authorDateIso(p),
    log,
  };

  await mapPool([...allPaths], CONCURRENCY, async (p) => {
    const action = await reconcileFile(p, gitChanged.get(p), s3Changed.get(p), remote, io);
    if (action) uploads.set(p, action);
  });

  // ---- push to S3: files, then one delta (§1.3) ---------------------------
  let newRev = remote.revision;
  if (uploads.size > 0) {
    const files: Record<string, DeltaEntry> = {};
    await mapPool([...uploads.entries()], CONCURRENCY, async ([p, u]) => {
      if ("tombstone" in u) {
        files[p] = { deleted: true };
      } else {
        const res = await storage.put(`files/${p}`, u.content); // raw bytes
        files[p] = { ...u.entry, s3VersionId: res.versionId };
      }
    });
    const result = await appendDelta(
      storage,
      remote.revision + 1,
      (rev): Delta => ({ rev, by: WRITER_ID, at: new Date().toISOString(), files }),
      (winner) => log(`lost CAS race to ${winner.by}@${winner.rev}; retrying`),
    );
    newRev = result.rev;
    log(`appended delta rev=${newRev} (${uploads.size} entries)`);
  }

  // ---- compaction (§3.3 step 8) -------------------------------------------
  const allNewDeltas = await listDeltasSince(storage, snapshotRev, CONCURRENCY);
  if (allNewDeltas.length > 0) {
    const newSnapshot = foldDeltas(snap?.snapshot ?? null, allNewDeltas);
    await writeSnapshot(storage, newSnapshot, snap?.etag);
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    const pruned = await pruneDeltas(storage, newSnapshot.revision, cutoff, CONCURRENCY);
    log(`compacted snapshot to rev=${newSnapshot.revision}, pruned ${pruned} deltas`);
    newRev = Math.max(newRev, newSnapshot.revision);
  }

  // ---- commit + push git side (§3.3 steps 6+9) ----------------------------
  const finalRev = Math.max(newRev, remote.revision);
  await fs.mkdir(path.join(repoDir, ".sync"), { recursive: true });
  await fs.writeFile(
    path.join(repoDir, STATE_PATH),
    JSON.stringify({ lastSyncedRev: finalRev, lastSyncedCommit: head } satisfies SyncStateFile, null, 2) + "\n",
  );
  await git.stageAll();
  if (await git.hasStagedChanges()) {
    // NOTE: lastSyncedCommit intentionally points at the PRE-commit HEAD. The next run
    // will therefore see this sync commit's own files in its diff — but they hash-equal
    // the S3 state, so the idempotence check skips them, and the by=git-sync delta is
    // echo-suppressed. One commit, no state-commit regress.
    await git.commit(`s3-sync: rev ${finalRev} [skip ci]`);
    await git.push();
    log(`committed + pushed (${(await git.headSha()).slice(0, 8)})`);
  } else {
    log("nothing to commit");
  }
  log("done");
}

main().catch((err) => {
  console.error("[git-sync] FAILED:", err);
  process.exit(1);
});
