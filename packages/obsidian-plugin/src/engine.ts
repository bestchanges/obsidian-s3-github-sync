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
const ALWAYS_EXCLUDED = [".obsidian/", ".sync/", ".git/"];
const LWW_SIZE_LIMIT = 5 * 1024 * 1024; // >5 MB: never union-merge (§2.6)

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
  excludedFolders: string[];
  concurrency: number;
  onStateChanged: (state: SyncState) => Promise<void>;
}

export class SyncEngine {
  /** paths currently being written by sync itself — vault events for them are echoes (§2.3) */
  readonly applying = new Set<string>();
  private dirty = new Set<string>();
  private running = false;

  constructor(
    private vault: Vault,
    private storage: StorageAdapter,
    private state: SyncState,
    private opts: EngineOptions,
  ) {}

  // ------------------------------------------------------------- exclusions
  isExcluded(path: string): boolean {
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
    for (const path of Object.keys(this.state.files)) {
      if (!known.has(path) && !this.isExcluded(path)) this.dirty.add(path); // deleted offline
    }
  }

  // ------------------------------------------------------------- sync cycle
  /** One full cycle: pull remote changes (merge conflicts), then push dirty set. */
  async sync(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.pull();
      await this.push();
      await this.opts.onStateChanged(this.state);
    } finally {
      this.running = false;
    }
  }

  private async pull(): Promise<void> {
    let deltas: Delta[];
    let changed: Map<string, SnapshotEntry>;
    let targetRev: number;

    deltas = await listDeltasSince(this.storage, this.state.lastSyncedRev, this.opts.concurrency);
    if (hasGap(this.state.lastSyncedRev, deltas) || (await this.behindSnapshot(deltas))) {
      // cold path (§1.4): journal pruned past us — diff against the snapshot
      const snap = await readSnapshot(this.storage);
      if (!snap) return;
      changed = new Map(
        Object.entries(snap.snapshot.files).filter(
          ([, e]) => e.rev > this.state.lastSyncedRev && e.by !== this.opts.deviceId,
        ),
      );
      targetRev = Math.max(snap.snapshot.revision, deltas.at(-1)?.rev ?? 0);
      for (const [path, entry] of changedEntries(deltas, snap.snapshot.revision, this.opts.deviceId)) {
        changed.set(path, entry);
      }
    } else {
      if (deltas.length === 0) return;
      changed = changedEntries(deltas, this.state.lastSyncedRev, this.opts.deviceId);
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
      // clean local (or absent) → take remote as-is
      const obj = await this.storage.get(`files/${path}`);
      if (!obj) return;
      await this.write(path, obj.body, remote.mtime);
      this.record(path, { ...remote, s3VersionId: obj.versionId ?? remote.s3VersionId });
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
    if (merged.hadConflicts) new Notice(`Sync: union-merged conflict in ${path}`);
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
