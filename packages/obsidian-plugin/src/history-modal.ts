import { App, Modal, Notice, Setting, TFile, normalizePath } from "obsidian";
import {
  DiffLine,
  FileVersion,
  HistoryResult,
  lineDiff,
  readFileHistory,
  readVersionContent,
} from "@vault-sync/core";
import type { StorageAdapter } from "@vault-sync/core";

/** Bytes above this are shown as a metadata-only row — no preview, no diff (binaries, big attachments). */
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

export interface HistoryModalOptions {
  storage: StorageAdapter;
  path: string;
  /** this device's id, so its own revisions are labelled "this device" */
  deviceId: string;
  concurrency: number;
  log: (level: "info" | "warn" | "error", msg: string) => void;
  /** Snapshot the current local bytes into Obsidian's File recovery store before a restore (§4.12). */
  backupBeforeWrite?: (path: string) => Promise<void>;
  /** Kick a sync cycle after a restore so the new revision publishes promptly. */
  afterRestore?: () => void;
}

/**
 * Per-note version history, read off the delta journal (§4.12).
 *
 * Obsidian's own "Open version history" belongs to Obsidian Sync and has no plugin-facing API, so
 * this renders our own — using Obsidian's shipped modal/diff classes so it looks native. The journal
 * is a richer source than Sync's: every row carries the revision AND the device that wrote it.
 */
export class VersionHistoryModal extends Modal {
  private versions: FileVersion[] = [];
  private truncated = false;
  private oldestRev = 0;
  private selected = -1;
  private showDiff = false;
  /** cache: rev → decoded text (or null when binary/oversized/deleted) */
  private textCache = new Map<number, string | null>();

  private listEl!: HTMLElement;
  private headerEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private buttonsEl!: HTMLElement;

  constructor(app: App, private opts: HistoryModalOptions) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("mod-sidebar-layout");
    this.titleEl.setText(`Version history — ${this.opts.path}`);

    const sidebar = this.contentEl.createDiv("modal-sidebar mod-history");
    this.listEl = sidebar.createDiv("modal-sidebar-inner").createDiv("modal-sidebar-list");

    const container = this.contentEl.createDiv("sync-history-content-container");
    const content = container.createDiv("sync-history-content");
    this.headerEl = content.createDiv("u-small u-muted");
    this.headerEl.style.padding = "var(--size-4-3) var(--size-4-4)";
    this.bodyEl = content.createDiv("sync-history-preview diff-view");
    this.buttonsEl = container.createDiv("modal-button-container");

