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

/**
 * Search budgets. There is no index (MCP Server Design.md §7) — a search folds remote state and
 * reads candidate notes, so every limit here exists to keep one call inside Lambda's wall clock and
 * memory instead of walking a 20k-file vault to the end. Exceeding any of them truncates the result
 * and says so, which is strictly better than a timeout the caller can't interpret.
 */
export const SEARCH_MAX_FILES = 1500;
export const SEARCH_MAX_BYTES = 32 * 1024 * 1024;
/** Per-note ceiling: anything larger is pathological for a markdown vault and is skipped. */
export const SEARCH_MAX_FILE_BYTES = 1024 * 1024;
/** Leaves headroom under the function's 60 s timeout for the fold and the response. */
export const SEARCH_TIME_BUDGET_MS = 20_000;
export const SEARCH_SNIPPET_CHARS = 240;
const SEARCH_DEFAULT_MAX_RESULTS = 20;
const SEARCH_DEFAULT_MATCHES_PER_FILE = 5;

export interface SearchOptions {
  query: string;
  /** Scope to a directory (default: whole vault). */
  dir?: string;
  /** Treat `query` as a JavaScript regular expression instead of a literal substring. */
  regex?: boolean;
  caseSensitive?: boolean;
  /** Stop after this many matching notes (default 20). */
  maxResults?: number;
  /** Matching lines reported per note (default 5). */
  maxMatchesPerFile?: number;
  /** Match paths only — no content is read, so this is one fold and nothing else. */
  pathOnly?: boolean;
  /** Override the wall-clock budget; tests pin it to force the truncation path. */
  timeBudgetMs?: number;
}

export interface SearchMatch {
  /** 1-based line number within the note */
  line: number;
  text: string;
}

export interface SearchHit {
  path: string;
  size: number;
  mtime: string;
  /** true when the path itself matched — such a hit can have no line matches at all */
  pathMatch: boolean;
  matches: SearchMatch[];
}

export interface SearchResult {
  hits: SearchHit[];
  /** notes whose content was actually read */
  scanned: number;
  /** notes in scope before any budget was applied */
  candidates: number;
  /** true when a budget (results, files, bytes, time) cut the scan short */
  truncated: boolean;
  /** present when truncated: which budget stopped it */
  reason?: string;
}

export class SearchError extends Error {}

/** Literal (default) or regex predicate. Case-insensitive unless asked otherwise. */
function buildMatcher(opts: SearchOptions): (text: string) => boolean {
  if (opts.query.length === 0) throw new SearchError("query must not be empty");
  if (!opts.regex) {
    const needle = opts.caseSensitive ? opts.query : opts.query.toLowerCase();
    return (text) => (opts.caseSensitive ? text : text.toLowerCase()).includes(needle);
  }
  let re: RegExp;
  try {
    // Non-global on purpose: a /g/ regex carries lastIndex between .test() calls and would skip
    // every other line.
    re = new RegExp(opts.query, opts.caseSensitive ? "" : "i");
  } catch (err) {
    throw new SearchError(`invalid regular expression: ${err instanceof Error ? err.message : String(err)}`);
  }
  return (text) => re.test(text);
}

