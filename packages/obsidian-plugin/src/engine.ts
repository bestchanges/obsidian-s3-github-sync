import { Notice, Vault } from "obsidian";
import {
  appendDelta,
  canonicalKey,
  changedEntries,
  contentHash,
  decodeText,
  Delta,
  DeltaEntry,
  encodeText,
  FileEntry,
  GetResult,
  hasGap,
  isTombstone,
  listDeltasSince,
  loadRemoteState,
  mapPool,
  readSnapshot,
  remoteIsFresher,
  SnapshotEntry,
  StorageAdapter,
  Tombstone,
  unionMerge,
} from "@vault-sync/core";

/** extensions we union-merge; everything else is last-writer-wins (§2.6 edge cases) */
const TEXT_EXTS = new Set([
  "md", "txt", "json", "csv", "canvas", "yml", "yaml", "html", "css", "js", "ts", "svg", "mermaid",
]);
// .obsidian now syncs (app + plugin settings distribute across devices); only repo infrastructure
// and the per-device paths below are held back. Folders matched by prefix.
const ALWAYS_EXCLUDED = [".sync/", ".git/", ".github/", ".sync-tool/", ".trash/"];
/** git-side-only metadata: must never be synced as vault content — a vault that lacks these
 * would otherwise tombstone them out of S3 (and thus out of the repo). Matched by basename. */
const GIT_META_FILES = new Set([".gitignore", ".gitattributes", ".gitmodules", ".s3syncignore"]);
/** Basenames inside this plugin's own install dir that are per-device and must never sync: its creds
 * and its on-disk log (+ rotation backup). Matched by full path against selfDir in isExcluded(). */
const SELF_DIR_EXCLUDED = new Set(["data.json", "sync.log", "sync.log.1"]);
/** Per-device files that must never sync anywhere: OS cruft, Obsidian's workspace UI state, and
 * this plugin's own gzipped cursor. Enforced here (not only via .gitignore) so they can't leak on
 * either leg. NOTE: this plugin's data.json (its creds) is per-device too but is excluded by full
 * path in isExcluded() — OTHER plugins' data.json DOES sync, so we can't match it by basename. */
function isPerDeviceFile(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  if (base === ".DS_Store" || base === "state.json.gz") return true;
  return path.startsWith(".obsidian/") && /^workspace.*\.json$/.test(base);
}
const LWW_SIZE_LIMIT = 5 * 1024 * 1024; // >5 MB: never union-merge (§2.6)
/** Offline-delete safety: absence on disk is NOT a reliable delete signal (a stale/copied/moved
 * state looks identical to a mass delete). Below the floor we trust it as genuine offline deletes;
 * above the fraction we treat it as a state mismatch and RESTORE from S3 instead of tombstoning. */
const MASS_MISSING_MIN = 10;
const MASS_MISSING_FRACTION = 0.5;
/** Per-cycle log detail cap: how many file paths we list PER DIRECTION before collapsing the rest to
 * "…and N more". A resync/first-sync moves thousands of files; without a cap one cycle would flood
 * the 512 KB rotating log and the S3 tail. The counts in the summary Notice are always exact. */
const LOG_LIST_CAP = 20;
/** How long a just-pulled file stays "unconfirmed" — long enough that an editor autosaving a stale
 * buffer over our write (which lands within seconds, a poll interval or two later) is still caught,
 * short enough that a much-later legitimate revert-to-the-old-bytes isn't mistaken for a clobber and
 * that the tracking map can't accumulate. See pendingPull / phantomRevert (§2.6). */
const PENDING_PULL_TTL_MS = 2 * 60 * 1000;
/** No progress ANYWHERE in a cycle for this long ⇒ the cycle is wedged, not merely slow. The adapter
 * bounds one request attempt at 60 s, so two minutes of complete silence means two dead attempts
 * back-to-back with nothing advancing across 8–50 concurrent slots. A healthy sync of mostly-small
 * notes ticks every few hundred ms, so a genuinely slow link never trips this — what it catches is a
 * cycle holding the single-flight lock while making no headway (a suspended device, or a response
 * whose body never flows), which used to block every later sync for hours (§4.4). */
const STALL_TIMEOUT_MS = 2 * 60 * 1000;
/** How often the watchdog compares the progress clock against STALL_TIMEOUT_MS. */
const STALL_CHECK_MS = 15 * 1000;
/** Entries a pull applies — or a push publishes — before committing progress and looking up (§4.3).
 * A catch-up of thousands of files used to be one indivisible unit of work: the cursor advanced only
 * at the very end, so an interruption anywhere threw the whole thing away and the next attempt
 * started from zero, and a queued "Sync now" waited behind all of it. Chunking makes progress
 * durable at each boundary and gives the cycle regular points at which it can hand the lock over.
 * Sized so an ordinary cycle (a handful of files) is entirely unaffected — only bulk catch-up splits. */
const CYCLE_CHUNK_FILES = 500;
/** Files stat/hashed per batch by the offline walk before it yields to the event loop. The walk runs
 * OFF the reconcile lock (§4.4), so yielding keeps the mobile UI smooth AND lets a concurrent poll/pull
 * cycle interleave — the whole point of decoupling the scan from the fast path. */
const SCAN_CHUNK = 250;

export interface FileState {
  hash: string;
  s3VersionId?: string;
  mtime: string;
}

/** A clean pull is applied optimistically: we write the remote bytes and advance the baseline before
 * knowing the write will stick. An editor can then autosave its stale buffer back over the file, and
 * the reverted copy — now differing from the freshly-advanced baseline — looks like a genuine local
 * edit, so conflict resolution preserves it and re-publishes the OLD content, reverting the change
 * for every device. To catch that we remember, per just-pulled path, both what we wrote (`hash`) and
 * what we replaced (`priorHash`, the true ancestor); a later reconcile that finds the file back at
 * `priorHash` treats it as a clobber, not an edit. */
interface PendingPull {
  /** hash of the content the pull wrote (what the file should still be) */
  hash: string;
  s3VersionId?: string;
  mtime: string;
  /** hash of the content the pull replaced — a revert to exactly this is a clobber, not an edit */
  priorHash: string | null;
  /** Date.now() when armed, for TTL expiry */
  at: number;
  /** Cycle that armed this entry. Within that same cycle the guard never expires, however long the
   * cycle takes: pull arms it and push reads it, and a large changeset over a slow link can easily
   * put more than PENDING_PULL_TTL_MS between the two. Letting wall-clock time disarm the guard
   * mid-cycle is what allowed a stale local copy to be re-published over a just-pulled file. The TTL
   * exists to bound the map ACROSS cycles (the real clobber lands a poll or two later), so it only
   * applies once a later cycle is reading. */
  cycle: number;
}

export interface SyncState {
  lastSyncedRev: number;
  files: Record<string, FileState>;
}

/** Raised when a cycle is disowned mid-flight by the stall watchdog. A distinct type so runLoop can
 * report a reclaimed stall rather than a sync failure, and so an orphan that resumes hours later
 * unwinds quietly at its next ownership check instead of finishing and writing. */
export class CycleAbandonedError extends Error {
  constructor(label: string) {
    super(`sync cycle (${label}) abandoned — no progress for ${STALL_TIMEOUT_MS / 1000}s`);
    this.name = "CycleAbandonedError";
  }
}

/** Wrap the adapter so every COMPLETED operation ticks the cycle's progress clock. Wrapping rather
 * than sprinkling ticks through the engine guarantees no I/O path is missed — the watchdog's whole
 * job is to tell "slow but advancing" from "wedged", and a heartbeat it never receives reads as
 * wedged, so a gap here would abandon healthy cycles. Ticking on COMPLETION (not on issue) is the
 * point: an operation that was issued and never came back is precisely the stall being caught. */
function withProgress(inner: StorageAdapter, tick: () => void): StorageAdapter {
  const t = async <R>(p: Promise<R>): Promise<R> => {
    const r = await p;
    tick();
    return r;
  };
  return {
    get: (k, o) => t(inner.get(k, o)),
    head: (k) => t(inner.head(k)),
    put: (k, b, o) => t(inner.put(k, b, o)),
    list: (p, s) => t(inner.list(p, s)),
    delete: (k) => t(inner.delete(k)),
    // Preserve the optional copy() as optional: callers probe `storage.copy &&` to decide between a
    // server-side rename and a re-upload, so synthesizing one here would change that decision.
    ...(inner.copy ? { copy: (s: string, d: string, v?: string) => t(inner.copy!(s, d, v)) } : {}),
  };
}

/** Outcome of a "force download" request (the linked-files command). Counts + the candidates that
 * had no live remote content, so the caller can give the user a precise summary. */
export interface ForceDownloadResult {
  requested: number;
  downloaded: number;
  /** already present locally and current — nothing to fetch */
  upToDate: number;
  /** candidates with no matching live object in S3 (never uploaded, or tombstoned) */
  notFound: string[];
}

export interface EngineOptions {
  deviceId: string;
  /** this plugin's own install dir (e.g. ".obsidian/plugins/vault-s3-sync") — its data.json holds
   * per-device creds and is never synced, while other plugins' data.json is. */
  selfDir: string;
  excludedFolders: string[];
  concurrency: number;
  /** per-device download cap in bytes: remote files larger than this are NOT downloaded to this
   * device (they stay in the cloud), keeping mobile vaults small. 0 = no limit. Uploads are never
   * capped — a file this device creates/edits always syncs up regardless of size. */
  maxDownloadBytes: number;
  /** Entries applied per pull chunk / published per push delta before progress is committed and the
   * cycle looks up (§4.3). Defaults to CYCLE_CHUNK_FILES; tunable like `concurrency`. */
  chunkFiles?: number;
  /** verbose: surface a Notice after every sync cycle that did something (§success feedback) */
  verbose: boolean;
  /** Persistent logger sink — the plugin routes this to disk + S3 (SyncLogger). Every Notice the
   * engine raises is also logged here, plus per-cycle summaries and conflict warnings, so mobile
   * (no DevTools) still has a trail. */
  log: (level: "info" | "warn" | "error", msg: string) => void;
  /** First-ever sync on this device: the local state has never been persisted, so files that
   * collide with remote are Obsidian's just-generated config defaults (or a copied scratch state),
   * NOT genuine edits. When true the first pull takes remote as-is on any collision instead of
   * union-merging — which would otherwise corrupt the canonical .obsidian settings and push the
   * corruption everywhere. Must be false for a copied (foreign) state and for user resyncs, where
   * local content is real and union-merge is the right, lossless choice. */
  firstRun?: boolean;
  /** This device ADOPTED a copied/restored state (the machine fingerprint changed, §4.2). The file
   * baselines are kept — they are content-addressed, so every entry whose recorded hash still
   * matches the file on disk is a valid merge base — but nothing has yet verified that the disk
   * agrees with them. Until the first offline scan completes, a tracked file that isn't on disk is
   * RESTORED from S3, never tombstoned: a partial restore would otherwise delete the missing notes
   * off every device. */
  adoptedForeignState?: boolean;
  /** Don't union-merge local↔remote collisions — collect them and let the caller decide (§4.2a).
   * Set for the first cycle after adopting a foreign state, where silently union-merging the whole
   * vault is the one outcome nobody would pick knowingly. Clean files still pull normally. */
  deferConflicts?: boolean;
  /** Rename a NOTE through Obsidian's own API (`fileManager.renameFile`) rather than the raw storage
   * adapter. Used to re-case a file to a pulled case-only rename: the adapter rejects a case-only
   * rename on Obsidian mobile AND bypasses the metadata cache (so the new name wouldn't show without
   * a reload), whereas Obsidian's rename performs it and refreshes the UI live. Returns false when the
   * path isn't a note in the vault index (e.g. a config file) so the engine falls back to the adapter.
   * Optional: absent in tests / where only adapter renames are available. */
  renameFile?: (from: string, to: string, viaTmp: string) => Promise<boolean>;
  /** Called with the path just before sync overwrites an EXISTING local file with remote bytes.
   * The plugin routes this to Obsidian's File recovery store so the pre-sync local content is always
   * recoverable in-app, even when this device never pushed it (§4.12). Best-effort by contract:
   * failures must not abort the write, so implementations swallow their own errors. */
  onBeforeOverwrite?: (path: string) => Promise<void>;
  onStateChanged: (state: SyncState) => Promise<void>;
}

