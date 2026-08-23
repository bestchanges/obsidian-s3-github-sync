import { Menu, Notice, Platform, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, getLinkpath, normalizePath } from "obsidian";
import { CycleAbandonedError, SyncEngine, SyncState, FileState } from "./engine";
import { S3FetchAdapter } from "./s3-fetch-adapter";
import { SyncLogger } from "./logger";
import { VersionHistoryModal } from "./history-modal";
import { ForeignStateChoice, ForeignStateModal } from "./foreign-state-modal";
import { buildStarterZip, deliverFile, safeVaultName } from "./starter";
import { mobileModelFromUA } from "./device-id";
import { pollDelayMs, pushDelayMs } from "./poll-schedule";
import { ChangeNotifier, revTopic } from "./notify";
import { decodeJsonGz, encodeJsonGz, readFileHistory } from "@vault-sync/core";

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
  pollIntervalSec: number; // default 15 — the BASELINE of the adaptive poll (§4.9a)
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
  /** Subscribe to change notifications over AWS IoT Core so peers' revisions arrive in
   * milliseconds instead of at the next poll (§4.14). Off by default — it needs `iotEndpoint` and
   * the matching IAM grants; with it off the plugin behaves exactly as before. */
  pushNotifications: boolean;
  /** IoT ATS data endpoint host for this account/region, e.g.
   * `a1b2c3d4e5f6g7.iot.eu-central-1.amazonaws.com` (`aws iot describe-endpoint
   * --endpoint-type iot:Data-ATS`). Only used when pushNotifications is on. */
  iotEndpoint: string;
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
  pushNotifications: false,
  iotEndpoint: "",
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

/** Desktop-only: how long after launch the offline scan is armed. Keeps the first moments of a
 * session for the fast pull + quick-edit push; the scan (off the reconcile lock) then catches any
 * edits made outside the app while it was closed (§4.4). */
const OFFLINE_SCAN_DELAY_MS = 30_000;

/** A poll tick that lands more than this many intervals past the previous one means the device was
 * frozen in between (mobile suspend, laptop sleep) — the WebView is running again but its network
 * stack usually is not, and firing the cycle now just burns it on "Failed to fetch". */
const POLL_LATE_FACTOR = 2;
/** How long to let the network settle after a resume before the catch-up cycle. */
const RESUME_GRACE_MS = 1_500;

/** Returning to a device syncs immediately instead of waiting out the pending tick — that wait is
 * exactly the latency people notice. Throttled so alt-tabbing doesn't cost a cycle each time. */
const FOCUS_SYNC_MIN_GAP_MS = 5_000;
/** Consecutive background failures before a transient network error is worth a Notice. Resume
 * failures come in ones and recover on the next cycle; a real outage keeps counting. */
const TRANSIENT_QUIET_FAILURES = 3;

/** Network-level failure (the request never reached S3) as opposed to a protocol/logic error: fetch
 * rejects with TypeError, our own request timeout surfaces as AbortError. These are expected after a
 * resume and self-heal, so they don't deserve the same noise as a real fault. */
