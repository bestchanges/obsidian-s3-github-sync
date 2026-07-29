import {
  contentHash,
  decodeText,
  encodeText,
  FileEntry,
  isTombstone,
  remoteIsFresher,
  SnapshotEntry,
  unionMerge,
} from "@vault-sync/core";

/** extensions we union-merge; everything else is last-writer-wins on raw bytes. Kept in lockstep
 * with the plugin's TEXT_EXTS (engine.ts §2.6) — the merge is byte-identical only if both legs
 * classify text the same way. NON-text files (images, PDFs, …) are handled as raw bytes end to end:
 * decoding them as UTF-8 corrupts and inflates them (invalid bytes → U+FFFD). */
const TEXT_EXTS = new Set([
  "md", "txt", "json", "csv", "canvas", "yml", "yaml", "html", "css", "js", "ts", "svg", "mermaid",
]);
const LWW_SIZE_LIMIT = 5 * 1024 * 1024; // >5 MB: never union-merge (§2.6)

function isTextPath(p: string): boolean {
  return TEXT_EXTS.has(p.split(".").pop()?.toLowerCase() ?? "");
}
/** Config-dir files (.obsidian/**): resolved by freshest-wins, NOT union-merge, in lockstep with the
 * plugin (engine.ts usesFreshestWins). Line-merging JSON/config duplicates lines; freshest-wins takes
 * the whole newer side and converges. Note: the repo mirrors the vault, so ".obsidian" is the dir. */
function isConfigPath(p: string): boolean {
  return p.startsWith(".obsidian/");
}
/** Union-merge only when BOTH sides are text-classified and within the size cap; otherwise the two
 * versions are raw bytes we can't three-way merge, so fall back to last-writer-wins. */
function isTextMergeable(p: string, aLen: number, bLen: number): boolean {
  return isTextPath(p) && aLen <= LWW_SIZE_LIMIT && bLen <= LWW_SIZE_LIMIT;
}

export type UploadAction = { content: Uint8Array; entry: FileEntry } | { tombstone: true };

/** What reconcileFile did with a path, for logging. The action alone can't tell a pull from a
 * local-only no-op, nor new-vs-update, nor whether a union merge hit conflicts — reconcileFile is the
 * only place that knows, so it reports it (main.ts aggregates these into the per-cycle detail log). */
export type ReconcileOutcome =
  | { kind: "noop" }
  | { kind: "pushed"; created: boolean } // git → S3 (created = new/untombstoned key vs update)
  | { kind: "tombstoned" } // git delete → S3 tombstone
  | { kind: "pulled"; created: boolean } // S3 → git write (created = local file didn't exist)
  | { kind: "deletedLocal" } // S3 tombstone → local removed
  | { kind: "merged"; conflicts: boolean }; // union merge applied

export interface ReconcileResult {
  action: UploadAction | null;
  outcome: ReconcileOutcome;
}

const NOOP: ReconcileResult = { action: null, outcome: { kind: "noop" } };

/** IO seam for reconcileFile: raw-byte local/remote access + the merge base. Kept injectable so the
 * byte-clean reconcile can be unit-tested without a real git repo, S3, or filesystem. */
export interface ReconcileIO {
  /** local working-tree bytes, or null if absent */
  readLocal(p: string): Promise<Uint8Array | null>;
  /** whether the path currently exists in the working tree (for new-vs-update classification) */
  existsLocal(p: string): Promise<boolean>;
  /** live S3 object bytes for a non-tombstone entry */
  fetchRemote(p: string, entry: SnapshotEntry): Promise<Uint8Array | null>;
  writeLocal(p: string, bytes: Uint8Array): Promise<void>;
  removeLocal(p: string): Promise<void>;
  /** decoded text of the file at the last-synced commit (merge base), or "" if unavailable */
  mergeBase(p: string): Promise<string>;
  authorDate(p: string): Promise<string>;
}

/** Reconcile ONE path between git and S3. Returns the S3 upload to queue (or null), performing any
 * local-tree write/delete via `io`. Content is RAW BYTES throughout; text is decoded only for the
 * union merge — decoding a binary file as UTF-8 corrupts and inflates it (invalid bytes → U+FFFD),
 * which is exactly the bug this byte-clean path prevents. */