type Deferred = { resolve: () => void; reject: (err: unknown) => void };

/** One serialized reconcile cycle, built from a trigger (poll / edit / manual / startup / resync)
 * and run under the engine lock. Concurrent requests coalesce into a single queued cycle via
 * mergeReq(), so triggers can never run over each other or corrupt the shared state (§2.3). */
interface CycleReq {
  /** resync: forget the cursor + drop all file state before pulling (a full superset reconcile) */
  resetCursor: boolean;
  /** re-scan every local file (offline catch-up, §2.4); implies walking the config dir too */
  scanOffline: boolean;
  /** re-scan just the config dir (cheap; catches in-session .obsidian edits + deletions) */
  scanConfig: boolean;
  /** ignore echo suppression on pull — restore even files THIS device once wrote */
  fullPull: boolean;
  /** short human label for notifications */
  label: string;
  /** emit started/done notices even when the cycle transferred nothing */
  announce: boolean;
  /** show those notices even without verbose mode (user-initiated actions: manual sync, resync) */
  force: boolean;
  /** paths/linkpaths to force-download from S3 ignoring the per-device size cap (§4.7.1).
   * Resolved against live remote state; empty on ordinary cycles. */
  forcePaths: string[];
  /** arm the bootstrap guard for this cycle: every local↔remote collision is taken from remote
   * as-is instead of union-merged. Set when the user answers "cloud wins" to the new-device prompt. */
  takeRemoteOnCollision?: boolean;
  /** finalize an off-lock offline walk (§4.4): `known` is the set of disk paths the walk saw, and
   * this cycle resolves which tracked files are genuinely missing (with a fresh disk re-verify, since
   * the walk ran without the lock). Set only by scanForOfflineChanges; it replaces the in-cycle
   * scanOffline pre-scan for the deferred/manual path. */
  resolveMissing?: { known: Set<string> };
}

export class SyncEngine {
  /** paths currently being written by sync itself — vault events for them are echoes (§2.3) */
  readonly applying = new Set<string>();
  private dirty = new Set<string>();
  /** Pending renames captured from Obsidian's rename event (oldPath → newPath), consumed by the next
   * push() so the OLD path's tombstone carries `renamedTo`. A receiver that still holds a
   * divergent `old` then folds its edit onto `new` instead of resurrecting it. Cleared once the
   * tombstone is emitted. */
  private renames = new Map<string, string>();
  /** canonical key → tracked state path, built per-pull so applyRemote can find a local file that is
   * the SAME node under a different case/NFC form and rename it to the winning name (§1.2a). */
  private nodeIndex: Map<string, string> | undefined;
  /** Files pulled this session but not yet confirmed to have held the written bytes. Guards against
   * an editor clobbering a fresh pull with a stale buffer, which would otherwise re-publish the old
   * content as a "local edit" (§2.6). Keyed by path; entries self-clear on confirm/divergence and
   * expire after PENDING_PULL_TTL_MS. In-memory only: a clobber lands seconds after the pull, within
   * the same session, so this needn't survive a restart. */
  private pendingPull = new Map<string, PendingPull>();
  /** First-ever-sync guard: while true, a pull takes remote as-is on any local collision instead of
   * union-merging (kills the fresh-device default-config corruption). Cleared after the first pull.
   * See EngineOptions.firstRun and applyRemote(). */
  private bootstrap: boolean;
  /** Adopted-foreign-state guard: while true the offline scan RESTORES tracked files it can't find
   * on disk instead of tombstoning them. Cleared once that first scan has run and the disk has been
   * confirmed against the adopted baselines. See EngineOptions.adoptedForeignState. */
  private adoptedState: boolean;
  /** While true, a local↔remote collision is neither merged nor overwritten: the path is collected
   * in `deferred` and left alone, for the caller to resolve. See EngineOptions.deferConflicts. */
  private deferConflicts: boolean;
  /** Paths whose collision this cycle declined to resolve (deferConflicts). Drained by the plugin,
   * which asks the user whether the cloud or a union merge wins. */
  private readonly deferred = new Set<string>();
  /** During a full-pull reconcile (resync), config-dir files (.obsidian/**) are taken from S3
   * AS-IS instead of freshest-wins — on a resync S3 is authoritative for config. This is also the
   * HEAL path for config a prior bad merge corrupted locally: the corrupted copy has a newer mtime
   * and would otherwise win freshest-wins and propagate the corruption everywhere; forcing
   * remote-wins for config on resync overwrites it with the correct S3 version. Notes still merge. */
  private takeConfigFromRemote = false;
  // Serialization: one cycle runs at a time. Concurrent requests (poll / edit save / manual /
  // resync) coalesce into a single queued slot instead of overlapping — which used to let a resync
  // wipe the state mid-cycle while its own sync no-op'd. `running` holds the lock; `queuedReq` is
  // the coalesced follow-up; `queuedWaiters` are the callers awaiting it.
  private running = false;
  private queuedReq: CycleReq | null = null;
  private queuedWaiters: Deferred[] = [];
  // Stall reclamation (§4.4). A cycle that makes no progress for STALL_TIMEOUT_MS is DISOWNED: the
  // lock is released so later triggers can sync again, and the stalled cycle — which may never settle
  // at all, since a hung promise cannot be cancelled from outside — is fenced off by these two
  // counters so it can never write if it does come back. `cycleSeq` fences the cycle (checked before
  // every commit); `loopToken` fences the runLoop that owns `running` and drains the queue. Both are
  // bumped on abandonment, so the orphan fails its next ownership check and unwinds.
  private cycleSeq = 0;
  private loopToken = 0;
  /** Date.now() of the last completed storage operation in the running cycle (see withProgress). */
  private progressAt = 0;
  private stallTimer: ReturnType<typeof setInterval> | undefined;
  /** Waiters of the currently-running cycle, so the watchdog can settle them when it disowns it —
   * otherwise an awaited sync() (a manual "Sync now") would hang on a promise nothing will resolve. */
  private activeWaiters: Deferred[] = [];
  /** Set when a cycle handed the lock back mid-catch-up (§4.3): runLoop keeps draining until the
   * journal is caught up rather than leaving the rest to whenever the next poll happens to fire. */
  private pendingResume: CycleReq | null = null;
  // per-cycle activity counters (for the verbose summary)
  private pulled = 0;
  private pushed = 0;
  private merged = 0;
  private skipped = 0; // remote files left in the cloud this cycle (over the download cap)
  // per-cycle WHICH-files detail, for the persistent log only (never the transient Notice). Reset at
  // the start of every cycle; emitted (capped) by logCycleDetail() at the end. `mergedPaths` doubles
  // as the guard that keeps a merged file — which is also re-pushed — from being listed twice.
  private detail = {
    pulled: [] as string[], // remote content written locally
    pushed: [] as string[], // local content uploaded to S3
    deletedLocal: [] as string[], // removed here because a remote tombstone said so
    deletedRemote: [] as string[], // deleted here → tombstoned in the cloud
    mergedPaths: [] as string[], // conflict-resolved (union-merge or freshest-wins)
  };
  private mergedSet = new Set<string>(); // paths already recorded as merged this cycle
  // Result of the most recent forced-download cycle, read back by forceDownloadPaths() after the
  // cycle it queued has run. Only forced cycles set it; ordinary cycles leave it untouched.
  private forceResult: ForceDownloadResult | null = null;

  /** show a Notice; gated by verbose unless force=true (errors/conflicts/user actions). Always
   * logged (a Notice is transient; the log persists). */
  private notify(msg: string, force = false): void {
    if (force || this.opts.verbose) new Notice(msg);
    this.opts.log("info", msg);
  }

  /** Record a conflict-resolved path once (union-merge or freshest-wins). Idempotent per cycle, and
   * the mergedSet lets push() list the file as "merged" rather than re-listing it as "pushed". */
  private recordMerged(path: string): void {
    if (this.mergedSet.has(path)) return;
    this.mergedSet.add(path);
    this.detail.mergedPaths.push(path);
  }

  /** Emit the per-cycle file lists to the persistent log (disk + S3), one greppable line per file,
   * capped at LOG_LIST_CAP per direction. Log-only — never a Notice; the arrow prefixes mirror the
   * summary Notice (↓ pulled / ↑ pushed / ⇅ merged) so both read alike. */
  private logCycleDetail(): void {
    this.logGroup("↓ pulled", this.detail.pulled);
    this.logGroup("↓ deleted", this.detail.deletedLocal);
    this.logGroup("↑ pushed", this.detail.pushed);
    this.logGroup("↑ deleted", this.detail.deletedRemote);
    this.logGroup("⇅ merged", this.detail.mergedPaths);
  }

  private logGroup(verb: string, paths: string[]): void {
    for (const p of paths.slice(0, LOG_LIST_CAP)) this.opts.log("info", `${verb} ${p}`);
    const more = paths.length - LOG_LIST_CAP;
    if (more > 0) this.opts.log("info", `${verb} …and ${more} more`);
  }

  /** Fetch a path's remote bytes — pinned to the version the entry names when `pin`, else whatever is
   * currently live. See applyRemote's `pin` for why the distinction matters. Falls back to live when
   * the entry carries no `s3VersionId` (entries written before the field existed). */
  private fetchRemote(
    path: string,
    remote: FileEntry & SnapshotEntry,
    pin: boolean,
  ): Promise<GetResult | null> {
    return this.storage.get(
      `files/${path}`,
      pin && remote.s3VersionId ? { versionId: remote.s3VersionId } : undefined,
    );
  }

  private get chunkFiles(): number {
    return this.opts.chunkFiles ?? CYCLE_CHUNK_FILES;
  }

  /** Per-device download gate: 0 = unlimited. Unknown size → allow (correctness over space). */
  private downloadAllowed(size: number | undefined): boolean {
    const limit = this.opts.maxDownloadBytes;
    return limit <= 0 || typeof size !== "number" || size <= limit;
  }

  constructor(
    private vault: Vault,
    private storage: StorageAdapter,
    private state: SyncState,
    private opts: EngineOptions,
  ) {
    this.bootstrap = opts.firstRun ?? false;
    this.adoptedState = opts.adoptedForeignState ?? false;
    this.deferConflicts = opts.deferConflicts ?? false;
    // Swap in the progress-ticking wrapper once, here, so EVERY `this.storage.*` in the engine feeds
    // the stall watchdog without each call site having to remember to.
    this.storage = withProgress(storage, () => {
      this.progressAt = Date.now();
    });
  }

