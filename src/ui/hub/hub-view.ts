import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type ExoPlugin from "../../main";
import type { HubTabContext } from "./shared";
import { renderMcpTab } from "./tab-mcp";
import { renderSkillsTab } from "./tab-skills";
import { renderAutomationsTab } from "./tab-automations";

/** The view-type STRING is workspace-persistent (saved verbatim in
 *  workspace.json) — it stays "exo-connections" forever even though the pane
 *  is now the Capabilities hub. Renaming it would break every saved layout. */
export const HUB_VIEW_TYPE = "exo-connections";
/** Registered via addIcon() in main.ts (Huge Icons puzzle-piece). */
export const HUB_ICON = "hi-puzzle";

export type HubTab = "mcp" | "skills" | "automations";

interface TabDef {
  id: HubTab;
  label: string;
  render: (host: HTMLElement, ctx: HubTabContext) => Promise<void>;
}

const TABS: TabDef[] = [
  { id: "mcp", label: "MCP", render: renderMcpTab },
  { id: "skills", label: "Skills", render: renderSkillsTab },
  { id: "automations", label: "Automations", render: renderAutomationsTab },
];

/**
 * The Capabilities hub — one pane for everything the agent can do and the
 * machinery around it. Tabs are self-contained renderers (see ./tab-*.ts);
 * this shell owns navigation, refresh, and the shared HubTabContext.
 */
export class HubView extends ItemView {
  private tab: HubTab = "mcp";
  private listEl: HTMLElement | null = null;
  /** Last tab actually painted — a tab SWITCH empties the host first (tabs mix
   *  keyed-reconcile and full-render strategies; stale unkeyed children from
   *  another tab must not survive), while a same-tab refresh keeps the DOM for
   *  reconcileList to diff. */
  private renderedTab: HubTab | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ExoPlugin) {
    super(leaf);
  }

  getViewType(): string { return HUB_VIEW_TYPE; }
  getDisplayText(): string { return "Connections"; }
  getIcon(): string { return HUB_ICON; }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("mva-root");
    root.addClass("mva-connections-root");

    const tabs = root.createDiv({ cls: "mva-conn-tabs" });
    for (const def of TABS) {
      const b = tabs.createEl("button", { cls: "mva-pill", text: def.label, attr: { "data-tab": def.id } });
      b.toggleClass("is-active", this.tab === def.id);
      b.onclick = () => this.showTab(def.id);
    }
    const refresh = tabs.createEl("button", { cls: "mva-icon-btn mva-conn-refresh", attr: { "aria-label": "Refresh" } });
    setIcon(refresh, "refresh-cw");
    refresh.onclick = () => void this.render();

    this.listEl = root.createDiv({ cls: "mva-conn-list" });
    await this.render();
  }

  /** Switch to a tab (also the deep-link entry point via activateHub). */
  showTab(tab: HubTab): void {
    this.tab = tab;
    void this.render();
  }

  /** Re-render the current tab — called on manual refresh, after tab actions,
   *  and by the plugin when a new SessionCaps snapshot arrives. */
  refresh(): void {
    void this.render();
  }

  private base(): string {
    return (this.app.vault.adapter as unknown as { getBasePath?(): string }).getBasePath?.() ?? "";
  }

  private ctx(): HubTabContext {
    return {
      app: this.app,
      plugin: this.plugin,
      rerender: () => void this.render(),
      base: () => this.base(),
    };
  }

  private async render(): Promise<void> {
    if (!this.listEl) return;
    this.contentEl.querySelectorAll<HTMLElement>(".mva-conn-tabs .mva-pill").forEach((p) =>
      p.toggleClass("is-active", p.getAttr("data-tab") === this.tab)
    );
    if (this.renderedTab !== this.tab) {
      this.listEl.empty();
      this.renderedTab = this.tab;
    }
    const def = TABS.find((t) => t.id === this.tab) ?? TABS[0];
    await def.render(this.listEl, this.ctx());
  }
}
