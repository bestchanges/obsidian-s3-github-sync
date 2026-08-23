import { App, Modal, Notice, Setting, TFile, normalizePath } from "obsidian";
import {
  DiffLine,
  StoredVersion,
  lineDiff,
  readStoredVersionContent,
  readStoredVersions,
} from "@vault-sync/core";
import type { StorageAdapter } from "@vault-sync/core";

/** Bytes above this are shown as a metadata-only row — no preview, no diff (binaries, big attachments). */
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

export interface HistoryModalOptions {
  storage: StorageAdapter;
  path: string;
  log: (level: "info" | "warn" | "error", msg: string) => void;
  /** Snapshot the current local bytes into Obsidian's File recovery store before a restore (§4.12). */
  backupBeforeWrite?: (path: string) => Promise<void>;
  /** Kick a sync cycle after a restore so the new revision publishes promptly. */
  afterRestore?: () => void;
}

/**
 * Per-note version history, read straight from **S3 object versions** (§2.9, §4.12).
 *
 * Obsidian's own "Open version history" belongs to Obsidian Sync and has no plugin-facing API, so
 * this renders our own, using Obsidian's shipped modal/diff classes so it looks native.
 *
 * The source is the bucket's own version list rather than the delta journal. The journal *can*
 * answer this — it records every write — but only by scanning: thousands of GETs per open, ~57 s on
 * a real vault, and all-or-nothing, so in practice history rendered empty. S3 already stores one
 * version per write (versioning is required for merge bases, §8), so one `ListObjectVersions`
 * returns the same list in ~1 s, with the content hash free in the ETag, reaching further back than
 * the journal's retention window.
 *
 * Known limitations, both accepted (§2.9):
 *  - **A rename resets the trail.** S3 has no rename — the new path is a new object — so history
 *    starts fresh there. The pre-rename versions still exist under the old key.
 *  - **Deletes aren't shown.** The protocol tombstones in the journal and never issues DeleteObject,
 *    so there is no delete marker; recovering a deleted file is a separate feature.
 */
export class VersionHistoryModal extends Modal {
  private versions: StoredVersion[] = [];
  private selected = -1;
  private showDiff = false;
  /** cache: versionId → decoded text (or null when binary/oversized) */
  private textCache = new Map<string, string | null>();

  private loadingEl: HTMLElement | null = null;
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

