import {
  contentHash,
  decodeText,
  encodeText,
  FileEntry,
  isTombstone,
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

/** IO seam for reconcileFile: raw-byte local/remote access + the merge base. Kept injectable so the
 * byte-clean reconcile can be unit-tested without a real git repo, S3, or filesystem. */
export interface ReconcileIO {
  /** local working-tree bytes, or null if absent */
  readLocal(p: string): Promise<Uint8Array | null>;
  /** live S3 object bytes for a non-tombstone entry */
  fetchRemote(p: string, entry: SnapshotEntry): Promise<Uint8Array | null>;
  writeLocal(p: string, bytes: Uint8Array): Promise<void>;
  removeLocal(p: string): Promise<void>;
  /** decoded text of the file at the last-synced commit (merge base), or "" if unavailable */
  mergeBase(p: string): Promise<string>;
  authorDate(p: string): Promise<string>;
  log(msg: string): void;
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
): Promise<UploadAction | null> {
  const buildUpload = async (content: Uint8Array): Promise<UploadAction> => ({
    content,
    entry: { hash: contentHash(content), size: content.byteLength, mtime: await io.authorDate(p) },
  });

  if (inGit && !inS3) {
    // git → S3
    if (inGit === "delete") {
      const cur = remote.files[p];
      return cur && !isTombstone(cur) ? { tombstone: true } : null;
    }
    const content = await io.readLocal(p);
    if (content === null) return null;
    const remoteEntry = remote.files[p];
    const remoteHash =
      remoteEntry && !isTombstone(remoteEntry) ? (remoteEntry as FileEntry).hash : null;
    return contentHash(content) !== remoteHash ? buildUpload(content) : null; // idempotence (§3.7)
  }

  if (inS3 && !inGit) {
    // S3 → git
    if (isTombstone(inS3)) {
      await io.removeLocal(p);
    } else {
      const content = await io.fetchRemote(p, inS3);
      if (content !== null) await io.writeLocal(p, content);
    }
    return null;
  }

  if (inGit && inS3) {
    // both — union merge (§1.5) for text, or resolve delete-vs-edit: edit wins
    const local = inGit === "delete" ? null : await io.readLocal(p);
    const remoteContent = isTombstone(inS3) ? null : await io.fetchRemote(p, inS3);
    if (local === null && remoteContent === null) return null; // deleted on both sides
    if (local === null) {
      await io.writeLocal(p, remoteContent!); // their edit wins over our delete
      return null;
    }
    if (remoteContent === null) {
      return buildUpload(local); // our edit wins over their delete (un-tombstones)
    }
    // Config files (.obsidian/**) and binary/oversized content resolve by FRESHEST-WINS, in lockstep
    // with the plugin (engine.ts resolveFreshestWins): union-merging JSON duplicates lines and
    // binaries can't three-way merge, while a keep-local rule ping-pongs between divergent copies.
    // Newer author date wins; no bytes are synthesized, so the two legs stay convergent.
    if (isConfigPath(p) || !isTextMergeable(p, local.byteLength, remoteContent.byteLength)) {
      if (contentHash(local) === contentHash(remoteContent)) return null; // already equal
      const remoteMtime = (inS3 as FileEntry).mtime;
      if (remoteMtime > (await io.authorDate(p))) {
        await io.writeLocal(p, remoteContent); // remote is newer → take it, nothing to push up
        return null;
      }
      return buildUpload(local); // git side is newer (or a tie) → keep it and re-push
    }
    // text note within the size cap → three-way union merge
    const merged = unionMerge(await io.mergeBase(p), decodeText(local), decodeText(remoteContent));
    if (merged.hadConflicts) io.log(`union-merged conflict: ${p}`);
    if (merged.text !== decodeText(local)) await io.writeLocal(p, encodeText(merged.text));
    return merged.text !== decodeText(remoteContent) ? buildUpload(encodeText(merged.text)) : null;
  }

  return null;
}