  /** True while this cycle still owns the engine. False once the watchdog disowned it (or a later
   * cycle started), which happens only to a cycle that stalled — see cycleSeq. */
  private owns(seq: number): boolean {
    return this.cycleSeq === seq;
  }

  /** Cooperative cancellation point. Called wherever a cycle is about to do something it must not do
   * after being disowned — above all, anything that writes. A stalled cycle whose awaits do finally
   * settle unwinds from here instead of committing work computed against a long-dead baseline. */
  private assertOwner(seq: number, label: string): void {
    if (!this.owns(seq)) throw new CycleAbandonedError(label);
  }

  /** Arm the watchdog for the cycle identified by `seq`. Fires on the wall clock, so a device frozen
   * mid-cycle is caught the moment it thaws (no progress for hours), as is a live-but-hung request. */
  private startStallWatchdog(seq: number, label: string): void {
    this.stopStallWatchdog();
    // Clear THIS interval by handle rather than via stopStallWatchdog(): if a stale tick ever ran
    // after another cycle armed its own watchdog, clearing the shared field would disarm that one.
    const timer = setInterval(() => {
      if (!this.owns(seq)) return void clearInterval(timer);
      if (Date.now() - this.progressAt < STALL_TIMEOUT_MS) return;
      this.abandonCycle(seq, label);
    }, STALL_CHECK_MS);
    this.stallTimer = timer;
  }

  private stopStallWatchdog(): void {
    if (this.stallTimer !== undefined) clearInterval(this.stallTimer);
    this.stallTimer = undefined;
  }

  /** Reclaim the engine from a stalled cycle. The cycle itself cannot be cancelled — a promise hung
   * inside fetch never settles — so instead it is FENCED: both counters advance, which (a) frees the
   * lock for new cycles and (b) guarantees the orphan fails assertOwner before any write, should it
   * ever resume. Without (b) this would be strictly worse than the stall: two writers inside one
   * device, the second one publishing an ancient baseline. */
  private abandonCycle(seq: number, label: string): void {
    this.stopStallWatchdog();
    this.cycleSeq++;
    this.loopToken++;
    this.running = false;
    const waiters = this.activeWaiters;
    this.activeWaiters = [];
    const err = new CycleAbandonedError(label);
    this.opts.log(
      "warn",
      `Sync: ${label} made no progress for ${STALL_TIMEOUT_MS / 1000}s — abandoned, lock released`,
    );
    for (const w of waiters) w.reject(err);
    // Whatever was queued behind the stall still deserves to run, and nothing owns the lock now.
    const queued = this.queuedReq;
    if (queued) {
      this.queuedReq = null;
      const qw = this.queuedWaiters;
      this.queuedWaiters = [];
      this.running = true;
      // loopToken was already bumped above, so this value is unique to the replacement loop and the
      // orphan's `this.loopToken === token` check has already gone false.
      void this.runLoop(this.loopToken, queued, qw);
    }
  }

  // --------------------------------------------- deferred conflicts (§4.2a)
  /** Paths this cycle declined to merge, for the "new device" prompt. Read-only view. */
  deferredConflicts(): string[] {
    return [...this.deferred];
  }

  /** Resolve every deferred collision by taking the cloud copy as-is (the right answer after a
   * machine rebuild/restore, where S3 — not this disk — is the current truth). Runs a full pull
   * with the bootstrap guard armed, so each collision is taken from remote instead of merged. */
  async resolveDeferredFromCloud(): Promise<void> {
    this.deferConflicts = false;
    this.deferred.clear();
    // Cold re-pull: the deferred paths' deltas are already behind the cursor, so rewind it to see
    // them again. Unlike `resetCursor` this KEEPS state.files — those baselines are the whole point
    // (§4.2) and files that already match remote short-circuit on their hash anyway.
    this.state.lastSyncedRev = 0;
    await this.request({
      resetCursor: false,
      scanOffline: false,
      scanConfig: false,
      fullPull: true, // ignore echo suppression: files THIS device once wrote must restore too
      takeRemoteOnCollision: true,
      label: "cloud wins",
      announce: true,
      force: true,
      forcePaths: [],
    });
  }

  /** Resolve every deferred collision by union-merging it (lossless, keeps both sides — the pre-4.2a
   * behavior). Also the fallback when the prompt is dismissed without a choice. */
  async resolveDeferredByMerging(): Promise<void> {
    this.deferConflicts = false;
    this.deferred.clear();
    this.state.lastSyncedRev = 0; // cold re-pull, keeping the baselines (see above)
    await this.request({
      resetCursor: false,
      scanOffline: false,
      scanConfig: false,
      fullPull: true,
      label: "merge with cloud",
      announce: true,
      force: true,
      forcePaths: [],
    });
  }

  // ------------------------------------------------------------- exclusions
  isExcluded(path: string): boolean {
    const base = path.split("/").pop() ?? "";
    if (GIT_META_FILES.has(base) || isPerDeviceFile(path)) return true;
    // Per-device files inside our own install dir: creds (data.json) and the on-disk log + its
    // rotation backup. The plugin dir otherwise syncs (self-deploy channel), so these must be held
    // back by full path or they'd propagate as ordinary vault content.
    if (SELF_DIR_EXCLUDED.has(base) && path === `${this.opts.selfDir}/${base}`) return true;
    const folders = [...ALWAYS_EXCLUDED, ...this.opts.excludedFolders.map((f) => f.replace(/\/?$/, "/"))];
    return folders.some((f) => path.startsWith(f));
  }

  // ------------------------------------------------------------- dirty tracking
  markDirty(path: string): void {
    if (!this.isExcluded(path) && !this.applying.has(path)) this.dirty.add(path);
  }

  /** Record a rename (oldPath → newPath) from Obsidian's rename event so the next push() tags the old
   * path's tombstone with `renamedTo`. Ignored when either side is excluded — an excluded
   * old path never tombstones, and an excluded target isn't a sync destination. Echo-safe: a rename
   * sync itself performs is suppressed by the applying-set on the paths it writes. */
  recordRename(oldPath: string, newPath: string): void {
    if (this.isExcluded(oldPath) || this.isExcluded(newPath)) return;
    // Echo-safe: a rename sync itself performs (display-case propagation) puts both paths in the
    // applying-set; ignore its rename event so it isn't re-pushed as a user rename.
    if (this.applying.has(oldPath) || this.applying.has(newPath)) return;
    this.renames.set(oldPath, newPath);
  }

  /** Mark one existing file dirty if it's new or its content changed (mtime pre-filter, hash
   * decides — a touch with identical bytes is not a change). Shared by the offline scan and the
   * per-poll config rescan. */
  private async markIfChanged(path: string, mtimeMs: number): Promise<void> {
    const st = this.state.files[path];
    if (!st) {
      this.dirty.add(path); // new (or re-enabled folder → scoped first-run, §2.2)
      return;
    }
    if (new Date(mtimeMs).toISOString() !== st.mtime) {
      const content = await this.vault.adapter.readBinary(path);
      if (contentHash(new Uint8Array(content)) !== st.hash) this.dirty.add(path);
    }
  }

  /** Recursively list files under the vault's config dir (e.g. ".obsidian"). Vault.getFiles()
   * and the vault change events both omit the config dir and other dotfolders, so the ONLY way to
   * see ".obsidian" content is to walk it through the raw adapter. Returns vault-relative paths, or
   * null if the config dir itself couldn't be read — callers must NOT infer deletions from null (an
   * unreadable dir is not an empty one, and treating it as empty would tombstone all config files). */
  private async listConfigFiles(): Promise<string[] | null> {
    let rootListing: { files: string[]; folders: string[] };
    try {
      rootListing = await this.vault.adapter.list(this.vault.configDir);
    } catch {
      return null; // config dir absent/unreadable — signal "unknown", not "empty"
    }
    const out: string[] = [];
    const walk = async (listing: { files: string[]; folders: string[] }): Promise<void> => {
      out.push(...listing.files);
      for (const sub of listing.folders) {
        try {
          await walk(await this.vault.adapter.list(sub));
        } catch {
          /* skip an unreadable subdir — a partial listing is still useful */
        }
      }
    };
    await walk(rootListing);
    return out;
  }

  /** True for paths inside the vault's config dir (e.g. ".obsidian/…"). */
  private isConfigPath(path: string): boolean {
    return path.startsWith(this.vault.configDir + "/");
  }

  /** Re-scan just the config dir and mark changes dirty. Config files emit no vault events, so this
   * runs each poll to catch in-session settings changes (installing a plugin, tweaking appearance)
   * AND deletions — mid-session, absence IS a reliable delete signal (unlike startup, where a stale
   * or copied state could masquerade as deletions). Skips entirely if the config dir is unreadable,
   * so a transient list failure can't mass-tombstone. push() re-stats before tombstoning anyway.
   * Runs inside the cycle lock (never standalone), so it can't race a concurrent pull/push. */
  private async scanConfigDir(): Promise<void> {
    const configFiles = await this.listConfigFiles();
    if (!configFiles) return; // unreadable → don't infer changes or deletions this cycle
    const present = new Set<string>();
    for (const path of configFiles) {
      if (this.isExcluded(path)) continue;
      present.add(path);
      const stat = await this.vault.adapter.stat(path);
      if (stat) await this.markIfChanged(path, stat.mtime);
    }
    // Any config file we're tracking that's no longer on disk was deleted → mark dirty so push()
    // tombstones it (push re-stats, so a file that's actually present won't be wrongly deleted).
    for (const p of Object.keys(this.state.files)) {
      if (this.isConfigPath(p) && !present.has(p) && !this.isExcluded(p)) this.dirty.add(p);
    }
  }

  /** Yield a turn to the event loop so a long walk can't monopolize the JS thread (mobile UI) or the
   * reconcile lock. A macrotask (not a microtask) so pending timers/promises actually get to run. */
  private yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** The expensive half of the offline scan (§2.4): walk the vault + config dir, marking changed files
   * dirty (mtime pre-filter, hash decides). Yields every SCAN_CHUNK files. Callable OFF the reconcile
   * lock — it only reads `state.files` and appends to `dirty` (the same off-lock path vault events
   * already use), and marking dirty is self-correcting because push() re-stats before tombstoning.
   * Returns the set of disk paths seen (canonicalised to the tracked name where a case/NFC variant was
   * re-cased), which resolveMissing uses to decide what's genuinely gone. */
  private async scanOfflineWalk(): Promise<Set<string>> {
    const known = new Set<string>();
    // Tracked notes by canonical identity — so a disk file that matches a tracked note only by
    // case/NFC is reconciled as THAT node instead of (a) pushing it as a new duplicate and (b)
    // leaving the tracked name to look "missing" below and be tombstoned. That false tombstone is
    // exactly how a stale/mismatched device wiped a case-renamed note off every peer (§1.2a).
    const trackedByNode = new Map<string, string>();
    for (const k of Object.keys(this.state.files)) trackedByNode.set(canonicalKey(k), k);
    let n = 0;
    for (const file of this.vault.getFiles()) {
      if (this.isExcluded(file.path)) continue;
      let p = file.path;
      const tracked = trackedByNode.get(canonicalKey(p));
      if (tracked && tracked !== p) {
        // Same node under a different case/NFC on disk → re-case to the tracked name so on-disk and
        // state agree. Pure rename (never a delete); no-ops on failure. Its own state mutation is
        // guarded by the applying-set and no-ops when `from` is already gone, so it's safe off-lock.
        await this.renameLocalToCanonical(p, tracked);
        p = tracked;
      }
      known.add(p);
      await this.markIfChanged(p, file.stat.mtime);
      if (++n % SCAN_CHUNK === 0) await this.yieldToEventLoop();
    }
    // getFiles() skips the config dir — walk it explicitly so ".obsidian" content is both detected
    // as dirty AND counted as "known" (otherwise every tracked config file would look deleted below).
    const configFiles = await this.listConfigFiles();
    if (configFiles) {
      for (const path of configFiles) {
        if (this.isExcluded(path)) continue;
        known.add(path);
        const stat = await this.vault.adapter.stat(path);
        if (stat) await this.markIfChanged(path, stat.mtime);
        if (++n % SCAN_CHUNK === 0) await this.yieldToEventLoop();
      }
    } else {
      // Config dir unreadable: we can't confirm any config file is gone, so keep tracked config
      // paths out of the "missing" set below — don't tombstone what we simply couldn't see.
      for (const p of Object.keys(this.state.files)) if (this.isConfigPath(p)) known.add(p);
    }
    return known;
  }

