import { App, Modal, Notice, Platform, Setting, TFile, normalizePath } from "obsidian";
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
  /** Diff-by-default: a version list is only useful for finding WHAT changed, and making the user
   * toggle that on for every row (and compare two walls of text by eye) is busywork. */
  private showDiff = true;
  /** cache: versionId → decoded text (or null when binary/oversized) */
  private textCache = new Map<string, string | null>();

  private loadingEl: HTMLElement | null = null;
  /** Phones show ONE pane at a time (list → tap → detail → back); everything else shows both.
   *
   * `Platform.isPhone`, matching the `.is-phone` body class Obsidian keys its OWN modal CSS off, so
   * the two agree by construction. A width heuristic was tried and dropped: `modalEl.clientWidth`
   * is read before the modal is laid out, so it can under-report and take the sidebar away on a
   * desktop that has room for it (§4.12). */
  private readonly phone = Platform.isPhone;
  private sidebarEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private listEl!: HTMLElement;
  private headerEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private buttonsEl!: HTMLElement;

  constructor(app: App, private opts: HistoryModalOptions) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(`Version history — ${this.opts.path}`);
    // ONE markup for both, using Obsidian's own classes throughout. The only structural difference
    // is this class: `.modal.mod-sidebar-layout .modal-content` (3 classes) out-specifies
    // `.is-phone .modal-content` (2), so adding it on a phone would override Obsidian's own mobile
    // rule — a full-width scrolling column — and force the sidebar row onto a screen with no room
    // for it. Leaving it off lets Obsidian lay the phone out the way it lays out its own modals.
    if (!this.phone) this.modalEl.addClass("mod-sidebar-layout");

    this.sidebarEl = this.contentEl.createDiv("modal-sidebar mod-history");
    // `.is-phone .modal-sidebar-inner` drops the border and side-panel background itself, which is
    // why the same markup can serve both without us restyling anything.
    this.listEl = this.sidebarEl.createDiv("modal-sidebar-inner").createDiv("modal-sidebar-list");

    this.detailEl = this.contentEl.createDiv("s3sync-history-detail");
    this.headerEl = this.detailEl.createDiv("s3sync-history-header u-small u-muted");
    this.bodyEl = this.detailEl.createDiv("s3sync-history-body diff-view");
    this.buttonsEl = this.detailEl.createDiv("modal-button-container");
    if (this.phone) this.showPane("list");

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
    // Desktop opens the newest version straight away; mobile stays on the list, so every version is
    // reachable rather than the modal landing inside one of them.
    // Desktop opens the newest version immediately; a phone stays on the list, so every version is
    // reachable rather than the modal landing inside one of them.
    if (!this.phone && this.versions.length > 0) await this.select(0);
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
      // Size AND the delta against the next older version. Two versions seconds apart otherwise
      // render as near-identical timestamps — which is how the 2026-08-23 rollback (1076 B) and the
      // good copy it overwrote (1327 B), 4 s apart, were indistinguishable in this list.
      const older = this.versions[i + 1];
      const delta = older ? v.size - older.size : 0;
      const parts = [formatBytes(v.size)];
      if (delta !== 0) parts.push(`${delta > 0 ? "+" : ""}${delta} B`);
      if (v.isLatest) parts.push("current");
      details.createDiv({ cls: "u-small u-muted", text: parts.join(" · ") });

      item.addEventListener("click", () => void this.select(i));
      if (i === this.selected) item.addClass("is-active");
    });
  }

  private async select(index: number): Promise<void> {
    this.selected = index;
    this.renderList();
    if (this.phone) this.showPane("detail");
    await this.renderContent();
    this.renderButtons();
  }

  /** Phone only: swap between the version list and one version's content. */
  private showPane(which: "list" | "detail"): void {
    // A class toggle, not an inline style: each pane's own `display` stays in styles.css, so the
    // layout can't be half-defined in two places.
    this.sidebarEl.classList.toggle("s3sync-hidden", which !== "list");
    this.detailEl.classList.toggle("s3sync-hidden", which !== "detail");
  }

  /** The version currently live at this key — the diff baseline, and what a restore replaces. */
  private currentVersion(): StoredVersion | undefined {
    return this.versions.find((v) => v.isLatest) ?? this.versions[0];
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

    // Diff against the CURRENT version, not the neighbouring one. The question this list answers is
    // "how does this old version differ from what I have now" — which is also what a restore would
    // do to the file. Diffing against rev-1 answered a different question (what that single revision
    // changed), which is rarely the one being asked and is useless for deciding whether to restore.
    const current = this.currentVersion();
    if (!current || current.versionId === v.versionId) {
      this.headerEl.setText(`${this.headerEl.getText()} · current version`);
      renderPlain(this.bodyEl, text);
      return;
    }
    const currentText = await this.textFor(current);
    if (currentText === null) {
      this.bodyEl.createDiv({
        cls: "u-muted u-small",
        text: "No preview for the current version — can't diff.",
      });
      return;
    }
    this.headerEl.setText(`${this.headerEl.getText()} · changes vs current`);
    // base = current, target = selected: removals are what the current file has and this version
    // does not, additions are what restoring would bring back.
    renderDiff(this.bodyEl, lineDiff(currentText, text));
  }

  private renderButtons(): void {
    this.buttonsEl.empty();
    const v = this.versions[this.selected];
    if (!v) return;

    // Obsidian's own controls on both platforms — `.is-phone .modal-button-container` already makes
    // this row full-width with safe-area padding, and `.is-phone .modal .setting-item` adjusts the
    // Setting rows, so nothing here needs a phone-specific variant.
    if (this.phone) {
      new Setting(this.buttonsEl).addButton((b) =>
        b.setButtonText("← All versions").onClick(() => {
          this.selected = -1;
          this.renderList();
          this.showPane("list");
        }));
    }

    new Setting(this.buttonsEl)
      .addToggle((t) =>
        t.setTooltip("Show changes").setValue(this.showDiff).onChange((val) => {
          this.showDiff = val;
          void this.renderContent();
        }))
      .setName("Show changes")
      .setDesc("Compare this version with the current one instead of showing its full text.");

    new Setting(this.buttonsEl).addButton((b) =>
      b.setButtonText("Restore this version").setCta().onClick(() => void this.restore(v)));
  }

  private async matchesLocal(path: string, body: Uint8Array): Promise<boolean> {
    try {
      if (!(await this.app.vault.adapter.exists(path))) return false;
      const current = new Uint8Array(await this.app.vault.adapter.readBinary(path));
      return bytesEqual(current, body);
    } catch {
      return false; // can't tell → let the restore proceed
    }
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
      // Restoring the version that is already on disk is a no-op, and silently "succeeding" reads
      // as a broken button — which is exactly how it looked when only the current version was
      // reachable on mobile. Say plainly that nothing changed.
      if (await this.matchesLocal(path, body)) {
        new Notice("That version is identical to the current file — nothing changed.");
        this.opts.log("info", `restore of ${path} skipped: ${when} is identical to the local file`);
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

/** True when the local file already holds exactly these bytes. */
async function bytesEqual(a: Uint8Array, b: Uint8Array): Promise<boolean> {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
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
