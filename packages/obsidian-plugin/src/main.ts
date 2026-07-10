import { Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile } from "obsidian";
import { SyncEngine, SyncState } from "./engine";
import { S3FetchAdapter } from "./s3-fetch-adapter";

interface Settings {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  deviceId: string;
  pollIntervalSec: number; // default 15 (§2.3)
  excludedFolders: string[]; // local-only until re-enabled (§2.2)
  mobileConcurrency: number;
  desktopConcurrency: number;
}

const DEFAULT_SETTINGS: Settings = {
  bucket: "",
  region: "us-east-1",
  accessKeyId: "",
  secretAccessKey: "",
  prefix: "",
  deviceId: `device:${Math.random().toString(36).slice(2, 8)}`,
  pollIntervalSec: 15,
  excludedFolders: [],
  mobileConcurrency: 8,
  desktopConcurrency: 50,
};

interface PersistedData {
  settings: Settings;
  syncState: SyncState;
}

const PUSH_DEBOUNCE_MS = 5_000; // §2.2

export default class S3SyncPlugin extends Plugin {
  settings: Settings = DEFAULT_SETTINGS;
  private syncState: SyncState = { lastSyncedRev: 0, files: {} };
  private engine: SyncEngine | null = null;
  private pushTimer: number | null = null;
  private pollTimer: number | null = null;

  async onload(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<PersistedData>;
    this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    this.syncState = data.syncState ?? { lastSyncedRev: 0, files: {} };

    this.addSettingTab(new S3SyncSettingTab(this));
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.runSync("manual") });

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
        excludedFolders: this.settings.excludedFolders,
        concurrency: isMobile ? this.settings.mobileConcurrency : this.settings.desktopConcurrency,
        onStateChanged: async (state) => {
          this.syncState = state;
          await this.persist();
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

  async persist(): Promise<void> {
    await this.saveData({ settings: this.settings, syncState: this.syncState } satisfies PersistedData);
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
      await this.plugin.persist();
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
      .setName("Device ID")
      .setDesc("Writer identity for echo suppression — unique per device.")
      .addText((t) => t.setValue(s.deviceId).onChange(async (v) => { s.deviceId = v.trim(); await save(); }));
  }
}
