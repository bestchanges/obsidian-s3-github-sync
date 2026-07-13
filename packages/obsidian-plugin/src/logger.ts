import type { StorageAdapter } from "@vault-sync/core";

export type LogLevel = "info" | "warn" | "error";

/** Local active log file cap. On overflow the active file rolls to `<path>.1` (one backup kept). */
const ROTATE_BYTES = 512 * 1024;
/** How much of the tail we ship to S3 per device — smaller than the disk cap to keep PUTs cheap. */
const UPLOAD_BYTES = 256 * 1024;
/** How much the settings viewer reads back (both legs of a rotation concatenated). */
const VIEW_CHARS = 256 * 1024;
/** S3 side-channel namespace. Outside the delta journal (deltas/ + snapshot.json.gz), so neither
 * sync leg touches it and logs never land in the GitHub repo. Keys: `_logs/<deviceId>.log`. */
const LOG_PREFIX = "_logs/";
const FLUSH_DEBOUNCE_MS = 1_000;

/** The slice of Obsidian's DataAdapter the logger needs. Narrowed to a structural type so tests can
 * supply a trivial in-memory fake without the whole Vault surface. */
export interface LogDiskAdapter {
  append(path: string, data: string): Promise<void>;
  write(path: string, data: string): Promise<void>;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ size: number } | null>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface SyncLoggerOptions {
  adapter: LogDiskAdapter;
  /** active log file, e.g. ".obsidian/plugins/vault-s3-sync/sync.log" */
  logPath: string;
  /** gate — logging no-ops entirely when this returns false (the settings toggle) */
  enabled: () => boolean;
}

/** Persistent, best-effort logger for the plugin. Writes timestamped lines to a rotating on-disk
 * file, mirrors to the console (DevTools on desktop), and — when a remote is configured — ships the
 * recent tail to S3 as `_logs/<deviceId>.log` so every device's log is readable from one place.
 *
 * Logging must NEVER throw into the sync path: every disk/network op is wrapped and failures are
 * dropped (at most re-logged to the console). */
export class SyncLogger {
  private readonly adapter: LogDiskAdapter;
  private readonly logPath: string;
  private readonly backupPath: string;
  private readonly enabled: () => boolean;

  private pending: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** serializes flush/rotate so concurrent appends can't interleave or race a rotation */
  private flushChain: Promise<void> = Promise.resolve();
  /** unshipped local content exists since the last successful S3 upload */
  private dirty = false;

  private storage: StorageAdapter | null = null;
  private deviceId = "";

  constructor(opts: SyncLoggerOptions) {
    this.adapter = opts.adapter;
    this.logPath = opts.logPath;
    this.backupPath = opts.logPath + ".1";
    this.enabled = opts.enabled;
  }

  /** Level-dispatch entry point — matches EngineOptions.log so the engine can log directly. */
  log(level: LogLevel, msg: string): void {
    this.append(level, msg);
  }

  info(msg: string): void {
    this.append("info", msg);
  }

  warn(msg: string): void {
    this.append("warn", msg);
  }

  error(msg: string, err?: unknown): void {
    this.append("error", err === undefined ? msg : `${msg}: ${String(err)}`);
  }

  /** Point the logger at S3 (creds changed) or detach it (`null` when unconfigured). */
  setRemote(storage: StorageAdapter | null, deviceId: string): void {
    this.storage = storage;
    this.deviceId = deviceId;
  }

  private logKey(deviceId: string): string {
    return `${LOG_PREFIX}${deviceId}.log`;
  }