export async function reconcileFile(
  p: string,
  inGit: "upsert" | "delete" | undefined,
  inS3: SnapshotEntry | undefined,
  remote: { files: Record<string, SnapshotEntry> },
  io: ReconcileIO,
): Promise<ReconcileResult> {
  // git → S3 upload; `created` distinguishes a brand-new/untombstoned key from an update, for logging.
  const pushUpload = async (content: Uint8Array): Promise<ReconcileResult> => {
    const cur = remote.files[p];
    const created = !cur || isTombstone(cur);
    return {
      action: {
        content,
        entry: { hash: contentHash(content), size: content.byteLength, mtime: await io.authorDate(p) },
      },
      outcome: { kind: "pushed", created },
    };
  };
  // S3 → git write; `created` reflects whether the working tree lacked the file before this write.
  const pullWrite = async (content: Uint8Array): Promise<ReconcileResult> => {
    const created = !(await io.existsLocal(p));
    await io.writeLocal(p, content);
    return { action: null, outcome: { kind: "pulled", created } };
  };

  if (inGit && !inS3) {
    // git → S3
    if (inGit === "delete") {
      const cur = remote.files[p];
      return cur && !isTombstone(cur)
        ? { action: { tombstone: true }, outcome: { kind: "tombstoned" } }
        : NOOP;
    }
    const content = await io.readLocal(p);
    if (content === null) return NOOP;
    const remoteEntry = remote.files[p];
    const remoteHash =
      remoteEntry && !isTombstone(remoteEntry) ? (remoteEntry as FileEntry).hash : null;
    return contentHash(content) !== remoteHash ? pushUpload(content) : NOOP; // idempotence (§3.7)
  }

  if (inS3 && !inGit) {
    // S3 → git
    if (isTombstone(inS3)) {
      if (!(await io.existsLocal(p))) return NOOP; // already gone locally
      await io.removeLocal(p);
      return { action: null, outcome: { kind: "deletedLocal" } };
    }
    const content = await io.fetchRemote(p, inS3);
    return content !== null ? pullWrite(content) : NOOP;
  }

  if (inGit && inS3) {
    // both — union merge (§1.5) for text, or resolve delete-vs-edit: edit wins
    const local = inGit === "delete" ? null : await io.readLocal(p);
    const remoteContent = isTombstone(inS3) ? null : await io.fetchRemote(p, inS3);
    if (local === null && remoteContent === null) return NOOP; // deleted on both sides
    if (local === null) {
      return pullWrite(remoteContent!); // their edit wins over our delete
    }
    if (remoteContent === null) {
      // delete-vs-edit (§1.5): S3 tombstoned this path but git still holds a copy. Un-tombstone
      // (keep & re-push) ONLY when the git edit is at least as fresh as the delete. A git copy
      // STRICTLY OLDER than the tombstone is a stale divergence — most often a file another device
      // renamed away (rename = delete(old)+add(new)) — so let the delete win and remove it locally
      // instead of resurrecting the old path. Mirrors the plugin's editWinsOverDelete (engine.ts).
      // A tombstone from an older journal carries no `at` → keep the historical un-tombstone behavior.
      const deletedAt = (inS3 as { at?: string }).at;
      if (deletedAt && remoteIsFresher(deletedAt, await io.authorDate(p))) {
        await io.removeLocal(p);
        return { action: null, outcome: { kind: "deletedLocal" } };
      }
      return pushUpload(local); // our (fresher) edit wins over their delete (un-tombstones)
    }
    // Config files (.obsidian/**) and binary/oversized content resolve without a line merge (JSON
    // duplicates lines, binaries can't three-way merge), in lockstep with the plugin (engine.ts).
    if (isConfigPath(p) || !isTextMergeable(p, local.byteLength, remoteContent.byteLength)) {
      if (contentHash(local) === contentHash(remoteContent)) return NOOP; // already equal
      // Base-aware fast-forward FIRST: if one side's content equals the base git and S3 last agreed
      // on, that side didn't really change — it's a no-op re-push — so take the OTHER side outright,
      // with NO timestamp race. This is what stops a stale re-upload of the OLD content from winning
      // freshest-wins and reverting a genuine edit (the manifest 0.2.1→0.2.0 revert). Text only: the
      // merge base is decoded text (reliable for JSON/JS/config, meaningless for binary).
      if (isTextPath(p)) {
        const base = await io.mergeBase(p);
        if (base !== "") {
          const localText = decodeText(local);
          const remoteText = decodeText(remoteContent);
          if (remoteText === base && localText !== base) return pushUpload(local); // remote unchanged → git wins
          if (localText === base && remoteText !== base) {
            return pullWrite(remoteContent); // git unchanged → S3 wins, nothing to push up
          }
        }
      }
      // Genuine divergence (both differ from base): FRESHEST-WINS. Newer author date wins, compared
      // chronologically not lexicographically (remoteIsFresher); no bytes are synthesized, so the two
      // legs stay convergent even if clock skew makes them pick different sides on one pass.
      const remoteMtime = (inS3 as FileEntry).mtime;
      if (remoteIsFresher(remoteMtime, await io.authorDate(p))) {
        return pullWrite(remoteContent); // remote is newer → take it, nothing to push up
      }
      return pushUpload(local); // git side is newer (or a tie) → keep it and re-push
    }
    // text note within the size cap → three-way union merge
    const merged = unionMerge(await io.mergeBase(p), decodeText(local), decodeText(remoteContent));
    if (merged.text !== decodeText(local)) await io.writeLocal(p, encodeText(merged.text));
    const action =
      merged.text !== decodeText(remoteContent)
        ? (await pushUpload(encodeText(merged.text))).action
        : null;
    return { action, outcome: { kind: "merged", conflicts: merged.hadConflicts } };
  }

  return NOOP;
}
