import { App, Modal, Setting } from "obsidian";

/** How many colliding paths to name in the dialog before collapsing into "…and N more". */
const PREVIEW_PATHS = 12;

export type ForeignStateChoice = "cloud" | "merge" | "pause";

/**
 * The "new device" prompt (§4.2a).
 *
 * Shown once, when this vault turns up on a machine it has never synced from (fingerprint changed:
 * a restore, an OS reinstall, a copied folder) AND the first pull found files whose local copy
 * differs from the cloud. The engine has deliberately left those files untouched — this dialog is
 * the decision it refused to make silently.
 *
 * The old behavior was to union-merge all of them without asking, which keeps both sides of every
 * changed line. On a vault of recurring tasks that quietly doubles them, and nobody would pick it
 * knowingly — so it is offered here as a named choice rather than imposed as a default. Dismissing
 * the dialog falls back to it, since it is the only lossless option.
 */
export class ForeignStateModal extends Modal {
  private choice: ForeignStateChoice = "merge";

  constructor(
    app: App,
    private paths: string[],
    private deviceId: string,
    private onChoose: (choice: ForeignStateChoice) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(`New device: "${this.deviceId}"`);

    contentEl.createEl("p", {
      text:
        `This vault has not synced from this machine before, and ${this.paths.length} file` +
        `${this.paths.length === 1 ? "" : "s"} here differ from the cloud copy. ` +
        `Nothing has been changed yet — pick which side wins.`,
    });

    const list = contentEl.createEl("ul");
    for (const p of this.paths.slice(0, PREVIEW_PATHS)) list.createEl("li", { text: p });
    if (this.paths.length > PREVIEW_PATHS) {
      list.createEl("li", { text: `…and ${this.paths.length - PREVIEW_PATHS} more` });
    }

    new Setting(contentEl)
      .setName("Use the cloud copy")
      .setDesc(
        "Recommended after a restore, a machine rebuild, or a copied vault folder: the cloud has " +
          "kept syncing and this disk is a snapshot. Local versions of these files are replaced " +
          "(each one is saved to Obsidian's file recovery first).",
      )
      .addButton((b) => b.setButtonText("Use cloud").setCta().onClick(() => this.pick("cloud")));

    new Setting(contentEl)
      .setName("Merge both")
      .setDesc(
        "Keeps every line from both sides. Nothing is lost, but content that moved on in the cloud " +
          "gets duplicated — recurring tasks come back as two open copies.",
      )
      .addButton((b) => b.setButtonText("Merge").onClick(() => this.pick("merge")));

    new Setting(contentEl)
      .setName("Pause sync")
      .setDesc(
        "Stop here and leave both copies alone so you can compare them. Resume from settings; " +
          "this prompt returns on the next start.",
      )
      .addButton((b) => b.setButtonText("Pause").setWarning().onClick(() => this.pick("pause")));

    contentEl.createEl("p", {
      text: "Closing this dialog without choosing merges, the only option that discards nothing.",
      cls: "mod-warning",
    });
  }

  private pick(choice: ForeignStateChoice): void {
    this.choice = choice;
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    this.onChoose(this.choice);
  }
}