    this.listEl.createDiv({ cls: "u-muted u-small", text: "Loading history…" });
    void this.load();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    let result: HistoryResult;
    try {
      result = await readFileHistory(this.opts.storage, this.opts.path, this.opts.concurrency);
    } catch (err) {
      this.opts.log("error", `version history failed for ${this.opts.path}: ${String(err)}`);
      this.listEl.empty();
      this.listEl.createDiv({ cls: "u-muted u-small", text: `Couldn't read history: ${String(err)}` });
      return;
    }
    this.versions = result.versions;
    this.truncated = result.truncated;
    this.oldestRev = result.oldestRevAvailable;
    this.renderList();
    if (this.versions.length > 0) await this.select(0);
  }

  private renderList(): void {
    this.listEl.empty();
    if (this.versions.length === 0) {
      this.listEl.createDiv({
        cls: "u-muted u-small",
        text: "No revisions for this file in the journal.",
      });
      return;
    }

    this.versions.forEach((v, i) => {
      const item = this.listEl.createDiv("modal-sidebar-list-item tappable");
      item.setAttr("tabIndex", -1);
      const details = item.createDiv("modal-sidebar-list-item-details");
      details.createDiv({ text: v.at ? formatWhen(v.at) : `rev ${v.rev}` });

      const who = v.by === this.opts.deviceId ? `${v.by} (this device)` : v.by;
      const what = v.deleted
        ? v.renamedTo
          ? `renamed → ${v.renamedTo}`
          : "deleted"
        : formatBytes(v.size ?? 0);
      details.createDiv({ cls: "u-small u-muted", text: `rev ${v.rev} · ${who} · ${what}` });

      item.addEventListener("click", () => void this.select(i));
      if (i === this.selected) item.addClass("is-active");
    });

    if (this.truncated) {
      this.listEl.createDiv({
        cls: "u-muted u-small",
        text: `Journal pruned below rev ${this.oldestRev} — older revisions are no longer available.`,
      });
    }
  }

  private async select(index: number): Promise<void> {
    this.selected = index;
    this.renderList();
    await this.renderContent();
    this.renderButtons();
  }

  /** Decoded text for a version, or null when it's a tombstone / binary / over the preview cap. */
  private async textFor(v: FileVersion): Promise<string | null> {
    if (this.textCache.has(v.rev)) return this.textCache.get(v.rev) ?? null;
    let text: string | null = null;
    if (!v.deleted && (v.size ?? 0) <= PREVIEW_MAX_BYTES) {
      const obj = await readVersionContent(this.opts.storage, v);
      if (obj) {
        // A NUL byte in the first block means this isn't text — show metadata, not mojibake.
        const isBinary = obj.body.subarray(0, 8192).includes(0);
        text = isBinary ? null : new TextDecoder("utf-8", { fatal: false }).decode(obj.body);
      }
    }
    this.textCache.set(v.rev, text);
    return text;
  }

  private async renderContent(): Promise<void> {
    const v = this.versions[this.selected];
    this.bodyEl.empty();
    if (!v) return;

    const who = v.by === this.opts.deviceId ? `${v.by} (this device)` : v.by;
    const parts = [`rev ${v.rev}`, who, v.at ? formatWhen(v.at) : ""];
    if (v.path !== this.opts.path) parts.push(`stored as ${v.path}`);
    if (v.mtime) parts.push(`edited ${formatWhen(v.mtime)}`);
    this.headerEl.setText(parts.filter(Boolean).join(" · "));

    if (v.deleted) {
      this.bodyEl.createDiv({
        cls: "u-muted",
        text: v.renamedTo
          ? `Renamed to ${v.renamedTo} at this revision.`
          : "Deleted at this revision.",
      });
      return;
    }

    this.bodyEl.createDiv({ cls: "u-muted u-small", text: "Loading…" });
    const text = await this.textFor(v);
    this.bodyEl.empty();

    if (text === null) {
      this.bodyEl.createDiv({
        cls: "u-muted",
        text: `No preview (${formatBytes(v.size ?? 0)} — binary or over the ${formatBytes(PREVIEW_MAX_BYTES)} preview limit). Restore still works.`,
      });
      return;
    }

    if (!this.showDiff) {
      renderPlain(this.bodyEl, text);
      return;
    }

    // Diff against the next OLDER live revision — what this revision actually changed.
    const older = this.versions.slice(this.selected + 1).find((x) => !x.deleted);
    if (!older) {
      this.bodyEl.createDiv({ cls: "u-muted u-small", text: "First revision — nothing to compare against." });
      renderPlain(this.bodyEl, text);
      return;
    }
    const olderText = await this.textFor(older);
    if (olderText === null) {
      this.bodyEl.createDiv({ cls: "u-muted u-small", text: `No preview for rev ${older.rev} — can't diff.` });
      return;
    }
    this.headerEl.setText(`${this.headerEl.getText()} · changes vs rev ${older.rev}`);
    renderDiff(this.bodyEl, lineDiff(olderText, text));
  }

  private renderButtons(): void {
    this.buttonsEl.empty();
    const v = this.versions[this.selected];
    if (!v) return;

    new Setting(this.buttonsEl)
      .addToggle((t) =>
        t.setTooltip("Show changes").setValue(this.showDiff).onChange((val) => {
          this.showDiff = val;
          void this.renderContent();
        }))
      .setName("Show changes")
      .setDesc("Compare with the previous revision instead of showing the full text.");

    if (v.deleted) {
      new Setting(this.buttonsEl).addButton((b) =>
        b
          .setButtonText("Restore the previous revision")
          .setCta()
          .onClick(() => {
            const prior = this.versions.slice(this.selected + 1).find((x) => !x.deleted);
            if (!prior) {
              new Notice("Nothing to restore — no live revision before this delete.");
              return;
            }
            void this.restore(prior);
          }));
      return;
    }

    new Setting(this.buttonsEl).addButton((b) =>
      b.setButtonText("Restore this version").setCta().onClick(() => void this.restore(v)));
  }

  /**
   * Write the chosen revision back into the vault at the CURRENT path and let the normal push
   * publish it as a new revision — history stays append-only, nothing is rewritten in S3. The
   * pre-restore bytes go into Obsidian's File recovery store first, so an unwanted restore is itself
   * undoable in-app.
   */
  private async restore(v: FileVersion): Promise<void> {
    const path = normalizePath(this.opts.path);
    try {
      const obj = await readVersionContent(this.opts.storage, v);
      if (!obj) {
        new Notice(`S3 Vault Sync: revision ${v.rev} is no longer in the bucket.`);
        return;
      }
      if (this.opts.backupBeforeWrite) {
        try {
          await this.opts.backupBeforeWrite(path);
        } catch {
          /* best-effort */
        }
      }
      const body = obj.body.buffer.slice(
        obj.body.byteOffset,
        obj.body.byteOffset + obj.body.byteLength,
      ) as ArrayBuffer;
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile || (await this.app.vault.adapter.exists(path))) {
        await this.app.vault.adapter.writeBinary(path, body);
      } else {
        const dir = path.split("/").slice(0, -1).join("/");
        if (dir && !(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
        await this.app.vault.adapter.writeBinary(path, body);
      }
      this.opts.log("info", `restored ${path} from rev ${v.rev} (by ${v.by})`);
      new Notice(`Restored ${path} from rev ${v.rev}.`);
      this.opts.afterRestore?.();
      this.close();
    } catch (err) {
      this.opts.log("error", `restore of ${path} from rev ${v.rev} failed: ${String(err)}`);
      new Notice(`Restore failed: ${String(err)}`);
    }
  }
}

function renderPlain(parent: HTMLElement, text: string): void {
  for (const line of text.split("\n")) {
    parent.createDiv({ cls: "diff-line", text: line === "" ? " " : line });
  }
}

function renderDiff(parent: HTMLElement, lines: DiffLine[]): void {
  let changes = 0;
  for (const l of lines) {
    if (l.type === "common") {
      parent.createDiv({ cls: "diff-line", text: l.text === "" ? " " : l.text });
    } else {
      changes += 1;
      const cls = l.type === "removed" ? "diff-line mod-left" : "diff-line mod-right";
      parent.createDiv({ cls, text: l.text === "" ? " " : l.text });
    }
  }
  if (changes === 0) {
    parent.createDiv({ cls: "u-muted u-small", text: "No textual changes in this revision." });
  }
}

/** Local-time, locale-aware stamp for a journal timestamp. Obsidian's bundled moment is exported as
 * a namespace (not callable under our tsconfig), and Date does the job without the dependency. */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