  private append(level: LogLevel, msg: string): void {
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
    // Mirror to the console regardless of the toggle — DevTools is free and helps on desktop.
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(
      `[s3-sync] ${msg}`,
    );
    if (!this.enabled()) return;
    this.pending.push(line);
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => void this.flush(), FLUSH_DEBOUNCE_MS);
    }
  }

  /** Write buffered lines to disk and rotate if the active file grew past the cap. Serialized. */
  flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushChain = this.flushChain.then(() => this.doFlush());
    return this.flushChain;
  }

  private async doFlush(): Promise<void> {
    if (this.pending.length === 0) return;
    const chunk = this.pending.join("\n") + "\n";
    this.pending = [];
    try {
      if (await this.adapter.exists(this.logPath)) await this.adapter.append(this.logPath, chunk);
      else await this.adapter.write(this.logPath, chunk);
      this.dirty = true;
      await this.rotateIfNeeded();
    } catch (err) {
      console.error("[s3-sync] log flush failed", err);
    }
  }

  private async rotateIfNeeded(): Promise<void> {
    const st = await this.adapter.stat(this.logPath);
    if (!st || st.size <= ROTATE_BYTES) return;
    try {
      if (await this.adapter.exists(this.backupPath)) await this.adapter.remove(this.backupPath);
      await this.adapter.rename(this.logPath, this.backupPath);
    } catch (err) {
      console.error("[s3-sync] log rotate failed", err);
    }
  }

  /** Concatenated tail of backup + active file, last `maxChars` characters. Empty if none exist. */
  async tail(maxChars = VIEW_CHARS): Promise<string> {
    let text = "";
    try {
      if (await this.adapter.exists(this.backupPath)) text += await this.adapter.read(this.backupPath);
      if (await this.adapter.exists(this.logPath)) text += await this.adapter.read(this.logPath);
    } catch (err) {
      console.error("[s3-sync] log read failed", err);
    }
    return text.length > maxChars ? text.slice(text.length - maxChars) : text;
  }

  /** Ship this device's recent tail to S3, but only if enabled, wired, and there's new content. */
  async uploadIfDirty(): Promise<void> {
    if (!this.enabled() || !this.storage || !this.deviceId) return;
    await this.flush(); // land buffered lines first; doFlush sets `dirty` if anything was written
    if (!this.dirty) return;
    try {
      const text = await this.tail(UPLOAD_BYTES);
      await this.storage.put(this.logKey(this.deviceId), new TextEncoder().encode(text));
      this.dirty = false;
    } catch (err) {
      console.error("[s3-sync] log upload failed", err);
    }
  }

  /** Devices that have shipped a log, newest first. Empty if unwired or on error. */
  async listRemoteDevices(): Promise<{ deviceId: string; lastModified?: Date }[]> {
    if (!this.storage) return [];
    try {
      const objs = await this.storage.list(LOG_PREFIX);
      return objs
        .filter((o) => o.key.startsWith(LOG_PREFIX) && o.key.endsWith(".log"))
        .map((o) => ({
          deviceId: o.key.slice(LOG_PREFIX.length, -".log".length),
          lastModified: o.lastModified,
        }))
        .sort((a, b) => (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0));
    } catch (err) {
      console.error("[s3-sync] log list failed", err);
      return [];
    }
  }

  /** Fetch another device's shipped log as text. Empty string if missing or on error. */
  async readRemote(deviceId: string): Promise<string> {
    if (!this.storage) return "";
    try {
      const res = await this.storage.get(this.logKey(deviceId));
      return res ? new TextDecoder().decode(res.body) : "";
    } catch (err) {
      console.error("[s3-sync] remote log read failed", err);
      return "";
    }
  }

  /** Wipe this device's log: local active + backup, and its own remote object. Other devices' remote
   * logs are left untouched. */
  async clear(): Promise<void> {
    this.pending = [];
    this.dirty = false;
    try {
      if (await this.adapter.exists(this.logPath)) await this.adapter.remove(this.logPath);
      if (await this.adapter.exists(this.backupPath)) await this.adapter.remove(this.backupPath);
    } catch (err) {
      console.error("[s3-sync] log clear failed", err);
    }
    if (this.storage && this.deviceId) {
      try {
        await this.storage.delete(this.logKey(this.deviceId));
      } catch (err) {
        console.error("[s3-sync] remote log clear failed", err);
      }
    }
  }
}