  /** The lock-sensitive half of the offline scan: from the disk paths the walk saw (`known`), decide
   * which tracked files are genuinely gone, then apply the adopted-state and mass-missing guards. Runs
   * inside the cycle lock (via runCycle). `reverify` re-checks each candidate against the live disk
   * first — set it for the deferred/manual path whose walk ran OFF the lock, so a file a concurrent
   * pull wrote during the walk isn't tombstoned as a phantom delete. The in-lock scanOffline path
   * (resync) runs its walk under the lock with no interleaving, so it skips the re-verify. */
  private async resolveMissing(known: Set<string>, reverify: boolean): Promise<void> {
    // A tracked path is "missing" only if NO disk file matches it even canonically — a case/NFC
    // variant present on disk keeps it alive (backstop for anything the re-case above didn't cover,
    // e.g. config files). Prevents the offline scan from tombstoning a note that is really still here.
    const knownCanonical = new Set([...known].map(canonicalKey));
    let missing = Object.keys(this.state.files).filter(
      (p) => !known.has(p) && !knownCanonical.has(canonicalKey(p)) && !this.isExcluded(p),
    );
    if (reverify && missing.length) {
      // The walk ran off the lock; re-check each candidate against the live disk (cheap — only the
      // candidates) so a file a concurrent pull materialised mid-walk isn't mistaken for a deletion.
      const verified: string[] = [];
      for (const p of missing) if (!(await this.vault.adapter.exists(p))) verified.push(p);
      missing = verified;
    }
    const total = Object.keys(this.state.files).length;
    if (this.adoptedState && missing.length) {
      // The baselines came from a copied/restored vault (§4.2) and this is the first scan that has
      // ever checked them against this disk. A tracked path we can't see is far more likely to be a
      // gap in the restore than a deletion the user made — and guessing wrong deletes it everywhere.
      // Restore from S3 instead; a genuine deletion can be redone here and will propagate normally.
      this.notify(
        `Sync: ${missing.length} tracked file(s) aren't in this copy of the vault — restoring them ` +
          `from S3 rather than deleting. Delete them again here if they should be gone.`,
        true,
      );
      this.state.lastSyncedRev = 0;
      this.adoptedState = false; // disk is reconciled with the adopted state from here on
      return;
    }
    this.adoptedState = false;
    if (
      missing.length >= MASS_MISSING_MIN &&
      missing.length / Math.max(1, total) > MASS_MISSING_FRACTION
    ) {
      // Too many files vanished at once — almost certainly a stale/copied/moved state, not real
      // deletions. Restoring is safe; mass-tombstoning would wipe the vault everywhere. Force a
      // cold re-pull, which re-downloads the missing files instead of deleting them (§offline-safety).
      this.notify(
        `Sync: ${missing.length} of ${total} tracked files are missing locally — treating this as a ` +
          `state mismatch and restoring from S3, not deleting. Use "Resync everything" if this is wrong.`,
        true,
      );
      this.state.lastSyncedRev = 0;
    } else {
      for (const p of missing) this.dirty.add(p); // small offline deletes propagate as tombstones
    }
  }

  /** In-lock offline scan (§2.4), used by resync: walk then resolve missing, both under the cycle
   * lock, so there's no interleaving to re-verify against. The deferred/manual path splits these — the
   * walk runs off the lock (scanForOfflineChanges) and only the resolve runs in a cycle. */
  private async scanOffline(): Promise<void> {
    const known = await this.scanOfflineWalk();
    await this.resolveMissing(known, false);
  }

  /** Deferred / manual offline scan (§4.4). The expensive walk runs OFF the reconcile lock, so fresh
   * remote pulls and quick-edit pushes are never starved behind it (the original startup-latency
   * complaint); when the walk finishes, a short locked cycle resolves genuinely-missing files. Armed
   * ~30 s after launch on desktop and on demand via the "Scan for external changes" command — the only
   * trigger on mobile, where vault files are practically never edited outside the app so a routine
   * scan is pure cost. */
  async scanForOfflineChanges(): Promise<void> {
    const known = await this.scanOfflineWalk(); // off-lock: does not block pull/push cycles
    await this.request({
      resetCursor: false,
      scanOffline: false,
      scanConfig: false,
      fullPull: false,
      label: "offline scan",
      announce: false,
      force: false,
      forcePaths: [],
      resolveMissing: { known },
    });
  }

  /** User-triggered full reconcile: forget the cursor, re-pull the entire S3 state, re-scan all
   * local files. Overlaps union-merge (nothing lost). The escape hatch for stale/foreign state.
   * Serialized like every other cycle — hitting "Resync" mid-sync now queues behind the running
   * cycle instead of resetting the state out from under it and then no-op'ing on the lock. */
  async resyncEverything(): Promise<void> {
    await this.request({
      resetCursor: true,
      scanOffline: true,
      scanConfig: false,
      fullPull: true, // ignore echo suppression so THIS device's own files restore too
      label: "resync",
      announce: true,
      force: true, // a resync is a deliberate user action — always surface start/done
      forcePaths: [],
    });
  }

  /** Force-download specific files from S3, bypassing the per-device size cap. Powers the "sync
   * linked files of this note" command so a mobile user can pull a note's oversized attachments on
   * demand without lowering the global cap. `candidates` are vault paths or Obsidian linkpaths (a
   * bare filename, a partial path, or a note name without ".md"); each is resolved against the live
   * remote state. Serialized like every other cycle. */
  async forceDownloadPaths(candidates: string[]): Promise<ForceDownloadResult> {
    this.forceResult = null;
    await this.request({
      resetCursor: false,
      scanOffline: false,
      scanConfig: false,
      fullPull: false,
      label: "force download",
      announce: true,
      force: true, // user-initiated — always surface the outcome
      forcePaths: candidates,
    });
    return this.forceResult ?? { requested: candidates.length, downloaded: 0, upToDate: 0, notFound: [] };
  }

  // ------------------------------------------------------------- sync cycle
  /** Request one reconcile cycle. Serialized: if a cycle is already running the request coalesces
   * into a single queued follow-up (so polls/edits can't pile up) and resolves when that cycle
   * completes. `fullPull` ignores echo suppression; `scanConfig`/`scanOffline` pick the pre-scan;
   * `announce`/`label` drive the queued/started/done notices, and `force` lifts them past the
   * verbose gate — set it for user-initiated cycles ("Sync now"), which must always report. */
  async sync(
    opts: {
      fullPull?: boolean;
      scanConfig?: boolean;
      scanOffline?: boolean;
      label?: string;
      announce?: boolean;
      force?: boolean;
    } = {},
  ): Promise<void> {
    await this.request({
      resetCursor: false,
      scanOffline: opts.scanOffline ?? false,
      scanConfig: opts.scanConfig ?? false,
      fullPull: opts.fullPull ?? false,
      label: opts.label ?? "sync",
      announce: opts.announce ?? false,
      force: opts.force ?? false,
      forcePaths: [],
    });
  }

