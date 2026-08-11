/**
 * Agent browser view: the workspace leaf hosting the shared webview.
 *
 * Registered unconditionally (a leaf restored from a saved layout must render)
 * but gated at ENTRY, exactly like BoardView: with `browserEnabled` off, or on
 * mobile, or when the environment has no webview tag, it renders a placeholder
 * and never creates a webview. The view owns the DOM and the BrowserHost; the
 * plugin-level BrowserController owns the lease and drives the host: closing
 * the leaf drops the page, and the next browser_open simply recreates it.
 */
import { ItemView, Platform, WorkspaceLeaf } from "obsidian";
import type ExoPlugin from "../main";
import { BrowserHost } from "../obsidian/browser-host";

/** Workspace-persistent view type: fixed at ship, never renamed. */
export const EXO_BROWSER_VIEW_TYPE = "exo-browser";
export const EXO_BROWSER_ICON = "globe";

export class BrowserView extends ItemView {
  private host: BrowserHost | null = null;
  private bodyEl!: HTMLElement;
  private urlEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ExoPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return EXO_BROWSER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Agent browser";
  }

  getIcon(): string {
    return EXO_BROWSER_ICON;
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("mva-browser");
    const header = root.createDiv({ cls: "mva-browser-header" });
    header.createSpan({ cls: "mva-browser-label", text: "Agent browser" });
    this.urlEl = header.createSpan({ cls: "mva-browser-url", text: "" });
    this.bodyEl = root.createDiv({ cls: "mva-browser-body" });
    this.renderGate();
  }

  /** What an empty leaf shows before any tool call reaches it. */
  private renderGate(): void {
    this.bodyEl.empty();
    if (!this.plugin.settings.browserEnabled) {
      this.bodyEl.createDiv({
        cls: "mva-browser-placeholder",
        text: "The agent browser is disabled. Turn it on in Exo settings (Agent browser) to let the agent open pages here.",
      });
      return;
    }
    if (Platform.isMobile) {
      this.bodyEl.createDiv({
        cls: "mva-browser-placeholder",
        text: "The agent browser is desktop-only: Obsidian mobile has no embedded browser.",
      });
      return;
    }
    this.bodyEl.createDiv({
      cls: "mva-browser-placeholder",
      text: "Waiting for the agent. Ask it to open a page and it appears here.",
    });
    // The webview itself is created lazily by ensureHost() on the first tool
    // call, so a leaf restored from the layout costs nothing until it is used.
  }

  /** The controller's entry point. Null when gated or unsupported. */
  ensureHost(): BrowserHost | null {
    if (!this.plugin.settings.browserEnabled || Platform.isMobile) return null;
    if (this.host?.supported) return this.host;
    this.bodyEl.empty();
    const host = new BrowserHost(this.bodyEl);
    if (!host.attach()) {
      this.bodyEl.createDiv({
        cls: "mva-browser-placeholder",
        text: "This Obsidian build exposes no webview tag: the agent browser cannot run here.",
      });
      return null;
    }
    this.host = host;
    // Hardening off means Electron's default answer to a page's camera/mic/
    // geolocation request is GRANT. That is a weaker posture than the one this
    // feature promises, so the header says it out loud instead of degrading
    // quietly. It is also reported in the tool status line by the controller.
    this.bodyEl.toggleClass("mva-browser-unhardened", !host.hardened);
    if (!host.hardened) {
      this.urlEl.setAttribute(
        "aria-label",
        "Session hardening unavailable (no remote module): web permission prompts fall back to Electron defaults."
      );
    }
    return host;
  }

  /** Whether the leaf's own DOM is currently laid out (a collapsed or
   *  zero-size pane paints nothing, and capturePage would hand back a blank
   *  image rather than fail). */
  get painted(): boolean {
    const r = this.bodyEl?.getBoundingClientRect();
    return !!r && r.width > 1 && r.height > 1;
  }

  setStatus(url: string, title: string): void {
    this.urlEl.setText(url);
    this.urlEl.setAttribute("title", title);
  }

  async onClose(): Promise<void> {
    this.host?.destroy();
    this.host = null;
  }
}
