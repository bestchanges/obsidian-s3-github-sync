import { Notice, TFile, Vault } from "obsidian";
import {
  appendDelta,
  changedEntries,
  contentHash,
  decodeText,
  Delta,
  DeltaEntry,
  encodeText,
  FileEntry,
  hasGap,
  isTombstone,
  listDeltasSince,
  mapPool,
  readSnapshot,
  SnapshotEntry,
  StorageAdapter,
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

export interface FileState {
  hash: string;
  s3VersionId?: string;
  mtime: string;
}

export interface SyncState {
  lastSyncedRev: number;
  files: Record<string, FileState>;
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
  /** verbose: surface a Notice after every sync cycle that did something (§success feedback) */
  verbose: boolean;
  onStateChanged: (state: SyncState) => Promise<void>;
}

export class SyncEngine {
  /** paths currently being written by sync itself — vault events for them are echoes (§2.3) */
  readonly applying = new Set<string>();
  private dirty = new Set<string>();
  private running = false;
  // per-cycle activity counters (for the verbose summary)
  private pulled = 0;
  private pushed = 0;
  private merged = 0;
  private skipped = 0; // remote files left in the cloud this cycle (over the download cap)

  /** show a Notice; gated by verbose unless force=true (errors/conflicts/user actions) */
  private notify(msg: string, force = false): void {
    if (force || this.opts.verbose) new Notice(msg);
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
  ) {}

  // ------------------------------------------------------------- exclusions
  isExcluded(path: string): boolean {
    const base = path.split("/").pop() ?? "";
    if (GIT_META_FILES.has(base) || isPerDeviceFile(path)) return true;
    if (path === `${this.opts.selfDir}/data.json`) return true; // our creds — per-device
    const folders = [...ALWAYS_EXCLUDED, ...this.opts.excludedFolders.map((f) => f.replace(/\/?$/, "/"))];
    return folders.some((f) => path.startsWith(f));
  }

  // ------------------------------------------------------------- dirty tracking
  markDirty(path: string): void {
    if (!this.isExcluded(path) && !this.applying.has(path)) this.dirty.add(path);
  }

  /** Detect files edited while Obsidian was closed (§2.4): mtime pre-filter, hash decides. */
  async scanOffline(): Promise<void> {
    const known = new Set<string>();
    for (const file of this.vault.getFiles()) {
      if (this.isExcluded(file.path)) continue;
      known.add(file.path);
      const st = this.state.files[file.path];
      if (!st) {
        this.dirty.add(file.path); // new (or re-enabled folder → scoped first-run, §2.2)
        continue;
      }
      if (new Date(file.stat.mtime).toISOString() !== st.mtime) {
        const content = await this.vault.adapter.readBinary(file.path);
        if (contentHash(new Uint8Array(content)) !== st.hash) this.dirty.add(file.path);
      }
    }
    const missing = Object.keys(this.state.files).filter(
      (p) => !known.has(p) && !this.isExcluded(p),
    );
    const total = Object.keys(this.state.files).length;
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

  /** User-triggered full reconcile: forget the cursor, re-pull the entire S3 state, re-scan all
   * local files. Overlaps union-merge (nothing lost). The escape hatch for stale/foreign state. */
  async resyncEverything(): Promise<void> {
    this.state.lastSyncedRev = 0;
    this.state.files = {};
    this.dirty.clear();
    await this.scanOffline(); // re-mark every local file dirty (empty state → all are "new")
    this.notify("Resync: reconciling the whole vault with S3…", true);
    await this.sync(true); // full pull: ignore echo suppression so THIS device's own files restore too
    await this.opts.onStateChanged(this.state); // force-persist the reset even if S3 was empty
    this.notify("Resync complete", true);
  }

  // ------------------------------------------------------------- sync cycle
  /** One full cycle: pull remote changes (merge conflicts), then push dirty set. */
  async sync(fullPull = false): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.pulled = this.pushed = this.merged = this.skipped = 0;
    const rev0 = this.state.lastSyncedRev;
    try {
      await this.pull(fullPull);
      await this.push();
      const activity = this.pulled + this.pushed + this.merged;
      // Persist only when state actually changed — no-op polls (the common case) skip the write.
      if (activity > 0 || this.state.lastSyncedRev !== rev0) {
        await this.opts.onStateChanged(this.state);
      }
      if (activity > 0 || this.skipped > 0) {
        this.notify(
          `Sync: ↓${this.pulled} ↑${this.pushed}` +
            (this.merged ? ` (${this.merged} merged)` : "") +
            (this.skipped ? ` · ${this.skipped} kept in cloud (over size limit)` : ""),
        );
      }
    } finally {
      this.running = false;
    }
  }

  private async pull(fullPull = false): Promise<void> {
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
      if (!snap) return;
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
      if (deltas.length === 0) return;
      changed = changedEntries(deltas, this.state.lastSyncedRev, excludeBy);
      targetRev = deltas.at(-1)!.rev;
    }

    await mapPool([...changed.entries()], this.opts.concurrency, async ([path, entry]) => {
      if (this.isExcluded(path) || !this.isSafePath(path)) return; // §2.2: skipped, not applied
      await this.applyRemote(path, entry);
    });
    this.state.lastSyncedRev = targetRev;
  }

  private async behindSnapshot(deltas: Delta[]): Promise<boolean> {
    if (deltas.length > 0) return false;
    // empty list can hide "everything newer was pruned" — one HEAD settles it (§1.4)
    const head = await this.storage.head("snapshot.json.gz");
    const rev = Number(head?.metadata?.["revision"] ?? 0);
    return rev > this.state.lastSyncedRev;
  }

  private async applyRemote(path: string, entry: SnapshotEntry): Promise<void> {
    const local = this.vault.getAbstractFileByPath(path);
    const st = this.state.files[path];

    if (isTombstone(entry)) {
      if (local instanceof TFile) {
        const buf = new Uint8Array(await this.vault.adapter.readBinary(path));
        if (st && contentHash(buf) !== st.hash) {
          this.dirty.add(path); // delete-vs-edit: our edit wins (§1.5) → re-push
          return;
        }
        await this.withApplying(path, () => this.vault.adapter.remove(path));
        this.pulled++;
      }
      delete this.state.files[path];
      this.dirty.delete(path);
      return;
    }

    const remote = entry as FileEntry & SnapshotEntry;
    const localBuf =
      local instanceof TFile ? new Uint8Array(await this.vault.adapter.readBinary(path)) : null;
    const localHash = localBuf ? contentHash(localBuf) : null;
    if (localHash === remote.hash) {
      this.record(path, remote); // already identical — just record
      return;
    }

    const localDirty = localBuf !== null && (!st || localHash !== st.hash);
    if (!localDirty) {
      // Per-device download cap: oversized remote files stay in the cloud on this device to save
      // space. Leave local as-is and DON'T record — the file just isn't present here, so it's not
      // "missing" (no tombstone) and a later resync with a higher cap will fetch it. Uploads are
      // never capped, so a big file this device authors still syncs up. A locally-dirty file is
      // exempt (below): we must resolve it, and it's already taking space anyway.
      if (!this.downloadAllowed(remote.size)) {
        this.skipped++;
        return;
      }
      // clean local (or absent) → take remote as-is
      const obj = await this.storage.get(`files/${path}`);
      if (!obj) return;
      await this.write(path, obj.body, remote.mtime);
      this.record(path, { ...remote, s3VersionId: obj.versionId ?? remote.s3VersionId });
      this.pulled++;
      return;
    }

    // CONFLICT: changed locally AND remotely → union merge with versioned base (§1.5)
    if (!this.isTextPath(path) || localBuf!.byteLength > LWW_SIZE_LIMIT) {
      // last-writer-wins for binary/huge: keep local, re-push (never silently lose local edits)
      this.dirty.add(path);
      return;
    }
    const baseObj = st?.s3VersionId
      ? await this.storage.get(`files/${path}`, { versionId: st.s3VersionId })
      : null;
    const remoteObj = await this.storage.get(`files/${path}`);
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
    this.record(path, { ...remote, hash: contentHash(merged.text) });
    this.dirty.add(path); // merged result must go back to S3
    this.merged++;
    if (merged.hadConflicts) this.notify(`Sync: union-merged conflict in ${path}`, true);
  }

  private async push(): Promise<void> {
    const paths = [...this.dirty].filter((p) => !this.isExcluded(p));
    if (paths.length === 0) return;

    const files: Record<string, DeltaEntry> = {};
    const newStates = new Map<string, FileState | null>();

    await mapPool(paths, this.opts.concurrency, async (path) => {
      const file = this.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        if (this.state.files[path]) {
          files[path] = { deleted: true }; // deleted locally → tombstone
          newStates.set(path, null);
        }
        return;
      }
      const buf = new Uint8Array(await this.vault.adapter.readBinary(path));
      const hash = contentHash(buf);
      const st = this.state.files[path];
      const mtime = new Date(file.stat.mtime).toISOString();
      if (st && st.hash === hash) return; // mtime-only touch → drop (§1.6)
      const res = await this.storage.put(`files/${path}`, buf);
      const entry: FileEntry = { hash, s3VersionId: res.versionId, size: buf.byteLength, mtime };
      files[path] = entry;
      newStates.set(path, { hash, s3VersionId: res.versionId, mtime });
    });

    if (Object.keys(files).length === 0) {
      this.dirty.clear();
      return;
    }

    const result = await appendDelta(
      this.storage,
      this.state.lastSyncedRev + 1,
      (rev): Delta => ({ rev, by: this.opts.deviceId, at: new Date().toISOString(), files }),
      async (winner) => {
        // lost the CAS race — apply the winner's entries before retrying (§1.3)
        for (const [path, entry] of Object.entries(winner.files)) {
          if (winner.by !== this.opts.deviceId && !(path in files)) {
            await this.applyRemote(path, { ...entry, rev: winner.rev, by: winner.by });
          }
        }
      },
    );

    for (const [path, st] of newStates) {
      if (st === null) delete this.state.files[path];
      else this.state.files[path] = st;
    }
    this.state.lastSyncedRev = result.rev;
    this.pushed += Object.keys(files).length;
    this.dirty.clear();
  }

  // ------------------------------------------------------------- helpers
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

  /** write with mtime aligned to the manifest (§2.5) and echo suppression */
  private async write(path: string, data: Uint8Array, mtimeIso: string): Promise<void> {
    await this.withApplying(path, async () => {
      const dir = path.split("/").slice(0, -1).join("/");
      if (dir && !(await this.vault.adapter.exists(dir))) await this.vault.adapter.mkdir(dir);
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