function snippet(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > SEARCH_SNIPPET_CHARS ? trimmed.slice(0, SEARCH_SNIPPET_CHARS) + "…" : trimmed;
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

  /**
   * Full-text search over the vault's notes — the fold gives paths, hashes and sizes but no
   * content, so matching means reading candidates. Recently modified notes are read first: when a
   * budget truncates the scan, what survives is the part of the vault most likely to be relevant.
   *
   * Notes only (`.md`). Other files have no text to grep — find them with `list_files`.
   */
  async search(opts: SearchOptions): Promise<SearchResult> {
    const matches = buildMatcher(opts);
    const maxResults = Math.max(1, opts.maxResults ?? SEARCH_DEFAULT_MAX_RESULTS);
    const perFile = Math.max(1, opts.maxMatchesPerFile ?? SEARCH_DEFAULT_MATCHES_PER_FILE);
    const deadline = Date.now() + (opts.timeBudgetMs ?? SEARCH_TIME_BUDGET_MS);

    // One fold for the whole search: `read()` would re-fold per note, turning a search into
    // hundreds of snapshot reads. Entries are carried along so content stays version-pinned.
    const dir = opts.dir ?? "";
    if (dir !== "") assertSafe(dir);
    const prefix = dir === "" ? "" : dir.replace(/\/+$/, "") + "/";
    const state = await this.state();
    const candidates: { path: string; entry: FileEntry }[] = [];
    for (const [path, entry] of Object.entries(state.files)) {
      if (isTombstone(entry) || !isSafeVaultPath(path) || !isNotePath(path)) continue;
      if (!path.startsWith(prefix)) continue;
      candidates.push({ path, entry: entry as FileEntry });
    }
    candidates.sort(
      (a, b) => Date.parse(b.entry.mtime) - Date.parse(a.entry.mtime) || (a.path < b.path ? -1 : 1),
    );

    const hits: SearchHit[] = [];
    let scanned = 0;
    let bytes = 0;
    let reason: string | undefined;

    // Path matches are free — they need no content — so they are collected first and never cost
    // budget. A note that matches by name is usually exactly the one the caller meant.
    const byPath = new Set<string>();
    for (const { path, entry } of candidates) {
      if (!matches(path)) continue;
      byPath.add(path);
      hits.push({ path, size: entry.size, mtime: entry.mtime, pathMatch: true, matches: [] });
      if (hits.length >= maxResults) {
        reason = "result limit reached";
        break;
      }
    }

    if (opts.pathOnly || reason !== undefined) {
      return {
        hits,
        scanned: 0,
        candidates: candidates.length,
        truncated: reason !== undefined,
        ...(reason ? { reason } : {}),
      };
    }

    // Read in chunks the width of the transfer pool so the scan can stop on the first chunk that
    // fills the result set instead of fetching every candidate first.
    const scannable = candidates.filter((c) => !byPath.has(c.path) && c.entry.size <= SEARCH_MAX_FILE_BYTES);
    for (let i = 0; i < scannable.length && !reason; i += this.concurrency) {
      if (Date.now() > deadline) {
        reason = "time budget exhausted";
        break;
      }
      if (scanned >= SEARCH_MAX_FILES) {
        reason = `file budget exhausted (${SEARCH_MAX_FILES} notes)`;
        break;
      }
      if (bytes >= SEARCH_MAX_BYTES) {
        reason = "byte budget exhausted";
        break;
      }
      const chunk = scannable.slice(i, i + this.concurrency);
      const read = await Promise.all(
        chunk.map(async (c) => ({ ...c, bytes: await this.readAt(c.path, c.entry).catch(() => null) })),
      );
      for (const { path, entry, bytes: body } of read) {
        if (!body) continue; // rewritten or expired between the fold and the read — simply not a hit
        scanned++;
        bytes += body.byteLength;
        const found: SearchMatch[] = [];
        const lines = new TextDecoder().decode(body).split("\n");
        for (let n = 0; n < lines.length && found.length < perFile; n++) {
          if (matches(lines[n])) found.push({ line: n + 1, text: snippet(lines[n]) });
        }
        if (found.length === 0) continue;
        hits.push({ path, size: entry.size, mtime: entry.mtime, pathMatch: false, matches: found });
        if (hits.length >= maxResults) {
          reason = "result limit reached";
          break;
        }
      }
    }

    return {
      hits,
      scanned,
      candidates: candidates.length,
      truncated: reason !== undefined,
      ...(reason ? { reason } : {}),
    };
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
    const bytes = await this.readAt(path, entry);
    return bytes ? { bytes, entry } : null;
  }

  /** Content for an entry the caller already folded — no second fold. See `read` for the pinning. */
  private async readAt(path: string, entry: FileEntry): Promise<Uint8Array | null> {
    const obj = await this.storage.get(
      FILES_PREFIX + path,
      entry.s3VersionId ? { versionId: entry.s3VersionId } : undefined,
    );
    return obj ? obj.body : null;
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
