import { Notice, Platform, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, getLinkpath, normalizePath } from "obsidian";
import { SyncEngine, SyncState, FileState } from "./engine";
import { S3FetchAdapter } from "./s3-fetch-adapter";
import { SyncLogger } from "./logger";
import { buildStarterZip, deliverFile, safeVaultName } from "./starter";
import { mobileModelFromUA } from "./device-id";
import { decodeJsonGz, encodeJsonGz } from "@vault-sync/core";

interface Settings {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  deviceId: string;
  /** machine the deviceId/state were minted on — recomputed each load, never trusted from disk;
   * a mismatch means data.json was copied from another device (regenerate id + full resync) */
  machineFingerprint: string;
  pollIntervalSec: number; // default 15 (§2.3)
  excludedFolders: string[]; // local-only until re-enabled (§2.2)
  /** per-device download cap in MB; files larger than this stay in the cloud on THIS device to
   * save space (uploads always sync). 0 = no limit. Lives in per-device data.json, so each device
   * sets its own (e.g. 10 on mobile, 0 on the laptop). */
  maxDownloadMB: number;
  verbose: boolean; // Notice on every sync cycle that did something
  mobileConcurrency: number;
  desktopConcurrency: number;
  /** When true, all sync is held off — startup/poll/edit cycles no-op and manual sync/resync are
   * refused with a notice. Edits are still tracked (marked dirty) and flush once resumed. Use it to
   * finish configuring plugins on a new device before the first sync, or to pause temporarily. */
  syncPaused: boolean;
  /** Write a persistent, browsable log to disk and ship this device's recent tail to S3 (readable
   * from any device's settings). Off by default: no disk writes, no PUTs, and no note paths leave
   * the device until enabled. Toggle it on to investigate a sync issue. */
  loggingEnabled: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  bucket: "",
  region: "us-east-1",
  accessKeyId: "",
  secretAccessKey: "",
  prefix: "",
  deviceId: "", // minted on first load: <device label> + a stable suffix (mobile: localStorage anchor)
  machineFingerprint: "",
  pollIntervalSec: 15,
  excludedFolders: [],
  maxDownloadMB: 10, // small by default → mobile stays lean; set 0 on desktop for the full vault
  verbose: false,
  mobileConcurrency: 8,
  desktopConcurrency: 50,
  syncPaused: false,
  loggingEnabled: false,
};

interface PersistedData {
  settings: Settings;
}

/** Older builds embedded syncState in data.json — read once for migration into the state file. */
interface LegacyData {
  settings?: Settings;
  syncState?: SyncState;
}

/** Compact on-disk state: short keys + array entries, gzipped into its own file. Keeps data.json
 * small/copyable and avoids rewriting ~4 MB of plain JSON (20k files) on every sync. */
type CompactEntry = [hash: string, mtime: string] | [hash: string, mtime: string, s3VersionId: string];
interface CompactState {
  r: number;
  f: Record<string, CompactEntry>;
}

function serializeState(s: SyncState): CompactState {
  const f: Record<string, CompactEntry> = {};
  for (const [p, st] of Object.entries(s.files)) {
    f[p] = st.s3VersionId ? [st.hash, st.mtime, st.s3VersionId] : [st.hash, st.mtime];
  }
  return { r: s.lastSyncedRev, f };
}

function deserializeState(c: CompactState): SyncState {
  const files: Record<string, FileState> = {};
  for (const [p, e] of Object.entries(c.f ?? {})) {
    files[p] = { hash: e[0], mtime: e[1], s3VersionId: e[2] };
  }
  return { lastSyncedRev: c.r ?? 0, files };
}

const PUSH_DEBOUNCE_MS = 5_000; // §2.2

/** localStorage key holding this device's stable anchor (§4.2). Namespaced by plugin id; per-device
 * and never written to data.json, so it survives OS/WebView/app updates and isn't copied with the
 * bundle. */