  /** Enqueue a cycle behind the running one (coalescing), or start the loop if the engine is idle.
   * Returns a promise that settles when a cycle covering this request finishes. */
  private request(req: CycleReq): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: Deferred = { resolve, reject };
      if (this.running) {
        const firstToQueue = this.queuedReq === null;
        this.queuedReq = this.mergeReq(this.queuedReq, req);
        this.queuedWaiters.push(waiter);
        // Announce the wait once per queued batch (or whenever a resync joins) — coalesced polls
        // during one long cycle don't each fire a notice.
        if (firstToQueue || req.resetCursor) {
          this.notify(`Sync: queued (${req.label}) — a cycle is already running`, req.force);
        }
      } else {
        this.running = true;
        void this.runLoop(++this.loopToken, req, [waiter]);
      }
    });
  }

  /** Fold a new request into the queued one: resync wins, flags OR together, the cycle announces
   * (it waited, so it's worth reporting) and inherits any force from a user-initiated request. */
  private mergeReq(base: CycleReq | null, add: CycleReq): CycleReq {
    const resetCursor = (base?.resetCursor ?? false) || add.resetCursor;
    return {
      resetCursor,
      scanOffline: (base?.scanOffline ?? false) || add.scanOffline || resetCursor,
      scanConfig: (base?.scanConfig ?? false) || add.scanConfig,
      fullPull: (base?.fullPull ?? false) || add.fullPull || resetCursor,
      label: add.resetCursor && !base?.resetCursor ? add.label : base?.label ?? add.label,
      announce: true,
      force: (base?.force ?? false) || add.force,
      forcePaths: [...(base?.forcePaths ?? []), ...add.forcePaths],
      takeRemoteOnCollision: (base?.takeRemoteOnCollision ?? false) || (add.takeRemoteOnCollision ?? false),
      // Union the known-sets if two offline-scan finalizes ever coalesce (in practice only one is ever
      // in flight); a larger `known` only ever keeps MORE files alive, never tombstones extra.
      resolveMissing:
        base?.resolveMissing || add.resolveMissing
          ? {
              known: new Set([
                ...(base?.resolveMissing?.known ?? []),
                ...(add.resolveMissing?.known ?? []),
              ]),
            }
          : undefined,
    };
  }

  /** A cycle that continues an interrupted catch-up. Deliberately minimal — the disk was already
   * scanned by the cycle that began the catch-up, and there is no cursor to reset (resuming from the
   * committed one is the entire point). `fullPull` IS carried over: it disables echo suppression, so
   * dropping it mid-resync would silently stop restoring the files this device itself once wrote. */
  private resumeReqFrom(req: CycleReq): CycleReq {
    return {
      resetCursor: false,
      scanOffline: false,
      scanConfig: false,
      fullPull: req.fullPull,
      label: "catch-up",
      announce: false,
      force: false,
      forcePaths: [],
    };
  }

  /** Drain cycles one at a time until the queue empties, then release the lock. Each cycle settles
   * its own waiters (resolve on success, reject on failure) without stalling the ones behind it. */
  private async runLoop(token: number, firstReq: CycleReq, firstWaiters: Deferred[]): Promise<void> {
    let req: CycleReq | null = firstReq;
    let waiters = firstWaiters;
    try {
      while (req) {
        this.activeWaiters = waiters;
        try {
          await this.runCycle(req);
          for (const w of waiters) w.resolve();
        } catch (err) {
          for (const w of waiters) w.reject(err);
        }
        this.activeWaiters = [];
        // Disowned while that cycle ran (stall watchdog): a newer loop owns `running` and the queue
        // now. Returning WITHOUT touching either is the whole point — draining the queue here would
        // run a second cycle concurrently with the loop that replaced us. Waiters were already
        // rejected by abandonCycle; settling them again above is a no-op on a settled promise.
        if (this.loopToken !== token) return;
        req = this.queuedReq;
        waiters = this.queuedWaiters;
        this.queuedReq = null;
        this.queuedWaiters = [];
        // Nothing queued but a catch-up was handed back mid-flight — carry on with it rather than
        // idling until the next poll. Synthesized, so it has no waiters of its own: the caller whose
        // request triggered the yield has already been served by the cycle that just ran.
        if (!req && this.pendingResume) {
          req = this.pendingResume;
          waiters = [];
        }
      }
    } finally {
      if (this.loopToken === token) this.running = false;
    }
  }

  /** One reconcile pass: optional pre-scan, then pull remote changes (merge conflicts) and push the
   * dirty set. Only ever invoked by runLoop (single-flight), so it owns the shared state alone. */
  private async runCycle(req: CycleReq): Promise<void> {
    const seq = ++this.cycleSeq;
    this.progressAt = Date.now();
    this.startStallWatchdog(seq, req.label);
    try {
      await this.reconcile(req, seq);
    } finally {
      // Only if we still own the engine: an abandoned cycle unwinding here would otherwise clear the
      // watchdog armed by the cycle that replaced it, leaving that one unguarded.
      if (this.owns(seq)) this.stopStallWatchdog();
    }
  }

  private async reconcile(req: CycleReq, seq: number): Promise<void> {
    this.pulled = this.pushed = this.merged = this.skipped = 0;
    // Cleared up front so a cycle that throws (abandoned, network) can't leave a stale resume armed;
    // it is re-set below only if THIS cycle actually yields mid-catch-up.
    this.pendingResume = null;
    this.detail = { pulled: [], pushed: [], deletedLocal: [], deletedRemote: [], mergedPaths: [] };
    this.mergedSet.clear();
    const rev0 = this.state.lastSyncedRev;
    if (req.announce) this.notify(`Sync: started (${req.label})`, req.force);

    // On a full-pull reconcile (resync) S3 is authoritative for config: take .obsidian/** from
    // remote as-is rather than freshest-wins, so a locally-corrupted config with a newer mtime can't
    // win and re-propagate. Ordinary cycles leave freshest-wins in charge.
    this.takeConfigFromRemote = req.fullPull;
    // "Cloud wins" answer to the new-device prompt: reuse the first-run guard so every collision is
    // taken from remote as-is. Cleared with the rest of the bootstrap flag after this cycle's pull.
    if (req.takeRemoteOnCollision) this.bootstrap = true;

    if (req.resetCursor) {
      this.state.lastSyncedRev = 0;
      this.state.files = {};
      this.dirty.clear();
    }
    if (req.resolveMissing) await this.resolveMissing(req.resolveMissing.known, true);
    else if (req.scanOffline) await this.scanOffline();
    else if (req.scanConfig) await this.scanConfigDir();

    this.prunePendingPulls();
    // A pull that stopped at a chunk boundary to let a queued request through leaves catch-up work
    // behind; the cycle records that so it can requeue a follow-up once the queue has drained.
    const partialPull = await this.pull(req.fullPull);
    this.bootstrap = false; // first pull is done — later collisions are real edits again
    // Deferral is a one-cycle guard too: whatever this pull collected is handed to the prompt now,
    // and ordinary cycles (polls, edits) must resolve their conflicts normally rather than pile up
    // deferred paths nobody will ever be asked about.
    this.deferConflicts = false;
    // Force-download runs before push so any files it fetches are recorded (never re-uploaded as
    // dirty) and so a delete-vs-edit re-push it triggers is flushed in the same cycle.
    if (req.forcePaths.length) this.forceResult = await this.forceDownload(req.forcePaths);
    // Revalidate the write baseline (§2.3). The pull above established what remote looked like when
    // it ran; everything push() decides — is this file changed? what is its merge base? which rev do
    // we claim? — is measured against that. A cycle that took a while (large changeset, slow link,
    // a device suspended mid-pull) can reach here with a baseline many revisions stale, and push()
    // does not merge: it uploads local bytes and claims the next rev, silently reverting whatever
    // landed in between. One more incremental pull re-reads the journal and folds in anything new
    // through the normal conflict resolution, so the push is always measured against current remote
    // no matter how long the cycle took. Gated on having something to push: an idle poll (the common
    // case) skips the extra LIST entirely.
    // A pull that yielded mid-catch-up does NOT push. Its cursor sits at a chunk boundary with known
    // revisions still unapplied, so pushing would claim a rev the journal already has and CAS-walk
    // through everything it just chose to defer. The dirty set is left untouched (push drains it, so
    // not calling push is what preserves it) and the resumed cycle publishes it against a complete
    // baseline moments later.
    if (!partialPull) {
      if (this.dirty.size > 0) {
        this.assertOwner(seq, req.label);
        await this.pull();
      }
      this.assertOwner(seq, req.label);
      await this.push(seq, req.label);
    }
    // Unfinished catch-up must not wait for the next poll — resuming it is this cycle's business.
    this.pendingResume = partialPull ? this.resumeReqFrom(req) : null;

    const activity = this.pulled + this.pushed + this.merged;
    // Persist when state changed — and always after a resync, so the reset sticks even if S3 was
    // empty (activity 0, rev unchanged at 0). No-op polls (the common case) still skip the write.
    if (req.resetCursor || activity > 0 || this.state.lastSyncedRev !== rev0) {
      await this.opts.onStateChanged(this.state);
    }
    if (req.announce || activity > 0 || this.skipped > 0) {
      this.notify(
        `Sync: ${req.announce ? `done (${req.label}) ` : ""}↓${this.pulled} ↑${this.pushed}` +
          (this.merged ? ` (${this.merged} merged)` : "") +
          (this.skipped ? ` · ${this.skipped} kept in cloud (over size limit)` : ""),
        req.force,
      );
    }
    // The summary Notice above is a transient count; the persistent log gets the actual file list.
    this.logCycleDetail();
  }

  /** Returns true when it stopped early with entries still to apply (see applyChunked). */
  private async pull(fullPull = false): Promise<boolean> {
    let deltas: Delta[];
    let changed: Map<string, SnapshotEntry>;
    let targetRev: number;

    // fullPull (resync): don't echo-suppress — the goal is to restore the ENTIRE live state,
    // including files this device once wrote but has since lost locally.
    const excludeBy = fullPull ? undefined : this.opts.deviceId;
    deltas = await listDeltasSince(this.storage, this.state.lastSyncedRev, this.opts.concurrency);
    if (hasGap(this.state.lastSyncedRev, deltas) || (await this.behindSnapshot(deltas))) {
      // cold path (§1.4): journal pruned past us — diff against the snapshot
      const snap = await readSnapshot(this.storage);
      if (!snap) return false;
      changed = new Map(
        Object.entries(snap.snapshot.files).filter(
          ([, e]) => e.rev > this.state.lastSyncedRev && (fullPull || e.by !== this.opts.deviceId),
        ),
      );
      targetRev = Math.max(snap.snapshot.revision, deltas.at(-1)?.rev ?? 0);
      for (const [path, entry] of changedEntries(deltas, snap.snapshot.revision, excludeBy)) {
        changed.set(path, entry);
      }
    } else {
      if (deltas.length === 0) return false;
      changed = changedEntries(deltas, this.state.lastSyncedRev, excludeBy);
      targetRev = deltas.at(-1)!.rev;
    }

    const applicable = [...changed.entries()].filter(
      ([path]) => !this.isExcluded(path) && this.isSafePath(path),
    );
    // Index tracked paths by canonical identity so applyRemote can spot a node that already exists
    // locally under a DIFFERENT case/NFC form and rename the on-disk file to the winning name
    // (display-case propagation, §1.2a). Built once per pull, read-only during the concurrent apply.
    this.nodeIndex = new Map();
    for (const k of Object.keys(this.state.files)) this.nodeIndex.set(canonicalKey(k), k);
    try {
      return await this.applyChunked(applicable, targetRev);
    } finally {
      this.nodeIndex = undefined;
    }
  }

  /**
   * Apply `applicable` in **revision order**, committing the cursor at each chunk boundary.
   *
   * Chunks are cut on a revision boundary, never mid-revision, because `lastSyncedRev` is a single
   * integer: it may only advance to a rev whose entries are ALL applied. Cutting on the boundary
   * makes each committed cursor exactly as trustworthy as the old commit-once-at-the-end, while a
   * catch-up that dies (killed app, watchdog, closed laptop) keeps everything up to the last
   * boundary instead of starting over.
   *
   * This works for the cold path too: entries folded out of a snapshot carry their authoring `rev`,
   * and the cold path selects on `e.rev > lastSyncedRev`, so committing a partial cursor correctly
   * narrows what the next pass reconsiders.
   *
   * Returns true if it stopped early with work left — the cycle then requeues a follow-up.
   */
  private async applyChunked(
    applicable: [string, SnapshotEntry][],
    targetRev: number,
  ): Promise<boolean> {
    // Group by authoring rev so a chunk can never split one revision across two commits.
    const byRev = new Map<number, [string, SnapshotEntry][]>();
    for (const item of applicable) {
      const rev = item[1].rev ?? targetRev;
      const bucket = byRev.get(rev);
      if (bucket) bucket.push(item);
      else byRev.set(rev, [item]);
    }
    const revs = [...byRev.keys()].sort((a, b) => a - b);

    let i = 0;
    while (i < revs.length) {
      const chunk: [string, SnapshotEntry][] = [];
      let lastRev = revs[i];
      // Take whole revisions until the chunk is full. At least one revision always goes in, so a
      // single oversized revision still makes progress rather than deadlocking.
      while (i < revs.length && (chunk.length === 0 || chunk.length + byRev.get(revs[i])!.length <= this.chunkFiles)) {
        chunk.push(...byRev.get(revs[i])!);
        lastRev = revs[i];
        i++;
      }

      // Live entries BEFORE tombstones so a rename's destination (`new`) is materialized before its
      // old-side tombstone folds a divergent local `old` onto it (§2.8). A rename emits both sides in
      // ONE delta, so both always land in the same chunk and the ordering survives chunking intact.
      const lives = chunk.filter(([, e]) => !isTombstone(e));
      const tombstones = chunk.filter(([, e]) => isTombstone(e));
      await mapPool(lives, this.opts.concurrency, ([path, entry]) => this.applyRemote(path, entry));
      await mapPool(tombstones, this.opts.concurrency, ([path, entry]) => this.applyRemote(path, entry));

      const done = i >= revs.length;
      // On the last chunk take `targetRev` — it can exceed the highest rev that carried an applicable
      // entry (revisions this device authored, or ones filtered out as excluded/unsafe), and stopping
      // short of it would re-list those forever.
      this.state.lastSyncedRev = done ? targetRev : lastRev;
      if (done) return false;

      // Commit what this chunk achieved before starting the next one: that write is the whole point
      // of chunking — it is what an interrupted catch-up resumes from.
      await this.opts.onStateChanged(this.state);
      // Somebody is waiting (a manual sync, an edit save). Hand the lock over at this clean boundary
      // rather than making them wait out the entire catch-up; the follow-up cycle resumes from the
      // cursor just committed.
      if (this.queuedReq !== null) {
        this.opts.log(
          "info",
          `catch-up paused at rev ${lastRev} (${revs.length - i} revisions still to apply) — yielding to queued work`,
        );
        return true;
      }
    }
    return false;
  }

  private async behindSnapshot(deltas: Delta[]): Promise<boolean> {
    if (deltas.length > 0) return false;
    // empty list can hide "everything newer was pruned" — one HEAD settles it (§1.4)
    const head = await this.storage.head("snapshot.json.gz");
    const rev = Number(head?.metadata?.["revision"] ?? 0);
    return rev > this.state.lastSyncedRev;
  }

  /** `pin`: fetch the exact bytes the entry names (`?versionId=`) rather than whatever is currently
   * live at the key. Ordinary pulls leave this off — latest IS the entry they just read from the
   * journal, and pinning would fail on legacy entries that predate `s3VersionId`. push()'s lost-CAS
   * path MUST set it: by then this device has already uploaded its own bytes to that key (files are
   * PUT before the delta, §2.3), so "latest" is our own stale content and merging against it would
   * compare local with local and quietly conclude there was no conflict. */
  private async applyRemote(path: string, entry: SnapshotEntry, pin = false): Promise<void> {
    const st = this.state.files[path];

    if (isTombstone(entry)) {
      const renamedTo = (entry as Tombstone).renamedTo;
      const localBuf = await this.readLocal(path);
      if (localBuf) {
        const divergent = st ? contentHash(localBuf) !== st.hash : false;
        if (divergent && renamedTo && this.isSafePath(renamedTo) && !this.isExcluded(renamedTo)) {
          // This delete is a rename's OLD side and we hold a divergent copy. Fold our edit onto `new`
          // (which the live-first pull pass has already materialized) instead of resurrecting `old`,
          // then remove `old` below. Losslessly carries a concurrent edit across the rename — the case
          // the freshest-wins delete-vs-edit tiebreak can't preserve.
          await this.foldRenamedEdit(path, renamedTo, localBuf, st!);
        } else if (divergent && (await this.editWinsOverDelete(path, entry))) {
          this.dirty.add(path); // delete-vs-edit: our FRESHER edit wins (§1.5) → re-push
          return;
        }
        await this.withApplying(path, () => this.vault.adapter.remove(path));
        this.pulled++;
        this.detail.deletedLocal.push(path);
      }
      delete this.state.files[path];
      this.dirty.delete(path);
      return;
    }

    const remote = entry as FileEntry & SnapshotEntry;
    // Display-case / NFC propagation (§1.2a): if this canonical node already exists locally under a
    // DIFFERENT exact name — a case- or NFC-only rename another device made — rename the on-disk file
    // to the winning name so the new name shows here too. A pure rename (never a delete), so it can't
    // lose the shared inode; on any failure we skip and fall through to normal content handling.
    const variant = this.nodeIndex?.get(canonicalKey(path));
    if (variant && variant !== path) await this.renameLocalToCanonical(variant, path);
    const localBuf = await this.readLocal(path);
    const localHash = localBuf ? contentHash(localBuf) : null;
    if (localHash === remote.hash) {
      this.record(path, remote); // already identical — just record
      return;
    }

    // First-ever sync (bootstrap): a local file that collides with remote is NOT a genuine edit —
    // it's Obsidian's just-generated config default (or a copied scratch state). Union-merging it
    // into the canonical file would corrupt it and push the corruption everywhere, so treat every
    // collision as clean and take remote as-is. Local-only files (absent from remote) never reach
    // here, so genuine new content the user added before first sync still uploads normally.
    const localDirty =
      !this.bootstrap &&
      !(this.takeConfigFromRemote && this.isConfigPath(path)) &&
      localBuf !== null &&
      (!st || localHash !== st.hash) &&
      // A file that has reverted to exactly the bytes a recent pull replaced is a clobber (an editor
      // autosaving a stale buffer over our write), NOT a genuine edit — so it isn't "dirty" and must
      // not be merged/re-published. Falling through to the clean branch re-applies the remote and
      // re-arms the guard (§2.6, fix #1).
      !this.phantomRevert(path, localHash);
    // New-device prompt (§4.2a): this cycle is not allowed to guess. Record the collision and leave
    // BOTH copies exactly as they are — no write, no state change, not dirty (pushing would clobber
    // the cloud). The plugin drains `deferred`, asks, and re-runs a cycle that resolves them all one
    // way. If the prompt is dismissed the fallback re-run union-merges, i.e. the old behavior.
    if (localDirty && this.deferConflicts) {
      this.deferred.add(path);
      this.dirty.delete(path);
      return;
    }
    if (!localDirty) {
      // Per-device download cap: oversized remote files stay in the cloud on this device to save
      // space. Leave local as-is and DON'T record — the file just isn't present here, so it's not
      // "missing" (no tombstone) and a later resync with a higher cap will fetch it. Uploads are
      // never capped, so a big file this device authors still syncs up. A locally-dirty file is
      // exempt (below): we must resolve it, and it's already taking space anyway.
      if (!this.downloadAllowed(remote.size)) {
        // In bootstrap the colliding local file is a default we don't want to keep OR push up, but
        // it's over the cap so we won't download either — drop it from the dirty set so push()
        // can't upload the default (it's untracked, so push wouldn't otherwise skip it).
        if (this.bootstrap) this.dirty.delete(path);
        this.skipped++;
        return;
      }
      // clean local (or absent) → take remote as-is
      const obj = await this.fetchRemote(path, remote, pin);
      if (!obj) return;
      await this.write(path, obj.body, remote.mtime);
      // Arm the phantom-revert guard: the write can be silently clobbered before the next reconcile,
      // and the advanced baseline (recorded just below) would then make the stale copy look like an
      // edit. Remember what we wrote and what we replaced so that revert is recognized. Skip during
      // bootstrap / full-pull resync — those move thousands of files and aren't the clobber case, and
      // arming them all would bloat the map. Preserve the original priorHash when re-arming a file
      // we're already healing, so a repeated clobber keeps pointing at the true ancestor.
      if (!this.bootstrap && !this.takeConfigFromRemote && localBuf !== null) {
        const prior = this.pendingPull.get(path);
        this.pendingPull.set(path, {
          hash: remote.hash,
          s3VersionId: obj.versionId ?? remote.s3VersionId,
          mtime: remote.mtime,
          priorHash: prior?.priorHash ?? st?.hash ?? localHash,
          at: Date.now(),
          cycle: this.cycleSeq,
        });
      }
      this.record(path, { ...remote, s3VersionId: obj.versionId ?? remote.s3VersionId });
      this.pulled++;
      this.detail.pulled.push(path);
      return;
    }

    // CONFLICT: changed locally AND remotely.
    // Config files (.obsidian/**) and binary/oversized content don't line-merge meaningfully —
    // a line merge duplicates JSON lines and corrupts binaries — so resolve those by FRESHEST-WINS
    // (the newer mtime takes the whole file). Freshest-wins also CONVERGES, unlike the old
    // keep-local rule, which ping-pongs a fresh delta every poll while two devices hold divergent
    // copies. Text notes within the size cap still three-way union-merge (lossless).
    if (this.usesFreshestWins(path, localBuf!.byteLength)) {
      // Base-aware fast-forward before any mtime race: a remote whose content equals the base we
      // last synced (st.hash) is a no-op re-push, NOT a competing edit — keep our genuine local edit
      // and re-push it, so an older-content re-upload with a newer mtime can't revert it. (The mirror
      // — local unchanged from base — already resolved above as !localDirty → take remote.) Text
      // notes never reach here; their union merge collapses base==theirs to ours on its own.
      if (st && remote.hash === st.hash) {
        this.dirty.add(path); // keep local, re-push it
        this.merged++;
        this.recordMerged(path);
        return;
      }
      await this.resolveFreshestWins(path, remote, pin);
      return;
    }
    const baseObj = st?.s3VersionId
      ? await this.storage.get(`files/${path}`, { versionId: st.s3VersionId })
      : null;
    const remoteObj = await this.fetchRemote(path, remote, pin);
    if (!remoteObj) {
      this.dirty.add(path);
      return;
    }
    const merged = unionMerge(
      baseObj ? decodeText(baseObj.body) : "",
      decodeText(localBuf!),
      decodeText(remoteObj.body),
    );
    await this.write(path, encodeText(merged.text), new Date().toISOString());
    // Do NOT record() the merged hash here: that would make push()'s mtime-only-touch guard
    // (st.hash === hash) treat the merge as a no-op and DROP the upload, stranding the resolved
    // conflict on this device forever. Leave the file dirty with its prior state so push() sees the
    // change, uploads it, and records the true state (with the real s3VersionId from the PUT).
    this.dirty.add(path); // merged result must go back to S3
    this.merged++;
    this.recordMerged(path); // listed in the cycle's log summary; push() won't re-list it as pushed
    if (merged.hadConflicts) {
      // A real conflict is worth surfacing on its own (distinct severity + a Notice), beyond the
      // per-cycle merged list — so keep this immediate warning too.
      this.opts.log("warn", `union-merged conflict in ${path}`);
      new Notice(`Sync: union-merged conflict in ${path}`);
    }
  }

  /** Delete-vs-edit tiebreak (§1.5): a remote tombstone has collided with a locally-divergent copy
   * (localHash !== st.hash). Keep — and re-publish — the local edit ONLY when it is at least as fresh
   * as the deletion. A local copy STRICTLY OLDER than the tombstone is a stale divergence, most often
   * a file another device renamed away (a rename is delete(old)+add(new)) while this device still held
   * a pre-rename edit; re-publishing it resurrects the old path and duplicates the note. Comparing the
   * local file's mtime against the tombstone's delta time (`at`) lets the delete win in that case while
   * still preserving a genuine edit made AFTER the delete. A tombstone from an older journal carries no
   * `at` (nothing to compare) → fall back to the historical keep-local behavior, which never loses an
   * edit. Convergent (no bytes synthesized), and mirrored on the git-sync leg (reconcile.ts). */
  private async editWinsOverDelete(path: string, tombstone: SnapshotEntry): Promise<boolean> {
    const at = tombstone.at;
    if (!at) return true; // pre-`at` tombstone → preserve the local edit (legacy behavior)
    const stat = await this.vault.adapter.stat(path);
    const localMtime = stat ? new Date(stat.mtime).toISOString() : "";
    // delete wins only if strictly newer than the local edit; a tie keeps the local edit.
    return !remoteIsFresher(at, localMtime);
  }

  /** Fold a divergent local `old` (being deleted as the SOURCE of a rename) onto `new`,
   * instead of resurrecting `old`. Three-way union-merge for text (base = the last-synced `old`
   * content via its s3VersionId, ours = the local edit, theirs = the current `new`), freshest-wins for
   * binary/config/oversized. Writes the result to `new` and marks it dirty so the merged bytes
   * re-publish and every device converges; the caller then removes `old`. Losslessly carries a
   * concurrent edit across a rename — the case editWinsOverDelete's freshest-wins tiebreak cannot
   * preserve. */
  private async foldRenamedEdit(
    oldPath: string,
    newPath: string,
    localOld: Uint8Array,
    stOld: FileState,
  ): Promise<void> {
    // Current `new` content: the live-first pull pass has already written it, so prefer the live
    // remote copy, then local, then `old` itself (a pure rename where `new` never diverged).
    const remoteNew = await this.storage.get(`files/${newPath}`);
    const localNew = await this.readLocal(newPath);
    const theirs = remoteNew?.body ?? localNew ?? localOld;
    if (contentHash(localOld) === contentHash(theirs)) return; // our edit already equals `new` → just drop `old`

    if (this.isTextPath(newPath) && !this.isConfigPath(newPath) &&
        localOld.byteLength <= LWW_SIZE_LIMIT && theirs.byteLength <= LWW_SIZE_LIMIT) {
      const baseObj = stOld.s3VersionId
        ? await this.storage.get(`files/${oldPath}`, { versionId: stOld.s3VersionId })
        : null;
      const merged = unionMerge(
        baseObj ? decodeText(baseObj.body) : "",
        decodeText(localOld),
        decodeText(theirs),
      );
      await this.write(newPath, encodeText(merged.text), new Date().toISOString());
      if (merged.hadConflicts) {
        this.opts.log("warn", `rename-folded conflict ${oldPath} → ${newPath}`);
        new Notice(`Sync: union-merged rename ${oldPath} → ${newPath}`);
      }
    } else {
      // binary/config/oversized — no line merge; keep whichever side is fresher.
      const so = await this.vault.adapter.stat(oldPath);
      const sn = await this.vault.adapter.stat(newPath);
      const oldMtime = so ? new Date(so.mtime).toISOString() : "";
      const newMtime = sn ? new Date(sn.mtime).toISOString() : "";
      if (remoteIsFresher(newMtime, oldMtime)) return; // `new` is newer → keep it, just drop `old`
      await this.write(newPath, localOld, new Date().toISOString()); // `old` edit is newer → move it onto `new`
    }
    this.dirty.add(newPath); // re-publish the folded result so all devices converge
    this.merged++;
    this.recordMerged(newPath);
  }

  /** Which conflict strategy a path uses: config-dir files and binary/oversized content resolve by
   * freshest-wins (see resolveFreshestWins); everything else three-way union-merges. */
  private usesFreshestWins(path: string, localSize: number): boolean {
    return this.isConfigPath(path) || !this.isTextPath(path) || localSize > LWW_SIZE_LIMIT;
  }

  /** Resolve a conflict by taking whichever side has the newer mtime — no bytes are synthesized, so
   * both sync legs stay convergent even if clock skew makes them pick different sides on one pass.
   * Remote newer → download and record it; local newer (or a tie) → keep local and re-push. */
  private async resolveFreshestWins(
    path: string,
    remote: FileEntry & SnapshotEntry,
    pin = false,
  ): Promise<void> {
    const stat = await this.vault.adapter.stat(path);
    const localMtime = stat ? new Date(stat.mtime).toISOString() : "";
    // Chronological (parsed) compare, not lexicographic — the two legs emit mtimes in different ISO
    // shapes/timezones and string order diverges from real time order (remoteIsFresher, §2.6).
    if (remoteIsFresher(remote.mtime, localMtime)) {
      const obj = await this.fetchRemote(path, remote, pin);
      if (!obj) {
        this.dirty.add(path); // remote vanished mid-resolve — keep local, re-push
        return;
      }
      await this.write(path, obj.body, remote.mtime);
      this.record(path, { ...remote, s3VersionId: obj.versionId ?? remote.s3VersionId });
      this.pulled++;
      this.merged++;
      this.recordMerged(path);
    } else {
      this.dirty.add(path); // local is newer (or tie) → keep it and push it up
      this.merged++;
      this.recordMerged(path);
    }
  }

  /** Fetch the given candidates from S3 ignoring the size cap (§4.7.1). Resolves each
   * linkpath against the full live remote state (snapshot ⊕ newer deltas) so files not present
   * locally — the whole point on a capped device — still resolve. Writes clean/absent targets and
   * records them; never clobbers a locally-dirty file (that's for normal reconcile to resolve). */
  private async forceDownload(candidates: string[]): Promise<ForceDownloadResult> {
    const result: ForceDownloadResult = {
      requested: candidates.length,
      downloaded: 0,
      upToDate: 0,
      notFound: [],
    };
    const { state } = await loadRemoteState(this.storage, this.opts.concurrency);
    // Resolve to distinct live remote paths; a candidate that matches nothing is reported not-found.
    const paths = new Set<string>();
    for (const c of candidates) {
      const resolved = this.resolveRemotePath(c, state.files);
      if (resolved) paths.add(resolved);
      else result.notFound.push(c);
    }
    await mapPool([...paths], this.opts.concurrency, async (path) => {
      if (this.isExcluded(path) || !this.isSafePath(path)) return;
      const remote = state.files[path] as FileEntry & SnapshotEntry;
      const localBuf = await this.readLocal(path);
      const localHash = localBuf ? contentHash(localBuf) : null;
      if (localHash === remote.hash) {
        this.record(path, remote); // already have the bytes — just make sure it's tracked
        result.upToDate++;
        return;
      }
      const st = this.state.files[path];
      const localDirty = localBuf !== null && (!st || localHash !== st.hash);
      if (localDirty) {
        result.upToDate++; // a local edit exists; don't overwrite it — leave it for reconcile
        return;
      }
      const obj = await this.storage.get(`files/${path}`);
      if (!obj) {
        result.notFound.push(path);
        return;
      }
      await this.write(path, obj.body, remote.mtime);
      this.record(path, { ...remote, s3VersionId: obj.versionId ?? remote.s3VersionId });
      this.pulled++;
      this.detail.pulled.push(path);
      result.downloaded++;
    });
    return result;
  }

  /** Map an Obsidian linkpath (or a full vault path) to a live remote path. Tries: exact match,
   * exact + ".md" (wikilink to a note), then a basename/suffix match across live entries, shortest
   * path winning (Obsidian's own tiebreak for ambiguous shortlinks). Tombstoned paths never match. */
  private resolveRemotePath(candidate: string, files: Record<string, SnapshotEntry>): string | null {
    const c = candidate.replace(/^\.?\//, "").trim();
    if (!c) return null;
    const live = (p: string): boolean => p in files && !isTombstone(files[p]);
    if (live(c)) return c;
    if (live(c + ".md")) return c + ".md";
    const hasSlash = c.includes("/");
    const matches = Object.keys(files).filter((p) => {
      if (!live(p)) return false;
      if (hasSlash) return p === c || p.endsWith("/" + c);
      const base = p.split("/").pop();
      return base === c || base === c + ".md";
    });
    if (matches.length === 0) return null;
    return matches.sort((a, b) => a.length - b.length)[0];
  }

  private async push(seq: number, label: string): Promise<void> {
    // Snapshot the dirty set and DRAIN it now. Vault events call markDirty() synchronously, so an
    // edit saved DURING this (possibly multi-second) cycle then re-populates this.dirty and is
    // pushed next cycle — the old blanket this.dirty.clear() at the end silently wiped such edits.
    const snapshot = [...this.dirty];
    const paths = snapshot.filter((p) => !this.isExcluded(p));
    for (const p of snapshot) this.dirty.delete(p);
    if (paths.length === 0) return;

    // Reverse rename map (destination → source), captured BEFORE any batch drains this.renames.
    // A rename whose content is unchanged is pushed with a server-side S3 copy from the OLD object
    // instead of re-uploading the bytes (rename-without-edit optimization).
    const renameSrc = new Map<string, string>();
    for (const [oldP, newP] of this.renames) renameSrc.set(newP, oldP);

    // Publish in batches, each its own delta. A bulk push (first sync, a big offline catch-up) used
    // to be one enormous delta that either landed whole or was retried whole; batching commits state
    // as it goes, so an interruption keeps everything already published instead of redoing it. An
    // ordinary cycle is far below the cap and still produces exactly one delta, as before.
    for (let start = 0; start < paths.length; start += this.chunkFiles) {
      const batch = paths.slice(start, start + this.chunkFiles);
      // Anything not yet published stays this cycle's responsibility to requeue on failure.
      await this.pushBatch(batch, paths.slice(start), renameSrc, seq, label);
    }
  }

  private async pushBatch(
    batch: string[],
    remaining: string[],
    renameSrc: Map<string, string>,
    seq: number,
    label: string,
  ): Promise<void> {
    try {
      const files: Record<string, DeltaEntry> = {};
      const newStates = new Map<string, FileState | null>();
      const paths = batch;

      const buildEntry = async (path: string): Promise<void> => {
        // A path Obsidian's `rename` event told us was renamed away (this.renames) is tombstoned with
        // `renamedTo`, WITHOUT consulting stat(). This is the whole case-only-rename story: on a
        // case-INSENSITIVE filesystem (macOS/Windows/iOS/Android) stat(oldPath) of a rename that only
        // changed letter case resolves to the NEW file, so a stat-based check sees `old` as alive and
        // re-pushes it as a live duplicate. Trusting the rename event is authoritative and needs no
        // directory-listing heuristics (the old, data-losing `goneByCase` guard, removed). The
        // destination pushes as its own live entry below; core (collapseNodes) folds the old→new pair
        // to one node per canonical identity, so no peer ever sees two keys for one note (§1.2a).
        const renamedAway = this.renames.get(path);
        this.renames.delete(path);
        if (renamedAway && renamedAway !== path) {
          if (this.state.files[path]) {
            files[path] = { deleted: true, renamedTo: renamedAway };
            newStates.set(path, null);
            this.detail.deletedRemote.push(path);
          }
          return;
        }

        // Read through the adapter, NOT the vault index — getAbstractFileByPath() omits the config
        // dir, so index-based lookups would treat every ".obsidian" file as absent and skip it.
        const stat = await this.vault.adapter.stat(path);
        if (!stat || stat.type !== "file") {
          if (this.state.files[path]) {
            files[path] = { deleted: true }; // deleted locally → tombstone
            newStates.set(path, null);
            this.detail.deletedRemote.push(path);
          }
          return;
        }
        const buf = new Uint8Array(await this.vault.adapter.readBinary(path));
        const hash = contentHash(buf);
        const st = this.state.files[path];
        const mtime = new Date(stat.mtime).toISOString();
        // Phantom-revert guard on the push leg: a file that reverted to exactly the bytes a recent
        // pull replaced is an editor clobbering our write, not an edit. Restore the pulled content
        // rather than publishing the stale bytes (which would revert the change for every device).
        const clobber = this.phantomRevert(path, hash);
        if (clobber) {
          // Restore from current remote (never the stale local bytes). With no concurrent change it
          // equals what the pull wrote; if remote advanced, taking the newest is still correct.
          const obj = await this.storage.get(`files/${path}`);
          if (obj) {
            await this.write(path, obj.body, clobber.mtime);
            // Realign the baseline to the restored bytes so a stale st.hash can't re-flag it as dirty.
            this.record(path, {
              hash: contentHash(obj.body),
              s3VersionId: obj.versionId,
              size: obj.body.byteLength,
              mtime: clobber.mtime,
            });
            this.pendingPull.delete(path);
            this.pulled++; // healed back to the pulled content (took remote), not a push
            this.detail.pulled.push(path);
            this.opts.log(
              "warn",
              `healed phantom revert in ${path} — write clobbered after pull, not republishing stale content`,
            );
          }
          return; // never push the reverted bytes
        }
        if (st && st.hash === hash) return; // mtime-only touch → drop (§1.6)
        // Rename-without-edit: if this path is a rename destination whose content matches the OLD
        // object's recorded bytes, copy it server-side (no bytes leave the device) instead of
        // re-uploading. Falls back to a normal upload if the source isn't a synced object, the content
        // changed (rename+edit), or the adapter has no copy().
        const src = renameSrc.get(path);
        const srcState = src ? this.state.files[src] : undefined;
        let versionId: string | undefined;
        if (this.storage.copy && src && srcState && srcState.hash === hash && srcState.s3VersionId) {
          versionId = (await this.storage.copy(`files/${src}`, `files/${path}`, srcState.s3VersionId)).versionId;
        } else {
          versionId = (await this.storage.put(`files/${path}`, buf)).versionId;
        }
        const entry: FileEntry = { hash, s3VersionId: versionId, size: buf.byteLength, mtime };
        files[path] = entry;
        newStates.set(path, { hash, s3VersionId: versionId, mtime });
        // A conflict-resolved file is re-pushed here too — it's already in the merged list, so don't
        // list it a second time as a plain push.
        if (!this.mergedSet.has(path) && !this.detail.pushed.includes(path)) {
          this.detail.pushed.push(path);
        }
      };

      await mapPool(paths, this.opts.concurrency, buildEntry);

      if (Object.keys(files).length === 0) return;
      this.assertOwner(seq, label);

      const result = await appendDelta(
        this.storage,
        this.state.lastSyncedRev + 1,
        (rev): Delta => ({ rev, by: this.opts.deviceId, at: new Date().toISOString(), files }),
        async (winner) => {
          // Lost the CAS race (§1.3): someone else claimed this rev. Their delta has to be folded in
          // before retrying, or the delta we go on to publish is measured against a baseline that is
          // already stale — which is exactly how a slow cycle silently reverts other devices.
          if (winner.by === this.opts.deviceId) return; // our own write echoing back
          for (const [path, entry] of Object.entries(winner.files)) {
            this.assertOwner(seq, label);
            const remote: SnapshotEntry = { ...entry, rev: winner.rev, by: winner.by, at: winner.at };
            if (!(path in files)) {
              await this.applyRemote(path, remote);
              continue;
            }
            // COLLISION: the winner touched a path this push is carrying. Skipping it — the old
            // behavior — is a last-writer-wins hole punched straight through the union merge: our
            // bytes go up unmodified and the winner's edit is gone, with no conflict recorded
            // anywhere. Resolve it the way a pull would instead, PINNED to the winner's own bytes
            // (ours are already live at that key, since files are PUT before the delta), then rebuild
            // our payload entry from whatever the resolution left on disk.
            delete files[path];
            newStates.delete(path);
            const listed = this.detail.pushed.indexOf(path);
            if (listed >= 0) this.detail.pushed.splice(listed, 1);
            this.dirty.delete(path);
            await this.applyRemote(path, remote, true);
            // applyRemote re-dirties a path whose local side survived resolution (a union merge, a
            // freshest-wins local win, an edit that beat a delete) and leaves it clean when remote won
            // outright. Only the former still has anything of ours left to publish.
            if (this.dirty.delete(path)) await buildEntry(path);
          }
        },
      );

      for (const [path, st] of newStates) {
        if (st === null) delete this.state.files[path];
        else this.state.files[path] = st;
      }
      this.state.lastSyncedRev = result.rev;
      this.pushed += Object.keys(files).length;
    } catch (err) {
      // Push failed — requeue everything not yet published (this batch and any batch after it) so the
      // next cycle retries them (§2.6). Batches already committed above are NOT requeued: their state
      // is recorded, so re-listing them would only make the next cycle re-hash files it knows are
      // current. Edits that arrived mid-cycle are already back in this.dirty; re-adding is a harmless
      // Set no-op.
      for (const p of remaining) this.dirty.add(p);
      throw err;
    }
  }

  // ------------------------------------------------------------- helpers
  /** Read a local file's bytes via the raw adapter, or null if it isn't a file. Works uniformly
   * for regular notes AND config-dir files (the vault index excludes the latter). */
  private async readLocal(path: string): Promise<Uint8Array | null> {
    try {
      const stat = await this.vault.adapter.stat(path);
      if (!stat || stat.type !== "file") return null;
      return new Uint8Array(await this.vault.adapter.readBinary(path));
    } catch {
      return null;
    }
  }

  private isTextPath(path: string): boolean {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return TEXT_EXTS.has(ext);
  }

  private isSafePath(path: string): boolean {
    return !path.startsWith("/") && !path.split("/").includes("..");
  }

  private record(path: string, entry: FileEntry & { s3VersionId?: string }): void {
    this.state.files[path] = { hash: entry.hash, s3VersionId: entry.s3VersionId, mtime: entry.mtime };
    this.dirty.delete(path);
  }

  /** Rename the local on-disk file `from` → `to` when they're the same node under a different
   * case/NFC form, so a case-only rename made on another device shows here too (§1.2a). Pure rename:
   * on a case-insensitive FS it just re-cases the name (same inode); on a case-sensitive FS it moves
   * the file. Echo-suppressed (both paths in `applying`) so the resulting vault rename event isn't
   * re-pushed. On any failure it no-ops — the note is untouched, only its displayed name lags. */
  private async renameLocalToCanonical(from: string, to: string): Promise<void> {
    const st = await this.vault.adapter.stat(from);
    if (!st || st.type !== "file") return; // nothing on disk under the old name
    // A case/NFC-only rename is a "target already exists" fold-collision on a case-INSENSITIVE
    // filesystem (Obsidian mobile rejects it — both via fileManager and the raw adapter). Hop through
    // a unique interim name so neither step collides. `tmp` is a real .md path in the same folder,
    // added to the applying-set so its own vault events are treated as echoes, not user edits.
    const slash = to.lastIndexOf("/");
    const tmp = (slash >= 0 ? to.slice(0, slash + 1) : "") + `recasing-${Date.now()}.md`;
    this.applying.add(from);
    this.applying.add(to);
    this.applying.add(tmp);
    const release = () => {
      this.applying.delete(from);
      this.applying.delete(to);
      this.applying.delete(tmp);
    };
    const warn = (stage: string, e: unknown): void =>
      this.opts.log("warn", `re-case ${stage} failed ${from} → ${to}: ${(e as Error)?.message ?? String(e)}`);

    let via = "";
    // 1. Obsidian's own rename (updates the UI/cache + links). main.ts temp-hops internally on a
    //    fold-collision, so this is the working path on mobile too. Returns false only for a path not
    //    in the vault index (config); throws surface the real error instead of being swallowed.
    if (this.opts.renameFile) {
      try {
        if (await this.opts.renameFile(from, to, tmp)) via = "obsidian";
      } catch (e) {
        warn("via Obsidian API", e);
      }
    }
    // 2. Fallback: temp-hop on the raw adapter (config files / desktop / no callback).
    if (!via) {
      try {
        await this.vault.adapter.rename(from, tmp);
        await this.vault.adapter.rename(tmp, to);
        via = "adapter";
      } catch (e) {
        warn("via adapter temp-hop", e);
      }
    }
    if (!via) {
      release();
      return; // give up — data-safe: the note is untouched, only its shown name lags
    }
    const prior = this.state.files[from];
    if (prior) {
      this.state.files[to] = prior; // migrate the tracked entry to the winning name
      delete this.state.files[from];
    }
    this.detail.pulled.push(to);
    this.opts.log("info", `re-cased ${from} → ${to} (${via})`);
    // vault events fire async — release on the next tick, matching write()'s echo window
    setTimeout(release, 500);
  }

  /** Classify a would-be local edit against the pending-pull guard (§2.6). A file we just pulled can
   * be silently reverted by an editor autosaving a stale buffer over our write; that revert then
   * masquerades as a local edit and gets re-published, reverting the change everywhere. Returns the
   * pending record ONLY when `localHash` is exactly the content the pull replaced (a clobber the
   * caller must heal instead of publish); returns null otherwise and self-clears the tracking when
   * the file has settled at the pulled content (confirmed) or diverged to a genuine third state. */
  private phantomRevert(path: string, localHash: string | null): PendingPull | null {
    if (localHash === null) return null;
    const p = this.pendingPull.get(path);
    if (!p) return null;
    // Within the cycle that armed it the guard never expires (see PendingPull.cycle): pull arms it and
    // push reads it, and a big changeset over a slow link puts far more than the TTL between the two —
    // expiring there would disarm the guard exactly when the cycle is most likely to re-publish stale
    // bytes. The TTL is for LATER cycles, where a revert really has become indistinguishable from an
    // edit.
    if (p.cycle !== this.cycleSeq && Date.now() - p.at > PENDING_PULL_TTL_MS) {
      this.pendingPull.delete(path); // stale — a real edit by now, not a clobber
      return null;
    }
    if (localHash === p.hash) {
      this.pendingPull.delete(path); // write held → pull confirmed
      return null;
    }
    if (p.priorHash !== null && localHash === p.priorHash) return p; // reverted to replaced bytes → clobber
    this.pendingPull.delete(path); // diverged to a third state → genuine edit on top of the pull
    return null;
  }

  /** Drop pending-pull entries past their TTL so the map can't accumulate across cycles. Runs at the
   * START of a cycle, so `p.cycle` is always an earlier one and the TTL applies unconditionally — the
   * in-cycle exemption in phantomRevert is about reads made later in the SAME cycle. */
  private prunePendingPulls(): void {
    if (this.pendingPull.size === 0) return;
    const cutoff = Date.now() - PENDING_PULL_TTL_MS;
    for (const [path, p] of this.pendingPull) if (p.at < cutoff) this.pendingPull.delete(path);
  }

  /** write with mtime aligned to the manifest (§2.5) and echo suppression */
  private async write(path: string, data: Uint8Array, mtimeIso: string): Promise<void> {
    await this.withApplying(path, async () => {
      const dir = path.split("/").slice(0, -1).join("/");
      if (dir && !(await this.vault.adapter.exists(dir))) await this.vault.adapter.mkdir(dir);
      // Snapshot the bytes we're about to replace into Obsidian's File recovery store (§4.12). Only
      // for an existing file — a first download replaces nothing. Never let it block the write.
      if (this.opts.onBeforeOverwrite && (await this.vault.adapter.exists(path))) {
        try {
          await this.opts.onBeforeOverwrite(path);
        } catch {
          /* best-effort safety net; a failed snapshot must not stop the sync */
        }
      }
      await this.vault.adapter.writeBinary(
        path,
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
        { mtime: Date.parse(mtimeIso) },
      );
    });
  }

  private async withApplying(path: string, fn: () => Promise<void>): Promise<void> {
    this.applying.add(path);
    try {
      await fn();
    } finally {
      // vault events fire async — release on the next tick
      setTimeout(() => this.applying.delete(path), 500);
    }
  }
}