    this.loadingEl = this.listEl.createDiv({ cls: "u-muted u-small", text: "Loading history…" });
    void this.load();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    let versions: StoredVersion[];
    try {
      versions = await readStoredVersions(this.opts.storage, this.opts.path);
    } catch (err) {
      this.opts.log("error", `version history failed for ${this.opts.path}: ${String(err)}`);
      this.loadingEl = null;
      this.listEl.empty();
      // AccessDenied here almost always means the IAM user predates this feature:
      // ListObjectVersions is a separate action from ListBucket (§8).
      const hint = /denied/i.test(String(err))
        ? " — the S3 user may be missing s3:ListBucketVersions (re-run scripts/install/02-create-user.sh)"
        : "";
      this.listEl.createDiv({
        cls: "u-muted u-small",
        text: `Couldn't read history: ${String(err)}${hint}`,
      });
      return;
    }
    this.loadingEl?.remove();
    this.loadingEl = null;
    this.versions = versions;
    this.renderList();
    if (this.versions.length > 0) await this.select(0);
  }

  private renderList(): void {
    this.listEl.empty();
    if (this.versions.length === 0) {
      this.listEl.createDiv({
        cls: "u-muted u-small",
        text: "No stored versions for this file. A renamed file keeps no history from before the rename.",
      });
      return;
    }

    this.versions.forEach((v, i) => {
      const item = this.listEl.createDiv("modal-sidebar-list-item tappable");
      item.setAttr("tabIndex", -1);
      const details = item.createDiv("modal-sidebar-list-item-details");
      details.createDiv({ text: formatWhen(v.at) });
      details.createDiv({
        cls: "u-small u-muted",
        text: v.isLatest ? `${formatBytes(v.size)} · current` : formatBytes(v.size),
      });

      item.addEventListener("click", () => void this.select(i));
      if (i === this.selected) item.addClass("is-active");
    });
  }

  private async select(index: number): Promise<void> {
    this.selected = index;
    this.renderList();
    await this.renderContent();
    this.renderButtons();
  }

  /** Decoded text for a version, or null when it's binary / over the preview cap. */
  private async textFor(v: StoredVersion): Promise<string | null> {
    if (this.textCache.has(v.versionId)) return this.textCache.get(v.versionId) ?? null;
    let text: string | null = null;
    if (v.size <= PREVIEW_MAX_BYTES) {
      const body = await readStoredVersionContent(this.opts.storage, this.opts.path, v.versionId);
      if (body) {
        // A NUL byte in the first block means this isn't text — show metadata, not mojibake.
        const isBinary = body.subarray(0, 8192).includes(0);
        text = isBinary ? null : new TextDecoder("utf-8", { fatal: false }).decode(body);
      }
    }
    this.textCache.set(v.versionId, text);
    return text;
  }

  private async renderContent(): Promise<void> {
    const v = this.versions[this.selected];
    this.bodyEl.empty();
    if (!v) return;

    const parts = [formatWhen(v.at), formatBytes(v.size)];
    if (v.isLatest) parts.push("current");
    this.headerEl.setText(parts.join(" · "));

    this.bodyEl.createDiv({ cls: "u-muted u-small", text: "Loading…" });
    const text = await this.textFor(v);
    this.bodyEl.empty();

    if (text === null) {
      this.bodyEl.createDiv({
        cls: "u-muted",
        text: `No preview (${formatBytes(v.size)} — binary or over the ${formatBytes(PREVIEW_MAX_BYTES)} preview limit). Restore still works.`,
      });
      return;
    }

    if (!this.showDiff) {
      renderPlain(this.bodyEl, text);
      return;
    }

    // Diff against the next older version — what this one actually changed.
    const older = this.versions[this.selected + 1];
    if (!older) {
      this.bodyEl.createDiv({
        cls: "u-muted u-small",
        text: "Oldest stored version — nothing to compare against.",
      });
      renderPlain(this.bodyEl, text);
      return;
    }
    const olderText = await this.textFor(older);
    if (olderText === null) {
      this.bodyEl.createDiv({
        cls: "u-muted u-small",
        text: "No preview for the previous version — can't diff.",
      });
      return;
    }
    this.headerEl.setText(`${this.headerEl.getText()} · changes vs ${formatWhen(older.at)}`);
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
      .setDesc("Compare with the previous version instead of showing the full text.");

    new Setting(this.buttonsEl).addButton((b) =>
      b.setButtonText("Restore this version").setCta().onClick(() => void this.restore(v)));
  }

  /**
   * Write the chosen version back into the vault at the CURRENT path and let the normal push
   * publish it — history stays append-only, nothing in S3 is rewritten. The pre-restore bytes go
   * into Obsidian's File recovery store first, so an unwanted restore is itself undoable in-app.
   */
  private async restore(v: StoredVersion): Promise<void> {
    const path = normalizePath(this.opts.path);
    const when = formatWhen(v.at);
    try {
      const body = await readStoredVersionContent(this.opts.storage, path, v.versionId);
      if (!body) {
        new Notice("S3 Vault Sync: that version is no longer in the bucket.");
        return;
      }
      if (this.opts.backupBeforeWrite) {
        try {
          await this.opts.backupBeforeWrite(path);
        } catch {
          /* best-effort */
        }
      }
      const buf = body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength,
      ) as ArrayBuffer;
      // Through the Vault when the note is in the index, so an open editor follows the restore
      // instead of keeping — and later saving back — the pre-restore buffer (§4.8).
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        await this.app.vault.modifyBinary(existing, buf);
      } else {
        const dir = path.split("/").slice(0, -1).join("/");
        if (dir && !(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
        await this.app.vault.adapter.writeBinary(path, buf);
      }
      this.opts.log("info", `restored ${path} from the version stored ${when}`);
      new Notice(`Restored ${path} from ${when}.`);
      this.opts.afterRestore?.();
      this.close();
    } catch (err) {
      this.opts.log("error", `restore of ${path} from ${when} failed: ${String(err)}`);
      new Notice(`Restore failed: ${String(err)}`);
    }
  }
}

function renderPlain(parent: HTMLElement, text: string): void {
  for (const line of text.split("\n")) {
    parent.createDiv({ cls: "diff-line", text: line === "" ? " " : line });
  }
}

function renderDiff(parent: HTMLElement, lines: DiffLine[]): void {
  let changes = 0;
  for (const l of lines) {
    if (l.type === "common") {
      parent.createDiv({ cls: "diff-line", text: l.text === "" ? " " : l.text });
    } else {
      changes += 1;
      const cls = l.type === "removed" ? "diff-line mod-left" : "diff-line mod-right";
      parent.createDiv({ cls, text: l.text === "" ? " " : l.text });
    }
  }
  if (changes === 0) {
    parent.createDiv({ cls: "u-muted u-small", text: "No textual changes in this version." });
  }
}

/** Local-time, locale-aware stamp. Obsidian's bundled moment is exported as a namespace (not
 * callable under our tsconfig), and Date does the job without the dependency. */
function formatWhen(at: Date): string {
  return Number.isNaN(at.getTime()) ? "unknown" : at.toLocaleString();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
