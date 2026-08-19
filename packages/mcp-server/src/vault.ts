import {
  appendDelta,
  contentHash,
  isTombstone,
  loadRemoteState,
  type Delta,
  type DeltaEntry,
  type FileEntry,
  type Snapshot,
  type StorageAdapter,
} from "@vault-sync/core";
import type { RevPublisher } from "@vault-sync/git-sync/src/notify";

/** Writer id in the delta journal — the other legs echo-suppress only their OWN id, so a constant works. */
export const WRITER_ID = "mcp";
export const FILES_PREFIX = "files/";
/** Lambda request payloads cap at 6 MB and base64 inflates 4/3 — inline uploads stop here. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export type PathKind = "note" | "file";

export interface ListedEntry {
  path: string;
  size: number;
  mtime: string;
}

export function isNotePath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

/**
 * POC visibility scope (MCP Server Design.md §1.1): vault content only. Rejects traversal /
 * absolute / malformed paths and every dot-path (`.obsidian/`, `.sync/`, `.git*`, …), which keeps
 * the exclusion matrix (IMPLEMENTATION.md §6) entirely out of play.
 */
export function isSafeVaultPath(path: string): boolean {
  if (path.length === 0 || path.includes("\\")) return false;
  return path.split("/").every((seg) => seg.length > 0 && !seg.startsWith("."));
}

export class PathError extends Error {}

function assertSafe(path: string): void {
  if (!isSafeVaultPath(path)) throw new PathError(`unsafe or excluded path: ${path}`);
}

/**
 * The MCP server's leg of the sync protocol: a stateless third client (design §1). No cursor, no
 * per-file state — every read re-folds `snapshot ⊕ deltas`, every write CAS-appends at the live
 * journal head. Conflict resolution stays where it already lives: a concurrent device edit is
 * three-way-merged by that device's next pull against the versioned base.
 */
export class VaultClient {
  constructor(
    private storage: StorageAdapter,
    private concurrency = 16,
    /** Announces appended revisions so devices pull them immediately (§4.14). Defaults to a no-op,
     * which is what an unconfigured deployment gets — announcing is optional by design. */
    private revPublisher: RevPublisher = { publish: async () => {} },
  ) {}

  private async state(): Promise<Snapshot> {
    const { state } = await loadRemoteState(this.storage, this.concurrency);
    return state;
  }

  async list(kind: PathKind, dir = "", recursive = true): Promise<ListedEntry[]> {
    if (dir !== "") assertSafe(dir);
    const prefix = dir === "" ? "" : dir.replace(/\/+$/, "") + "/";
    const state = await this.state();
    const out: ListedEntry[] = [];
    for (const [path, entry] of Object.entries(state.files)) {
      if (isTombstone(entry) || !isSafeVaultPath(path)) continue;
      if (!path.startsWith(prefix)) continue;
      if (!recursive && path.slice(prefix.length).includes("/")) continue;
      if ((kind === "note") !== isNotePath(path)) continue;
      const fe = entry as FileEntry;
      out.push({ path, size: fe.size, mtime: fe.mtime });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  /** Live manifest entry for a path, or null if absent/tombstoned. Hidden paths throw. */
  async entry(path: string): Promise<FileEntry | null> {
    assertSafe(path);
    const e = (await this.state()).files[path];
    return e && !isTombstone(e) ? (e as FileEntry) : null;
  }

  /**
   * Content pinned to the journal entry's recorded S3 version: files are PUT before their delta,
   * so the latest object may belong to a write whose delta hasn't landed yet.
   */
  async read(path: string): Promise<{ bytes: Uint8Array; entry: FileEntry } | null> {
    const entry = await this.entry(path);
    if (!entry) return null;
    const obj = await this.storage.get(
      FILES_PREFIX + path,
      entry.s3VersionId ? { versionId: entry.s3VersionId } : undefined,
    );
    if (!obj) return null;
    return { bytes: obj.body, entry };
  }

  /** Blind authoritative write: object first (the journal never references a missing object), then delta. */
  async write(path: string, bytes: Uint8Array): Promise<{ rev: number; hash: string }> {
    assertSafe(path);
    const state = await this.state();
    const put = await this.storage.put(FILES_PREFIX + path, bytes);
    const entry: FileEntry = {
      hash: contentHash(bytes),
      size: bytes.byteLength,
      mtime: new Date().toISOString(),
      ...(put.versionId ? { s3VersionId: put.versionId } : {}),
    };
    const { rev } = await this.append(state.revision + 1, path, entry);
    return { rev, hash: entry.hash };
  }

  /** Journal-only delete: append a tombstone, keep the `files/` object (matches both sync legs). */
  async remove(path: string): Promise<{ rev: number } | null> {
    assertSafe(path);
    const state = await this.state();
    const cur = state.files[path];
    if (!cur || isTombstone(cur)) return null;
    const { rev } = await this.append(state.revision + 1, path, { deleted: true });
    return { rev };
  }

  private async append(startRev: number, path: string, entry: DeltaEntry) {
    // No onLostRace handler: a lost CAS race just retries at rev+1 — this client has no local
    // state to reconcile the winner into, and a later rev already means "we win the fold".
    const result = await appendDelta(this.storage, startRev, (rev): Delta => ({
      rev,
      by: WRITER_ID,
      at: new Date().toISOString(),
      files: { [path]: entry },
    }));
    // Strictly after the append, and best-effort inside the publisher: an edit made through MCP
    // reaches the user's devices in milliseconds instead of at their next poll (§4.14).
    await this.revPublisher.publish(result.rev);
    return result;
  }
}