const DEVICE_ANCHOR_KEY = "vault-s3-sync:device-anchor";

export default class S3SyncPlugin extends Plugin {
  settings: Settings = DEFAULT_SETTINGS;
  logger!: SyncLogger;
  private syncState: SyncState = { lastSyncedRev: 0, files: {} };
  private engine: SyncEngine | null = null;
  private pushTimer: number | null = null;
  private pollTimer: number | null = null;
  private foreignStateDetected = false;
  /** True until this device has ever persisted sync state — i.e. no state file existed on load and
   * none was migrated. Gates the engine's first-run "remote wins on collision" bootstrap so a fresh
   * device doesn't union-merge Obsidian's generated config defaults into the canonical settings. */
  private hadPriorState = false;

  async onload(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as LegacyData;
    this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    this.logger = new SyncLogger({
      adapter: this.app.vault.adapter,
      logPath: this.logPath(),
      enabled: () => this.settings.loggingEnabled,
    });
    this.syncState = await this.loadState(data.syncState);
    await this.ensureDeviceIdentity();

    this.addSettingTab(new S3SyncSettingTab(this));
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.runSync("manual") });
    this.addCommand({
      id: "resync-everything",
      name: "Resync everything from S3",
      callback: () => void this.resyncEverything(),
    });
    this.addCommand({
      id: "toggle-sync-pause",
      name: "Pause/resume sync",
      callback: () => void this.setSyncPaused(!this.settings.syncPaused),
    });
    this.addCommand({
      id: "export-starter-vault",
      name: "Export setup vault (for a new device)",
      callback: () => void this.exportStarterVault(),
    });
    this.addCommand({
      id: "force-sync-linked-files",
      name: "Force download linked files of this note (ignore size limit)",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md" || !this.engine) return false;
        if (!checking) void this.forceSyncLinkedFiles(file);
        return true;
      },
    });

    // vault change tracking (§2.2) — events don't fire while the app is closed
    const onChange = (file: TAbstractFile) => {
      if (file instanceof TFile) this.engine?.markDirty(file.path);
    };
    this.registerEvent(this.app.vault.on("create", onChange));
    this.registerEvent(this.app.vault.on("modify", onChange));
    this.registerEvent(this.app.vault.on("delete", onChange));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        // Record the rename so the old path's tombstone carries `renamedTo`: other devices
        // fold a divergent copy of `old` onto `new` instead of resurrecting it.
        if (file instanceof TFile) this.engine?.recordRename(oldPath, file.path);
        this.engine?.markDirty(oldPath); // tombstone old path
        if (file instanceof TFile) this.engine?.markDirty(file.path);
      }),
    );
    this.registerEvent(this.app.vault.on("modify", () => this.schedulePush()));

    // defer startup sync until the vault index is ready
    this.app.workspace.onLayoutReady(() => void this.startup());
  }

  onunload(): void {
    if (this.pushTimer) window.clearTimeout(this.pushTimer);
    if (this.pollTimer) window.clearInterval(this.pollTimer);
    void this.logger?.flush(); // best-effort: land any buffered lines before teardown
  }

  configured(): boolean {
    return !!(this.settings.bucket && this.settings.accessKeyId && this.settings.secretAccessKey);
  }

  // -------------------------------------------------- device identity (§4.2)
  /** A stable, per-device token minted once and kept in this device's localStorage — never written to
   * data.json, so it isn't copied with the bundle AND doesn't fluctuate when the OS/WebView/app
   * updates (unlike the User-Agent, which embeds version numbers). It's cleared only by an app
   * reinstall / cache wipe, which correctly reads as a new device. Anchors both the mobile
   * fingerprint and the deviceId suffix. */
  private deviceAnchor(): string {
    try {
      let anchor = window.localStorage.getItem(DEVICE_ANCHOR_KEY) || "";
      if (!anchor) {
        anchor = Math.random().toString(36).slice(2, 10);
        window.localStorage.setItem(DEVICE_ANCHOR_KEY, anchor);
      }
      return anchor;
    } catch {
      // No localStorage → derive a stable-ish token from the model so we at least don't fluctuate on
      // version bumps (weaker copy detection, but the phantom-resync bug stays fixed).
      return this.slug(mobileModelFromUA(navigator.userAgent || ""));
    }
  }

  /** A fingerprint of the physical device — recomputed at runtime, never read from data.json, so a
   * copied bundle can't fake it. Desktop uses the OS hostname; mobile uses the localStorage anchor
   * (the UA is version-tainted and was minting phantom new devices — §4.2). */
  private computeFingerprint(): string {
    const req = (window as unknown as { require?: (m: string) => { hostname(): string } }).require;
    if (!Platform.isMobile && req) {
      try {
        return "host:" + req("os").hostname();
      } catch {
        /* fall through to the anchor */
      }
    }
    return "anchor:" + this.deviceAnchor();
  }

  private slug(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "device";
  }

  /** Human-readable device label: hostname on desktop, phone model on mobile (§4.2). */
  private deviceLabel(): string {
    const req = (window as unknown as { require?: (m: string) => { hostname(): string } }).require;
    if (!Platform.isMobile && req) {
      try {
        const host = String(req("os").hostname()).split(".")[0];
        if (host) return this.slug(host);
      } catch {
        /* fall through */
      }
    }
    return this.slug(mobileModelFromUA(navigator.userAgent || ""));
  }

  /** `<label>-<suffix>`, unique by design even across identical hardware. On mobile the suffix is the
   * stable device anchor, so the id reads `<phone-model>-<anchor>` and survives updates; on desktop
   * it's a random nibble to disambiguate identical hostnames. */
  private mintDeviceId(): string {
    const suffix = Platform.isMobile
      ? this.deviceAnchor().slice(0, 4)
      : Math.random().toString(36).slice(2, 6);
    return `${this.deviceLabel()}-${suffix}`;
  }

  /** Mint an id on first run; if the stored fingerprint says this data.json came from a different
   * machine, regenerate the id AND reset the cursor so startup does a clean full resync. */
  private async ensureDeviceIdentity(): Promise<void> {
    const fp = this.computeFingerprint();
    let changed = false;
    if (!this.settings.deviceId) {
      this.settings.deviceId = this.mintDeviceId();
      this.settings.machineFingerprint = fp;
      changed = true;
    } else if (!this.settings.machineFingerprint || this.settings.machineFingerprint.startsWith("ua:")) {
      // Upgrade in place: from a build with no fingerprint, or the old fluctuating `ua:` scheme that
      // caused this very bug. Adopt the stable fingerprint and keep the id — no phantom foreign-state
      // resync on the upgrade itself. Copy detection resumes normally afterward.
      this.settings.machineFingerprint = fp;
      changed = true;
    } else if (this.settings.machineFingerprint !== fp) {
      this.settings.deviceId = this.mintDeviceId();
      this.settings.machineFingerprint = fp;
      this.syncState = { lastSyncedRev: 0, files: {} }; // foreign state → cold full pull
      this.foreignStateDetected = true;
      changed = true;
    }
    if (changed) await this.persistSettings();
    if (this.foreignStateDetected) await this.persistState();
  }

  /** Package an empty vault + this plugin (preconfigured, no per-device state) into a zip and hand
   * it to the OS — share sheet on mobile, download on desktop. Runs on any device, no CLI needed. */
  async exportStarterVault(): Promise<void> {
    if (!this.configured()) {
      new Notice("S3 Vault Sync: set the bucket and access keys first.");
      return;
    }
    try {
      const dir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
      const adapter = this.app.vault.adapter;
      const mainJs = new Uint8Array(await adapter.readBinary(normalizePath(`${dir}/main.js`)));
      const manifestJson = await adapter.read(normalizePath(`${dir}/manifest.json`));

      // Export = plugin DEFAULTS + this device's connection fields. Identity is cleared so the new
      // device mints its own, and no state file is included → clean full pull on first run. Sync is
      // paused so the user can enable/configure plugins on the new device before the first sync —
      // they resume it (settings toggle or "Pause/resume sync" command) when ready.
      const settings: Settings = {
        ...DEFAULT_SETTINGS,
        bucket: this.settings.bucket,
        region: this.settings.region,
        accessKeyId: this.settings.accessKeyId,
        secretAccessKey: this.settings.secretAccessKey,
        prefix: this.settings.prefix,
        syncPaused: true,
      };
      const dataJson = JSON.stringify({ settings } satisfies PersistedData, null, 2) + "\n";

      const vaultName = safeVaultName(this.app.vault.getName());
      new Notice("Building vault zip…");
      const zip = buildStarterZip({ vaultName, pluginId: this.manifest.id, mainJs, manifestJson, dataJson });
      const how = await deliverFile(zip, `${vaultName}.zip`);
      if (how === "shared") new Notice(`${vaultName}.zip ready — choose where to send it.`);
      else if (how === "downloaded") new Notice(`Saved ${vaultName}.zip to your downloads.`);
    } catch (err) {
      this.logger.error("starter export failed", err);
      new Notice(`Setup vault export failed: ${String(err)}`);
    }
  }

  /** Toggle the pause gate. Resuming persists first, then kicks an immediate sync and (re)starts
   * the poll so tracked-but-unpushed edits flush right away. Pausing just persists the flag. */
  async setSyncPaused(paused: boolean): Promise<void> {
    this.settings.syncPaused = paused;
    await this.persistSettings();
    this.logger.info(paused ? "sync paused by user" : "sync resumed by user");
    if (paused) {
      new Notice("S3 Vault Sync paused — no syncing until you resume.");
    } else {
      new Notice("S3 Vault Sync resumed.");
      this.startPolling();
      void this.runSync("manual");
    }
  }

  async resyncEverything(): Promise<void> {
    if (!this.engine) {
      new Notice("S3 Vault Sync: not configured");
      return;
    }
    if (this.settings.syncPaused) {
      new Notice("S3 Vault Sync is paused — resume it in settings before resyncing.");
      return;
    }
    this.logger.info("manual resync started");
    try {
      await this.engine.resyncEverything();
      this.logger.info("manual resync finished");
    } catch (err) {
      this.logger.error("resync failed", err);
      new Notice(`S3 resync failed: ${String(err)}`);
    }
    void this.logger.uploadIfDirty();
  }

  /** Collect the link/embed targets of a note as Obsidian linkpaths. Uses BOTH the resolved-links
   * map (present files) and the raw links/embeds in the metadata cache — the latter is what surfaces
   * targets that aren't downloaded locally yet (the whole reason to force them). Heading/block
   * subpaths (#…, #^…) are stripped so we match on the file path alone. */
  private resolveLinkCandidates(file: TFile): string[] {
    const out = new Set<string>();
    const resolved = this.app.metadataCache.resolvedLinks[file.path] ?? {};
    for (const dest of Object.keys(resolved)) out.add(dest);
    const cache = this.app.metadataCache.getFileCache(file);
    for (const ref of [...(cache?.links ?? []), ...(cache?.embeds ?? [])]) {
      const linkpath = getLinkpath(ref.link);
      if (linkpath) out.add(linkpath);
    }
    return [...out];
  }

  /** Command: force-download every file linked/embedded by the active note, ignoring this device's
   * download-size cap. Lets a mobile user pull a note's oversized attachments on demand. */
  async forceSyncLinkedFiles(file: TFile): Promise<void> {
    if (!this.engine) {
      new Notice("S3 Vault Sync: not configured");
      return;
    }
    const candidates = this.resolveLinkCandidates(file);
    if (candidates.length === 0) {
      new Notice("S3 Vault Sync: this note has no linked files.");
      return;
    }
    new Notice(`S3 Vault Sync: force-downloading ${candidates.length} linked file(s)…`);
    try {
      const r = await this.engine.forceDownloadPaths(candidates);
      const parts = [`downloaded ${r.downloaded}`];
      if (r.upToDate) parts.push(`${r.upToDate} already present`);
      if (r.notFound.length) parts.push(`${r.notFound.length} not found in cloud`);
      new Notice(`S3 Vault Sync: ${parts.join(", ")}.`);
    } catch (err) {
      this.logger.error("force download failed", err);
      new Notice(`S3 Vault Sync: force download failed — ${String(err)}`);
    }
  }

  rebuildEngine(): void {
    if (!this.configured()) {
      this.engine = null;
      this.logger.setRemote(null, this.settings.deviceId);
      return;
    }
    const isMobile = (this.app as unknown as { isMobile?: boolean }).isMobile === true;
    const storage = new S3FetchAdapter({
      bucket: this.settings.bucket,
      region: this.settings.region,
      accessKeyId: this.settings.accessKeyId,
      secretAccessKey: this.settings.secretAccessKey,
      prefix: this.settings.prefix,
    });
    this.logger.setRemote(storage, this.settings.deviceId);
    this.engine = new SyncEngine(
      this.app.vault,
      storage,
      this.syncState,
      {
        deviceId: this.settings.deviceId,
        log: (level, msg) => this.logger.log(level, msg),
        selfDir: this.manifest.dir ?? ".obsidian/plugins/vault-s3-sync",
        excludedFolders: this.settings.excludedFolders,
        maxDownloadBytes: this.settings.maxDownloadMB > 0
          ? Math.round(this.settings.maxDownloadMB * 1024 * 1024)
          : 0,
        concurrency: isMobile ? this.settings.mobileConcurrency : this.settings.desktopConcurrency,
        verbose: this.settings.verbose,
        // Fresh device (never synced) that isn't inheriting a copied state: let the first pull take
        // remote as-is on collisions instead of union-merging Obsidian's generated config defaults.
        firstRun: !this.hadPriorState && !this.foreignStateDetected,
        // Re-case a note to a pulled case-only rename through Obsidian's own API so it works on mobile
        // (the raw adapter rejects a case-only rename there) and the new name shows without a reload.
        // Returns false for anything that isn't a note in the vault index (e.g. config files) so the
        // engine falls back to the storage adapter.
        renameFile: async (from, to) => {
          const file = this.app.vault.getAbstractFileByPath(from);
          if (!(file instanceof TFile)) return false;
          await this.app.fileManager.renameFile(file, to);
          return true;
        },
        onStateChanged: async (state) => {
          this.syncState = state;
          await this.persistState();
        },
      },
    );
  }

  private async startup(): Promise<void> {
    this.rebuildEngine();
    this.logger.info(`startup: device "${this.settings.deviceId}", ${this.app.vault.getName()}`);
    if (!this.engine) {
      new Notice("S3 Vault Sync: not configured (see settings)");
      return;
    }
    if (this.foreignStateDetected) {
      this.logger.info(`foreign state detected — new device "${this.settings.deviceId}", full resync`);
      new Notice(`S3 Vault Sync: new device "${this.settings.deviceId}" — running a full resync`);
    }
    if (this.settings.syncPaused) {
      new Notice("S3 Vault Sync is paused — resume it in settings when you're ready to sync.");
    }
    // Startup order (§2.4): pull from S3 FIRST so remote changes land in seconds, THEN scan local
    // files for offline edits/deletes. On mobile the offline scan takes minutes (it walks the whole
    // vault + .obsidian, hashing candidates), so running it first — as one combined cycle used to —
    // strands the cloud pull behind it, the opposite of what someone opening the app wants. It's
    // safe to pull first: applyRemote re-hashes each local file, so an offline edit that ALSO changed
    // remotely still conflict-merges in the pull; only PURE-local offline edits/deletes (which the
    // pull can't see) wait for the scan below.
    if (!this.settings.syncPaused) new Notice("S3 Vault Sync: syncing from cloud…");
    await this.runSync("startup-pull"); // fast: pull remote deltas, announce started/done
    this.startPolling(); // poll loop live now — the app is responsive without waiting on the scan
    void this.runSync("startup-scan"); // offline catch-up (§2.4) in the background; pushes local edits
  }

  startPolling(): void {
    if (this.pollTimer) window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(
      () => void this.runSync("poll"),
      Math.max(5, this.settings.pollIntervalSec) * 1000,
    );
    this.registerInterval(this.pollTimer);
  }

  private schedulePush(): void {
    if (this.pushTimer) window.clearTimeout(this.pushTimer);
    this.pushTimer = window.setTimeout(() => void this.runSync("debounced-edit"), PUSH_DEBOUNCE_MS);
  }

  private syncFailures = 0;
  private async runSync(reason: string): Promise<void> {
    if (!this.engine) return;
    if (this.settings.syncPaused) {
      // Held off by the user. Automatic triggers stay silent; a manual "Sync now" tells them why
      // nothing happened. Dirty tracking keeps running, so edits flush on resume.
      if (reason === "manual") new Notice("S3 Vault Sync is paused — resume it in settings to sync.");
      return;
    }
    // The engine serializes the cycle and runs the pre-scan inside its lock. Startup is split into
    // two cycles: "startup-pull" is a bare remote pull (no scan) so cloud changes land fast, then
    // "startup-scan" does the full offline catch-up (which also walks the config dir) in the
    // background. poll/manual do the cheap config rescan; "debounced-edit" fires after every keystroke
    // burst, so it skips the config walk entirely. Both startup phases and "manual" announce
    // (started/done) so the log shows the cycle even when it transferred nothing.
    const opts =
      reason === "startup-pull"
        ? { label: "startup (cloud pull)", announce: true }
        : reason === "startup-scan"
          ? { scanOffline: true, label: "startup (offline scan)", announce: true }
          : reason === "manual"
            ? { scanConfig: true, label: "manual sync", announce: true }
            : reason === "poll"
              ? { scanConfig: true, label: "poll" }
              : { label: "edit save" };
    try {
      await this.engine.sync(opts);
      this.syncFailures = 0;
    } catch (err) {
      this.syncFailures += 1;
      this.logger.error(`${reason} failed`, err);
      if (this.syncFailures === 1 || this.syncFailures % 10 === 0) {
        new Notice(`S3 sync failed (${reason}) — will keep retrying. ${String(err)}`);
      }
      // dirty set is preserved; next poll retries (§2.6)
    }
    // Ship this device's log tail (no-op unless logging is on and there's new content).
    void this.logger.uploadIfDirty();
  }

  private statePath(): string {
    return normalizePath(`${this.manifest.dir ?? ".obsidian/plugins/vault-s3-sync"}/state.json.gz`);
  }

  private logPath(): string {
    return normalizePath(`${this.manifest.dir ?? ".obsidian/plugins/vault-s3-sync"}/sync.log`);
  }

  /** Load per-device sync state from its gzipped file; migrate an older embedded state once. */
  private async loadState(legacy?: SyncState): Promise<SyncState> {
    const path = this.statePath();
    try {
      if (await this.app.vault.adapter.exists(path)) {
        const buf = new Uint8Array(await this.app.vault.adapter.readBinary(path));
        this.hadPriorState = true;
        return deserializeState(decodeJsonGz<CompactState>(buf));
      }
    } catch (err) {
      this.logger.error("state file unreadable — starting fresh (a resync will rebuild it)", err);
    }
    if (legacy && (legacy.lastSyncedRev || Object.keys(legacy.files ?? {}).length)) {
      await this.writeStateFile(legacy); // one-time migration out of data.json
      this.hadPriorState = true;
      return legacy;
    }
    return { lastSyncedRev: 0, files: {} };
  }

  private async writeStateFile(state: SyncState): Promise<void> {
    const bytes = encodeJsonGz(serializeState(state));
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await this.app.vault.adapter.writeBinary(this.statePath(), ab);
  }

  /** data.json now holds ONLY settings — small and safe to copy between devices. */
  async persistSettings(): Promise<void> {
    await this.saveData({ settings: this.settings } satisfies PersistedData);
  }

  /** The heavy per-file state lives in its own gzipped file, written only when it changed. */
  async persistState(): Promise<void> {
    await this.writeStateFile(this.syncState);
  }
}

