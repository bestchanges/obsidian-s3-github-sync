import { Notice, Platform, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, normalizePath } from "obsidian";
import { SyncEngine, SyncState, FileState } from "./engine";
import { S3FetchAdapter } from "./s3-fetch-adapter";
import { buildStarterZip, deliverFile, safeVaultName } from "./starter";
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
}

const DEFAULT_SETTINGS: Settings = {
  bucket: "",
  region: "us-east-1",
  accessKeyId: "",
  secretAccessKey: "",
  prefix: "",
  deviceId: "", // minted on first load from the machine label + a random suffix
  machineFingerprint: "",
  pollIntervalSec: 15,
  excludedFolders: [],
  maxDownloadMB: 10, // small by default → mobile stays lean; set 0 on desktop for the full vault
  verbose: false,
  mobileConcurrency: 8,
  desktopConcurrency: 50,
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

export default class S3SyncPlugin extends Plugin {
  settings: Settings = DEFAULT_SETTINGS;
  private syncState: SyncState = { lastSyncedRev: 0, files: {} };
  private engine: SyncEngine | null = null;
  private pushTimer: number | null = null;
  private pollTimer: number | null = null;
  private foreignStateDetected = false;

  async onload(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as LegacyData;
    this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
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
      id: "export-starter-vault",
      name: "Export setup vault (for a new device)",
      callback: () => void this.exportStarterVault(),
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
  }

  configured(): boolean {
    return !!(this.settings.bucket && this.settings.accessKeyId && this.settings.secretAccessKey);
  }

  // -------------------------------------------------- device identity (§2 discussion)
  /** A fingerprint of the physical machine — recomputed at runtime, never read from data.json,
   * so a copied bundle can't fake it. Desktop uses the OS hostname; mobile falls back to the UA. */
  private computeFingerprint(): string {
    const req = (window as unknown as { require?: (m: string) => { hostname(): string } }).require;
    if (!Platform.isMobile && req) {
      try {
        return "host:" + req("os").hostname();
      } catch {
        /* fall through to UA */
      }
    }
    return "ua:" + (navigator.userAgent || "unknown");
  }

  private slug(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "device";
  }

  /** Human-readable device label: hostname on desktop, model-ish token on mobile. */
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
    const m = (navigator.userAgent || "").match(/iPhone|iPad|Android|Macintosh|Windows|Linux/i);
    return this.slug(m ? m[0] : "device");
  }

  /** Label + first-run random suffix → unique by design, even across identical hardware. */
  private mintDeviceId(): string {
    return `${this.deviceLabel()}-${Math.random().toString(36).slice(2, 6)}`;
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
    } else if (!this.settings.machineFingerprint) {
      this.settings.machineFingerprint = fp; // upgrade from a build without fingerprints
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
      // device mints its own, and no state file is included → clean full pull on first run.
      const settings: Settings = {
        ...DEFAULT_SETTINGS,
        bucket: this.settings.bucket,
        region: this.settings.region,
        accessKeyId: this.settings.accessKeyId,
        secretAccessKey: this.settings.secretAccessKey,
        prefix: this.settings.prefix,
      };
      const dataJson = JSON.stringify({ settings } satisfies PersistedData, null, 2) + "\n";

      const vaultName = safeVaultName(this.app.vault.getName());
      new Notice("Building vault zip…");
      const zip = buildStarterZip({ vaultName, pluginId: this.manifest.id, mainJs, manifestJson, dataJson });
      const how = await deliverFile(zip, `${vaultName}.zip`);
      if (how === "shared") new Notice(`${vaultName}.zip ready — choose where to send it.`);
      else if (how === "downloaded") new Notice(`Saved ${vaultName}.zip to your downloads.`);
    } catch (err) {
      console.error("[s3-sync] starter export failed", err);
      new Notice(`Setup vault export failed: ${String(err)}`);
    }
  }

  async resyncEverything(): Promise<void> {
    if (!this.engine) {
      new Notice("S3 Vault Sync: not configured");
      return;
    }
    try {
      await this.engine.resyncEverything();
    } catch (err) {
      console.error("[s3-sync] resync failed", err);
      new Notice(`S3 resync failed: ${String(err)}`);
    }
  }

  rebuildEngine(): void {
    if (!this.configured()) {
      this.engine = null;
      return;
    }
    const isMobile = (this.app as unknown as { isMobile?: boolean }).isMobile === true;
    this.engine = new SyncEngine(
      this.app.vault,
      new S3FetchAdapter({
        bucket: this.settings.bucket,
        region: this.settings.region,
        accessKeyId: this.settings.accessKeyId,
        secretAccessKey: this.settings.secretAccessKey,
        prefix: this.settings.prefix,
      }),
      this.syncState,
      {
        deviceId: this.settings.deviceId,
        selfDir: this.manifest.dir ?? ".obsidian/plugins/vault-s3-sync",
        excludedFolders: this.settings.excludedFolders,
        maxDownloadBytes: this.settings.maxDownloadMB > 0
          ? Math.round(this.settings.maxDownloadMB * 1024 * 1024)
          : 0,
        concurrency: isMobile ? this.settings.mobileConcurrency : this.settings.desktopConcurrency,
        verbose: this.settings.verbose,
        onStateChanged: async (state) => {
          this.syncState = state;
          await this.persistState();
        },
      },
    );
  }

  private async startup(): Promise<void> {
    this.rebuildEngine();
    if (!this.engine) {
      new Notice("S3 Vault Sync: not configured (see settings)");
      return;
    }
    if (this.foreignStateDetected) {
      new Notice(`S3 Vault Sync: new device "${this.settings.deviceId}" — running a full resync`);
    }
    await this.engine.scanOffline(); // offline catch-up (§2.4)
    await this.runSync("startup");
    this.startPolling();
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
    try {
      // Config dir emits no vault events, so scan it here — but only on the low-frequency triggers.
      // "debounced-edit" fires after every note edit (non-config), so scanning then would re-walk
      // the whole config dir on each keystroke burst for nothing.
      if (reason === "poll" || reason === "startup" || reason === "manual") {
        await this.engine.scanConfigDir();
      }
      await this.engine.sync();
      this.syncFailures = 0;
    } catch (err) {
      this.syncFailures += 1;
      console.error(`[s3-sync] ${reason} failed`, err);
      if (this.syncFailures === 1 || this.syncFailures % 10 === 0) {
        new Notice(`S3 sync failed (${reason}) — will keep retrying. ${String(err)}`);
      }
      // dirty set is preserved; next poll retries (§2.6)
    }
  }

  private statePath(): string {
    return normalizePath(`${this.manifest.dir ?? ".obsidian/plugins/vault-s3-sync"}/state.json.gz`);
  }

  /** Load per-device sync state from its gzipped file; migrate an older embedded state once. */
  private async loadState(legacy?: SyncState): Promise<SyncState> {
    const path = this.statePath();
    try {
      if (await this.app.vault.adapter.exists(path)) {
        const buf = new Uint8Array(await this.app.vault.adapter.readBinary(path));
        return deserializeState(decodeJsonGz<CompactState>(buf));
      }
    } catch (err) {
      console.error("[s3-sync] state file unreadable — starting fresh (a resync will rebuild it)", err);
    }
    if (legacy && (legacy.lastSyncedRev || Object.keys(legacy.files ?? {}).length)) {
      await this.writeStateFile(legacy); // one-time migration out of data.json
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
          "no local state). On the new device open it as a vault and turn on community plugins — it " +
          "syncs the whole vault. Works on mobile too (share sheet). Contains your secret key — share privately.",
      )
      .addButton((b) =>
        b.setButtonText("Export setup vault").setCta().onClick(() => void this.plugin.exportStarterVault()));
  }
}
