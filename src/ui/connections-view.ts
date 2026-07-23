import { ItemView, WorkspaceLeaf } from "obsidian";
import type ExoPlugin from "../main";

export const CONNECTIONS_VIEW_TYPE = "exo-connections";
export const CONNECTIONS_ICON = "blocks";

type Tab = "mcp" | "skills";

/**
 * The Connections pane — a two-tab (MCP / Skills) marketplace over what other
 * tools already have on the system. Shows Exo's active capabilities and, for
 * anything importable (Codex MCP, other-project + Codex-exclusive skills),
 * offers a one-tap connect that never creates a duplicate. Mirrors board-view's
 * ItemView registration; data wiring lands in the next step.
 */
export class ConnectionsView extends ItemView {
  private tab: Tab = "mcp";
  private listEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ExoPlugin) {
    super(leaf);
  }

  getViewType(): string { return CONNECTIONS_VIEW_TYPE; }
  getDisplayText(): string { return "Connections"; }
  getIcon(): string { return CONNECTIONS_ICON; }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("mva-root");
    root.addClass("mva-connections-root");

    const tabs = root.createDiv({ cls: "mva-conn-tabs" });
    const mkTab = (id: Tab, label: string) => {
      const b = tabs.createEl("button", { cls: "mva-pill", text: label });
      if (this.tab === id) b.addClass("is-active");
      b.onclick = () => { this.tab = id; void this.render(); };
      return b;
    };
    mkTab("mcp", "MCP");
    mkTab("skills", "Skills");

    this.listEl = root.createDiv({ cls: "mva-conn-list" });
    await this.render();
  }

  private async render(): Promise<void> {
    if (!this.listEl) return;
    const pills = this.contentEl.querySelectorAll(".mva-conn-tabs .mva-pill");
    pills.forEach((p, i) => p.toggleClass("is-active", (i === 0) === (this.tab === "mcp")));
    this.listEl.empty();
    this.listEl.createDiv({ cls: "mva-conn-empty", text: "Loading…" });
  }
}