class S3SyncSettingTab extends PluginSettingTab {
  constructor(private plugin: S3SyncPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = async () => {
      await this.plugin.persistSettings();
      this.plugin.rebuildEngine();
      this.plugin.startPolling();
    };

    new Setting(containerEl)
      .setName("Pause sync")
      .setDesc(
        "Hold off all syncing — e.g. until you've finished enabling and configuring plugins on a " +
          "new device, or to stop temporarily. Edits are still tracked and flush when you resume.",
      )
      .addToggle((t) =>
        t.setValue(s.syncPaused).onChange((v) => void this.plugin.setSyncPaused(v)));

    new Setting(containerEl).setName("Bucket").addText((t) =>
      t.setValue(s.bucket).onChange(async (v) => { s.bucket = v.trim(); await save(); }));
    new Setting(containerEl).setName("Region").addText((t) =>
      t.setValue(s.region).onChange(async (v) => { s.region = v.trim(); await save(); }));
    new Setting(containerEl).setName("Access key ID").addText((t) =>
      t.setValue(s.accessKeyId).onChange(async (v) => { s.accessKeyId = v.trim(); await save(); }));
    new Setting(containerEl)
      .setName("Secret access key")
      .setDesc("Stored in plugin data on this device.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(s.secretAccessKey).onChange(async (v) => { s.secretAccessKey = v.trim(); await save(); });
      });
    new Setting(containerEl).setName("Key prefix").setDesc('Optional, e.g. "vault/"').addText((t) =>
      t.setValue(s.prefix).onChange(async (v) => { s.prefix = v.trim(); await save(); }));
    new Setting(containerEl)
      .setName("Poll interval (seconds)")
      .setDesc("Default 15. One cheap LIST per interval.")
      .addText((t) =>
        t.setValue(String(s.pollIntervalSec)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 5) { s.pollIntervalSec = n; await save(); }
        }));
    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("One per line. Local-only until re-enabled; re-enabling merges local and remote (union).")
      .addTextArea((t) =>
        t.setValue(s.excludedFolders.join("\n")).onChange(async (v) => {
          s.excludedFolders = v.split("\n").map((x) => x.trim()).filter(Boolean);
          await save();
        }));
    new Setting(containerEl)
      .setName("Max download size (MB)")
      .setDesc(
        "Per-device. Files larger than this stay in the cloud and aren't downloaded here — keeps " +
          "mobile vaults small. Uploads are never limited. 0 = no limit (download everything).",
      )
      .addText((t) =>
        t.setValue(String(s.maxDownloadMB)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0) { s.maxDownloadMB = n; await save(); }
        }));
    new Setting(containerEl)
      .setName("Device ID")
      .setDesc("Writer identity for echo suppression. Auto-generated per device; change only if you must.")
      .addText((t) => t.setValue(s.deviceId).onChange(async (v) => { s.deviceId = v.trim(); await save(); }));
    new Setting(containerEl)
      .setName("Verbose notifications")
      .setDesc("Show a notice after each sync cycle that transferred files (conflicts always notify).")
      .addToggle((t) => t.setValue(s.verbose).onChange(async (v) => { s.verbose = v; await save(); }));
    new Setting(containerEl)
      .setName("Resync everything")
      .setDesc("Forget the local cursor and reconcile the whole vault against S3 (union-merges overlaps, nothing lost). Use after moving devices or if state looks wrong.")
      .addButton((b) =>
        b.setButtonText("Resync").setWarning().onClick(() => void this.plugin.resyncEverything()));
    new Setting(containerEl)
      .setName("Set up a new device")
      .setDesc(
        "Export a zip: an empty vault with this plugin preconfigured (defaults, 10 MB download cap, " +
          "no local state, sync paused). On the new device open it as a vault and turn on community " +
          "plugins; enable/configure your plugins, then resume sync (settings toggle) to pull the " +
          "vault. Works on mobile too (share sheet). Contains your secret key — share privately.",
      )
      .addButton((b) =>
        b.setButtonText("Export setup vault").setCta().onClick(() => void this.plugin.exportStarterVault()));

    this.renderLogsSection(containerEl, s, save);
  }

  /** "Logs" section: on/off toggle, a per-device picker (this device + everything shipped to S3),
   * a read-only viewer (newest line first), and refresh / copy / clear actions. */
  private renderLogsSection(
    containerEl: HTMLElement,
    s: Settings,
    save: () => Promise<void>,
  ): void {
    const { logger } = this.plugin;
    containerEl.createEl("h3", { text: "Logs" });

    new Setting(containerEl)
      .setName("Enable logging")
      .setDesc(
        "Write a persistent log to disk and ship this device's recent activity to S3 so it's " +
          "readable from any device below. Off by default. Log lines include note paths (never " +
          "credentials) and are stored in your bucket.",
      )
      .addToggle((t) =>
        t.setValue(s.loggingEnabled).onChange(async (v) => {
          s.loggingEnabled = v;
          await save();
        }));

    // "" selects this device (read fresh from disk); any other value is a remote deviceId.
    let selected = "";
    const viewer = containerEl.createEl("textarea", { cls: "s3-sync-log-viewer" });
    viewer.readOnly = true;
    Object.assign(viewer.style, {
      width: "100%",
      height: "16em",
      fontFamily: "monospace",
      fontSize: "12px",
      whiteSpace: "pre",
      overflow: "auto",
    });

    // Newest first: the on-disk file is chronological (append order); the viewer reverses it.
    const newestFirst = (text: string): string =>
      text.split("\n").filter((l) => l.length > 0).reverse().join("\n");

    const loadView = async (): Promise<void> => {
      viewer.value = "Loading…";
      const text = selected === "" ? await logger.tail() : await logger.readRemote(selected);
      viewer.value = newestFirst(text) || "(empty)";
      viewer.scrollTop = 0;
    };

    const picker = new Setting(containerEl).setName("Show log from");
    const rebuildPicker = async (): Promise<void> => {
      const devices = await logger.listRemoteDevices();
      picker.clear();
      picker.addDropdown((d) => {
        d.addOption("", `This device (${s.deviceId})`);
        for (const { deviceId } of devices) {
          if (deviceId === s.deviceId) continue; // already covered by "This device"
          d.addOption(deviceId, deviceId);
        }
        d.setValue(selected).onChange((v) => {
          selected = v;
          void loadView();
        });
      });
    };

    new Setting(containerEl)
      .addButton((b) =>
        b.setButtonText("Refresh").onClick(async () => {
          await logger.flush();
          await rebuildPicker();
          await loadView();
        }))
      .addButton((b) =>
        b.setButtonText("Copy").onClick(async () => {
          try {
            await navigator.clipboard.writeText(viewer.value);
            new Notice("Log copied to clipboard.");
          } catch {
            new Notice("Couldn't copy — select the text and copy manually.");
          }
        }))
      .addButton((b) =>
        b.setButtonText("Clear logs").setWarning().onClick(async () => {
          await logger.clear();
          selected = "";
          await rebuildPicker();
          await loadView();
          new Notice("Logs cleared on this device.");
        }));

    void rebuildPicker();
    void loadView();
  }
}