function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  return err instanceof Error && err.name === "AbortError";
}

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
  /** When the current burst of unpushed edits began; 0 when nothing is pending. Anchors the
   * max-wait that keeps a long typing session from starving the debounce (§4.4). */
  private pushFirstEditAt = 0;
  private pollTimer: number | null = null;
  /** Wall clock of the last poll tick, and the interval it was armed with — together they tell a
   * normal tick from one that fired after the device was frozen (§resume handling in startPolling). */
  private lastPollTick = 0;
  private pollIntervalMs = 0;
  /** True once the poll loop has been armed — the tier helpers and the focus trigger are no-ops
   * before that (unconfigured vault, or startup still waiting on the vault index). */
  private polling = false;
  /** Wall clock of the last observed movement (local edit, or a cycle that changed state). Drives
   * the ACTIVE poll tier; 0 means "nothing yet this session", which reads as idle. */
  private lastActivityAt = 0;
  /** Change-notification socket (§4.14); null when the feature is off or unconfigured. */
  private notifier: ChangeNotifier | null = null;
  /** Armed catch-up cycle after a resume; non-null means one is already pending, so the drift check
   * and the visibility event coalesce into a single sync instead of racing each other. */
  private resumeTimer: number | null = null;
  /** Pending desktop deferred-scan timer; null when none is armed (also nulled once it fires). */
  private offlineScanTimer: number | null = null;
  /** Single-flight guard so the deferred timer and a manual "Scan for external changes" can't overlap. */
  private offlineScanRunning = false;
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
      id: "scan-external-changes",
      name: "Scan for external changes",
      callback: () => void this.runOfflineScan("manual"),
    });
    this.addCommand({
      id: "export-starter-vault",
      name: "Export setup vault (for a new device)",
      callback: () => void this.exportStarterVault(),
    });
    this.addCommand({
      id: "version-history",
      name: "Version history of this note",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.configured()) return false;
        if (!checking) this.openVersionHistory(file.path);
        return true;
      },
    });
    // Mirror Sync's context-menu affordance on our own history (§4.12). `file-menu` is the public
    // hook; Obsidian's own "Open version history" is Sync-only and has no API to extend.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFile) || !this.configured()) return;
        if (this.engine?.isExcluded(file.path)) return;
        menu.addItem((item) =>
          item
            .setTitle("Version history (S3 sync)")
            .setIcon("lucide-history")
            .onClick(() => this.openVersionHistory(file.path)));
      }),
    );
    // Obsidian Sync registers `sync:history` for the same job; this is the public equivalent.
    // registerCliHandler landed in 1.12.2, which is exactly why manifest.minAppVersion is pinned
    // there — Obsidian refuses to load a plugin below its own minAppVersion, so this is guaranteed
    // present. The check is kept as defence-in-depth: our primary channel is self-distribution
    // through the vault sync itself (§8), where a plugin that throws in onload takes sync down with
    // it and can no longer receive its own fix. Cheap insurance against an onload-fatal surprise.
    if (typeof this.registerCliHandler === "function") {
      this.registerCliHandler(
        "vault-s3-sync:history",
        "List S3 sync revisions of a vault file",
        {
          path: { value: "<path>", description: "Vault-relative file path" },
          total: { description: "Return the revision count only" },
        },
        (params) => this.cliHistory(params),
      );
    }
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

    // Coming back to the app after it was backgrounded is the other half of the resume story: on
    // Android the poll timer may not have ticked at all while frozen, so the drift check in
    // startPolling has nothing to notice. Only act when a poll is actually due — a quick app switch
    // shouldn't trigger an extra cycle.
    this.registerDomEvent(document, "visibilitychange", () => {
      // Backgrounded/closed: flush any debounced edit now so a "quick edit then close" (common on
      // mobile, inside the 5 s debounce) ships before the OS suspends the app rather than stranding.
      if (document.visibilityState === "hidden") {
        this.flushPendingPush();
        // Drop the notification socket: mobile is about to be suspended and the connection dies
        // with it anyway, so holding it open only bills connection-minutes for a dead link (§4.14).
        this.notifier?.stop();
        return;
      }
      this.rebuildNotifier(); // back in the foreground: re-establish the socket
      if (this.pollTimer === null) return;
      // Visible again: re-arm so the loop leaves the BACKGROUND tier immediately rather than after
      // one more long tick (§4.9a). Only sync from here when a poll is genuinely due — a quick app
      // switch shouldn't trigger an extra cycle, and `focus` covers the desktop case anyway.
      if (Date.now() - this.lastPollTick < this.pollIntervalMs) {
        this.startPolling();
        return;
      }
      this.lastPollTick = Date.now();
      this.scheduleResumeSync();
      this.startPolling();
    });

    // Desktop app-switching raises `focus` without ever changing visibilityState, so this is the
    // only signal for "the user came back to this window" (§4.9a).
    this.registerDomEvent(window, "focus", () => this.onReturnToDevice());

    // defer startup sync until the vault index is ready
    this.app.workspace.onLayoutReady(() => void this.startup());
  }

  onunload(): void {
    // Best-effort flush before teardown so a debounced edit isn't lost when the app quits/reloads.
    // Kick it BEFORE clearing pushTimer (flushPendingPush cancels the debounce and syncs now).
    this.flushPendingPush();
    if (this.pushTimer) window.clearTimeout(this.pushTimer);
    this.polling = false;
    this.notifier?.stop();
    if (this.pollTimer) window.clearTimeout(this.pollTimer); // self-rescheduling timeout, not an interval
    if (this.resumeTimer) window.clearTimeout(this.resumeTimer);
    this.clearOfflineScan();
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
      // Foreign state (this vault was copied/restored onto another machine, or the OS was
      // reinstalled): re-mint the id so delta attribution and echo suppression can't collide with
      // the device this copy came from, and rewind the cursor for a cold full pull — but KEEP the
      // file baselines. They are content-addressed (`path → {hash, s3VersionId}`), so every entry
      // whose hash still matches the file on disk is a valid merge base; applyRemote re-hashes each
      // file anyway, so a stale entry costs nothing while a correct one turns the whole restore into
      // ordinary clean fast-forwards. Dropping them used to leave every colliding note with NO merge
      // base, and `unionMerge("", local, remote)` keeps both sides of every changed line — which is
      // how a Mac rebuild duplicated every rolled-forward recurring task in the vault.
      this.syncState = { lastSyncedRev: 0, files: this.syncState.files };
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
    this.rebuildNotifier(); // pausing drops the socket; resuming re-establishes it (§4.14)
    if (paused) {
      new Notice("S3 Vault Sync paused — no syncing until you resume.");
    } else {
      new Notice("S3 Vault Sync resumed.");
      this.startPolling();
      void this.runSync("manual");
      // Desktop: the deferred scan may have been skipped while paused (or never armed if paused at
      // launch) — re-arm it so external-edit catch-up still happens once syncing is back on.
      if (!Platform.isMobile) this.scheduleOfflineScan();
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

  // -------------------------------------------------- version history (§4.12)
  /** Open the journal-backed history panel for a vault path. */
  openVersionHistory(path: string): void {
    if (!this.configured()) {
      new Notice("S3 Vault Sync: set the bucket and access keys first.");
      return;
    }
    const isMobile = (this.app as unknown as { isMobile?: boolean }).isMobile === true;
    new VersionHistoryModal(this.app, {
      storage: new S3FetchAdapter({
        bucket: this.settings.bucket,
        region: this.settings.region,
        accessKeyId: this.settings.accessKeyId,
        secretAccessKey: this.settings.secretAccessKey,
        prefix: this.settings.prefix,
      }),
      path,
      deviceId: this.settings.deviceId,
      concurrency: isMobile ? this.settings.mobileConcurrency : this.settings.desktopConcurrency,
      log: (level, msg) => this.logger.log(level, msg),
      backupBeforeWrite: (p) => this.recoverySnapshot(p),
      // A restore is an ordinary local edit: mark it dirty and let the debounced push publish it as
      // a new revision, so history stays append-only.
      afterRestore: () => {
        this.engine?.markDirty(path);
        void this.runSync("manual");
      },
    }).open();
  }

  /**
   * Push the CURRENT local bytes of a path into Obsidian's **File recovery** store before sync (or a
   * restore) overwrites them (§4.12).
   *
   * `file-recovery` is a core plugin reached through `app.internalPlugins`, which is NOT part of the
   * public API — Obsidian's own Sync calls the same `forceAdd` before restoring a version. Everything
   * here is therefore feature-detected and best-effort: if the shape ever changes, we lose the extra
   * safety net, never the sync. Snapshots are device-local and cover `.md`/`.canvas` only.
   */
  private async recoverySnapshot(path: string): Promise<void> {
    const ext = path.split(".").pop()?.toLowerCase();
    if (ext !== "md" && ext !== "canvas") return;
    try {
      const internal = (this.app as unknown as {
        internalPlugins?: {
          getEnabledPluginById(id: string): { forceAdd?(path: string, data: string): Promise<void> } | null;
        };
      }).internalPlugins;
      const recovery = internal?.getEnabledPluginById("file-recovery");
      if (!recovery?.forceAdd) return;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return;
      // forceAdd takes the PATH, not the TFile: it stores `{path, ts, data}` straight into IndexedDB,
      // and a TFile there fails the structured clone (it reaches app internals, which hold functions).
      // Obsidian's own restore path calls it the same way.
      await recovery.forceAdd(file.path, await this.app.vault.read(file));
    } catch (err) {
      this.logger.log("warn", `file-recovery snapshot skipped for ${path}: ${String(err)}`);
    }
  }

  /** `vault-s3-sync:history` — the CLI equivalent of the panel (Sync exposes `sync:history`). */
  private async cliHistory(params: Record<string, string>): Promise<string> {
    if (!this.configured()) return "S3 Vault Sync is not configured.";
    const path = params.path || this.app.workspace.getActiveFile()?.path;
    if (!path) return "Pass --path <path>, or open the file first.";
    const isMobile = (this.app as unknown as { isMobile?: boolean }).isMobile === true;
    const storage = new S3FetchAdapter({
      bucket: this.settings.bucket,
      region: this.settings.region,
      accessKeyId: this.settings.accessKeyId,
      secretAccessKey: this.settings.secretAccessKey,
      prefix: this.settings.prefix,
    });
    const { versions, truncated, oldestRevAvailable } = await readFileHistory(
      storage,
      path,
      isMobile ? this.settings.mobileConcurrency : this.settings.desktopConcurrency,
    );
    if (params.total === "true") return String(versions.length);
    if (versions.length === 0) return `No revisions found for ${path}`;
    const lines = versions.map((v) => {
      const when = (v.at ? new Date(v.at).toISOString().replace("T", " ").slice(0, 19) : "").padEnd(19);
      const what = v.deleted ? (v.renamedTo ? `renamed → ${v.renamedTo}` : "deleted") : `${v.size ?? 0} B`;
      const where = v.path === path ? "" : `  (as ${v.path})`;
      return `${String(v.rev).padStart(6)}  ${when}  ${v.by.padEnd(24)}  ${what}${where}`;
    });
    if (truncated) lines.push(`(journal pruned below rev ${oldestRevAvailable} — older revisions unavailable)`);
    return [path, ...lines].join("\n");
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
        // Copied/restored state: the retained baselines have never been checked against THIS disk,
        // so the first offline scan must restore what it can't find rather than tombstone it, and
        // the first cycle must ask before resolving collisions instead of union-merging the vault.
        adoptedForeignState: this.foreignStateDetected,
        deferConflicts: this.foreignStateDetected,
        // Re-case a note to a pulled case-only rename through Obsidian's own API so it works on mobile
        // (the raw adapter rejects a case-only rename there) and the new name shows without a reload.
        // Returns false for anything that isn't a note in the vault index (e.g. config files) so the
        // engine falls back to the storage adapter.
        // Write pulled notes through the Vault, not the adapter (§4.8): the adapter puts the bytes
        // on disk but tells Obsidian nothing, so a note open in an editor keeps showing its stale
        // buffer — and Obsidian later saves that buffer back over the pulled content, which the
        // engine then publishes as a "local edit" and every device rolls back. `modifyBinary` makes
        // the open view follow the file. Config-dir paths aren't in the index → false → adapter.
        writeFile: async (path, data, mtimeMs) => {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile)) return false;
          const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
          await this.app.vault.modifyBinary(file, buf as ArrayBuffer, { mtime: mtimeMs });
          return true;
        },
        renameFile: async (from, to, viaTmp) => {
          const file = this.app.vault.getAbstractFileByPath(from);
          if (!(file instanceof TFile)) return false; // not a note in the index → engine uses the adapter
          try {
            await this.app.fileManager.renameFile(file, to);
          } catch {
            // Case-only rename is a "target exists" fold-collision on mobile's case-insensitive
            // volume. Hop through a unique interim name — each step is a non-colliding rename, and
            // fileManager keeps the metadata cache + UI in sync so the new case shows without a reload.
            await this.app.fileManager.renameFile(file, viaTmp);
            await this.app.fileManager.renameFile(file, to);
          }
          return true;
        },
        // Safety net (§4.12): whatever sync is about to replace goes into Obsidian's File recovery
        // store first, so a bad remote overwrite is recoverable in-app even on a device that never
        // pushed those bytes (the journal only has what reached S3).
        onBeforeOverwrite: (path) => this.recoverySnapshot(path),
        // Announce our own revision so peers pull it now rather than at their next tick (§4.14).
        // Wrapped: the delta is already durable, so nothing about announcing it may throw here.
        onPublished: (rev) => {
          try {
            this.notifier?.publish(rev, this.settings.deviceId);
          } catch (err) {
            this.logger.warn(`notify: announce rev ${rev} failed: ${String(err)}`);
          }
        },
        // A cycle applied REMOTE changes — tighten the poll to catch follow-ups (§4.9a). Local
        // edits deliberately do NOT arm this: every cycle pushes the dirty set, so arming it from
        // our own writes made each poll re-push the file being typed, once per ACTIVE interval.
        onRemoteActivity: () => {
          this.lastActivityAt = Date.now();
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
    // Startup (§2.4, §4.4): pull from S3 FIRST so remote changes land in seconds. The offline scan is
    // NOT on the launch path anymore — on desktop it's armed 30 s later (below), on mobile it's manual
    // only — so nothing expensive stands between opening the app and seeing fresh notes / pushing a
    // quick edit. Pulling first is safe regardless: applyRemote re-hashes each local file, so an
    // offline edit that ALSO changed remotely still conflict-merges in the pull; only PURE-local
    // offline edits/deletes (invisible to the pull) wait for the deferred/manual scan.
    if (!this.settings.syncPaused) new Notice("S3 Vault Sync: syncing from cloud…");
    await this.runSync("startup-pull"); // fast: pull remote deltas, announce started/done
    // New device (§4.2a): the pull refused to resolve local↔remote collisions on its own. Ask BEFORE
    // anything else runs — the offline scan would later mark those same files dirty and push the
    // local copy over the cloud one, which is the decision we're trying not to make silently.
    if (this.engine.deferredConflicts().length && (await this.promptForeignState()) === "pause") {
      return; // paused by the answer; resuming from settings restarts polling and syncs
    }
    this.startPolling(); // poll loop live now — the app is responsive without waiting on the scan
    this.rebuildNotifier(); // and subscribe for peers' revisions, if push is configured (§4.14)
    // Offline catch-up (§2.4, §4.4) no longer rides the launch path. On mobile it's off entirely —
    // vault files are practically never edited outside the app, so a routine full-vault scan is pure
    // cost (use the "Scan for external changes" command for the rare exception). On desktop it's armed
    // to run 30 s after launch, off the reconcile lock, so it can't delay fresh pulls or edit pushes.
    if (this.foreignStateDetected) {
      // A copied/restored vault (§4.2) must still reconcile disk against the adopted baselines on ANY
      // platform: the scan's adopted-state guard restores tracked files this copy is missing rather
      // than tombstoning them. Run it now (off-lock, so still non-blocking) instead of deferring.
      void this.runOfflineScan("deferred");
    } else if (!Platform.isMobile) {
      this.scheduleOfflineScan();
    }
  }

  /** Arm the deferred desktop offline scan. Idempotent while pending; a manual scan (or resync)
   * cancels it via clearOfflineScan so the two can't both run. */
  private scheduleOfflineScan(delayMs = OFFLINE_SCAN_DELAY_MS): void {
    if (this.offlineScanTimer !== null) return;
    this.offlineScanTimer = window.setTimeout(() => {
      this.offlineScanTimer = null;
      void this.runOfflineScan("deferred");
    }, delayMs);
  }

  private clearOfflineScan(): void {
    if (this.offlineScanTimer !== null) {
      window.clearTimeout(this.offlineScanTimer);
      this.offlineScanTimer = null;
    }
  }

  /** Run the off-lock offline walk + its locked finalize. Skips when unconfigured or paused, and is
   * single-flighted so the deferred timer and a manual command can't overlap. */
  private async runOfflineScan(reason: "deferred" | "manual"): Promise<void> {
    this.clearOfflineScan(); // a manual run satisfies (and cancels) any pending deferred one
    if (!this.engine) {
      if (reason === "manual") new Notice("S3 Vault Sync: not configured");
      return;
    }
    if (this.settings.syncPaused) {
      if (reason === "manual") new Notice("S3 Vault Sync is paused — resume it in settings to scan.");
      return;
    }
    if (this.offlineScanRunning) return;
    this.offlineScanRunning = true;
    this.logger.info(`offline scan started (${reason})`);
    try {
      await this.engine.scanForOfflineChanges();
      this.logger.info("offline scan finished");
    } catch (err) {
      this.logger.error("offline scan failed", err);
      if (reason === "manual") new Notice(`S3 Vault Sync: scan failed — ${String(err)}`);
    } finally {
      this.offlineScanRunning = false;
    }
    void this.logger.uploadIfDirty();
  }

  /** Flush any debounced edit immediately (used when the app is backgrounded/closed). On mobile a
   * "quick edit then close" can happen well inside the 5 s push debounce; without this the edit — which
   * fires no vault event on the next launch and, with the scan off on mobile, has nothing to recover
   * it — would sit unsynced until a manual sync. Cancels the debounce and pushes now. Best-effort:
   * the OS may suspend before it lands, but the background window is normally enough for a small push. */
  private flushPendingPush(): void {
    if (!this.engine || this.settings.syncPaused) return;
    if (this.pushTimer) {
      window.clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    this.pushFirstEditAt = 0; // this flush covers the burst; the next edit starts a new one
    void this.runSync("background-flush");
  }

  /** Ask which side wins the collisions the first cycle on a new machine declined to resolve, then
   * carry out the answer (§4.2a). Resolves once the follow-up cycle has finished, so the caller can
   * safely start the offline scan afterwards. */
  private async promptForeignState(): Promise<ForeignStateChoice> {
    const engine = this.engine;
    if (!engine) return "merge";
    const paths = engine.deferredConflicts();
    this.logger.info(`new device: ${paths.length} deferred collision(s) — asking the user`);
    const choice = await new Promise<ForeignStateChoice>((resolve) => {
      new ForeignStateModal(this.app, paths, this.settings.deviceId, resolve).open();
    });
    this.logger.info(`new device: user chose "${choice}" for ${paths.length} collision(s)`);
    if (choice === "pause") {
      await this.setSyncPaused(true);
      return choice;
    }
    if (choice === "cloud") await engine.resolveDeferredFromCloud();
    else await engine.resolveDeferredByMerging();
    return choice;
  }

  /** (Re)arm the poll loop. A self-rescheduling timeout rather than a fixed `setInterval`, so every
   * tick re-picks the tier that fits the moment (§4.9a) — a `setInterval` would freeze whichever
   * cadence happened to be current when polling started. Idempotent: the pending tick is always
   * cleared first, so settings changes and resumes can call it freely. */
  startPolling(): void {
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer);
    this.polling = true;
    this.lastPollTick = Date.now();
    this.armPoll();
  }

  private armPoll(): void {
    this.pollIntervalMs = this.pollDelayMs();
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = null;
      const now = Date.now();
      // A tick that is this late means the clock ran on while the WebView didn't: the device was
      // suspended. Its network stack comes back a beat after the JS does, so let it settle rather
      // than spend this cycle on a request that can't leave the device.
      const resumed = now - this.lastPollTick > this.pollIntervalMs * POLL_LATE_FACTOR;
      this.lastPollTick = now;
      if (resumed) this.scheduleResumeSync();
      else void this.runSync("poll");
      this.armPoll(); // re-arm first thing: the cycle above is fire-and-forget and may outlive a tick
    }, this.pollIntervalMs);
  }

  /** The delay this tick should use — tier choice lives in `poll-schedule.ts` (pure, tested). */
  private pollDelayMs(): number {
    return pollDelayMs({
      baseMs: Math.max(5, this.settings.pollIntervalSec) * 1000,
      hidden: document.visibilityState === "hidden",
      msSinceActivity: this.lastActivityAt ? Date.now() - this.lastActivityAt : Infinity,
      pushConnected: this.notifier?.connected() ?? false,
    });
  }

  // ------------------------------------------------- change notifications (§4.14)
  /** (Re)build the notifier from current settings. Torn down and recreated rather than mutated, so
   * changing the endpoint or credentials can't leave a socket signed with the old ones. */
  rebuildNotifier(): void {
    this.notifier?.stop();
    this.notifier = null;
    const s = this.settings;
    // Paused sync has nothing to react to (runSync no-ops), so don't hold a socket open for it.
    if (!s.pushNotifications || !s.iotEndpoint || !this.configured() || s.syncPaused) return;
    this.notifier = new ChangeNotifier(
      {
        endpoint: s.iotEndpoint,
        region: s.region,
        accessKeyId: s.accessKeyId,
        secretAccessKey: s.secretAccessKey,
        deviceId: s.deviceId,
        topic: revTopic(s.prefix),
      },
      {
        // A peer published `rev`. Run the ordinary cycle — it coalesces into the engine's
        // single-flight queue like any other trigger, and re-reads the journal itself, so a
        // notification for a revision we already have costs one LIST and nothing else.
        onRev: (rev, by) => {
          this.logger.info(`notify: rev ${rev} from ${by}`);
          this.lastActivityAt = Date.now();
          void this.runSync("notified");
        },
        log: (level, msg) => this.logger.log(level, msg),
      },
    );
    this.notifier.start();
  }

  /** The user just came back to this device (desktop window focus, or the app returning to the
   * foreground). Desktop app-switching raises `focus` without ever touching `visibilityState`, so
   * the tick alone can leave a just-focused window a full interval stale — sync now instead. A gap
   * long enough to look like a suspend goes through the resume path's grace period instead, since
   * the network is usually not up yet. */
  private onReturnToDevice(): void {
    if (!this.polling) return;
    const now = Date.now();
    if (now - this.lastPollTick < FOCUS_SYNC_MIN_GAP_MS) return;
    const resumed = now - this.lastPollTick > this.pollIntervalMs * POLL_LATE_FACTOR;
    this.lastPollTick = now;
    if (resumed) this.scheduleResumeSync();
    else void this.runSync("focus");
    this.startPolling(); // re-arm: the foreground tier is likely shorter than the pending tick
  }

  /** Arm the one catch-up cycle that follows a resume. Idempotent while pending, so the drift check
   * and the visibilitychange handler firing for the same wake-up produce a single sync. */
  private scheduleResumeSync(): void {
    if (this.resumeTimer !== null) return;
    this.resumeTimer = window.setTimeout(() => {
      this.resumeTimer = null;
      this.lastPollTick = Date.now();
      void this.runSync("poll");
    }, RESUME_GRACE_MS);
  }

  private schedulePush(): void {
    const now = Date.now();
    // NB: deliberately does NOT arm the ACTIVE poll tier (§4.9a) — every cycle pushes the dirty
    // set, so a local edit doing so made each poll re-push the file being typed. Remote arrivals
    // arm it (`onRemoteActivity`); flushing local edits is this debounce's job.
    //
    // Anchor the max-wait on the first edit of this burst, so continuous typing can't keep
    // restarting the debounce forever and strand the whole session unsynced (§4.4).
    if (this.pushFirstEditAt === 0) this.pushFirstEditAt = now;
    if (this.pushTimer) window.clearTimeout(this.pushTimer);
    this.pushTimer = window.setTimeout(() => {
      this.pushTimer = null;
      this.pushFirstEditAt = 0;
      void this.runSync("debounced-edit");
    }, pushDelayMs(now - this.pushFirstEditAt));
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
            ? // force: the user asked for this cycle, so it reports start/finish (and any conflict
              // or queued-behind notice) whether or not verbose mode is on.
              { scanConfig: true, label: "manual sync", announce: true, force: true }
            : reason === "notified"
              ? // A peer announced a revision (§4.14): pull it, but skip the config walk — this is
                // a targeted "catch up now", and the poll still does the periodic scan.
                { label: "notified" }
              : reason === "poll" || reason === "focus"
                ? { scanConfig: true, label: reason === "focus" ? "return to device" : "poll" }
              : reason === "background-flush"
                ? // app backgrounded/closed: push the pending edit, don't scan (§4.4)
                  { label: "background flush" }
                : { label: "edit save" };
    try {
      await this.engine.sync(opts);
      this.syncFailures = 0;
    } catch (err) {
      this.syncFailures += 1;
      // A cycle the user triggered always reports its outcome — silence after "Sync now" reads as
      // "nothing happened". Background cycles stay throttled, and a transient network failure (the
      // usual post-resume one, which the next cycle recovers from) is only worth a WARN and a Notice
      // once it has actually persisted.
      const userInitiated = reason === "manual" || reason.startsWith("startup");
      // An abandoned cycle belongs in the same bucket as a transient network failure: the engine has
      // already logged exactly what stalled, the lock is free again, and the very next cycle picks up
      // the work. Reporting it as a sync FAILURE on every background poll would be noise about
      // something already handled.
      const selfHealing = isTransientNetworkError(err) || err instanceof CycleAbandonedError;
      const quiet = !userInitiated && selfHealing;
      this.logger.log(quiet ? "warn" : "error", `${reason} failed: ${String(err)}`);
      const firstNotice = quiet ? TRANSIENT_QUIET_FAILURES : 1;
      if (userInitiated || this.syncFailures === firstNotice || this.syncFailures % 10 === 0) {
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
      // Credentials, region, prefix and the endpoint all feed the notification socket — rebuild it
      // so a changed setting can't leave a connection signed with the previous one (§4.14).
      this.plugin.rebuildNotifier();
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
      .setDesc(
        "Default 15. One cheap LIST per interval — and a baseline, not a fixed rate: the plugin " +
          "polls every 5 s for two minutes after any change, backs off to a minute while this " +
          "window is in the background, and syncs immediately when you return to it.",
      )
      .addText((t) =>
        t.setValue(String(s.pollIntervalSec)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 5) { s.pollIntervalSec = n; await save(); }
        }));
    new Setting(containerEl)
      .setName("Instant sync (push notifications)")
      .setDesc(
        "Subscribe to an AWS IoT Core topic so changes from other devices arrive in under a " +
          "second instead of at the next poll. Needs the IoT endpoint below and the matching IAM " +
          "permissions. Polling continues either way — a missed notification only costs latency.",
      )
      .addToggle((t) =>
        t.setValue(s.pushNotifications).onChange(async (v) => {
          s.pushNotifications = v;
          await save();
        }));
    new Setting(containerEl)
      .setName("IoT endpoint")
      .setDesc("aws iot describe-endpoint --endpoint-type iot:Data-ATS")
      .addText((t) =>
        t
          .setPlaceholder("xxxxxxxx-ats.iot.<region>.amazonaws.com")
          .setValue(s.iotEndpoint)
          .onChange(async (v) => {
            s.iotEndpoint = v.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
            await save();
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
