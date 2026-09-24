import { Modal, type App } from "obsidian";

export interface ConfirmOptions {
  title: string;
  body: string;
  /** Label of the confirming button. */
  cta: string;
}

/** Ask a yes/no question in an Obsidian modal — the plugin-guideline
 *  replacement for `window.confirm()`. Any close other than the confirm
 *  button (Esc, backdrop, Cancel) resolves `false`. */
export function confirmModal(app: App, opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => new ConfirmModal(app, opts, resolve).open());
}

class ConfirmModal extends Modal {
  private confirmed = false;

  constructor(
    app: App,
    private readonly opts: ConfirmOptions,
    private readonly done: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("mva-ie-modal");
    this.titleEl.setText(this.opts.title);
    this.contentEl.createEl("p", { text: this.opts.body });
    const actions = this.contentEl.createDiv({ cls: "mva-ie-actions" });
    actions.createEl("button", { cls: "mva-btn", text: "Cancel" }).onclick = () => this.close();
    actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: this.opts.cta }).onclick = () => {
      this.confirmed = true;
      this.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
    this.done(this.confirmed);
  }
}
