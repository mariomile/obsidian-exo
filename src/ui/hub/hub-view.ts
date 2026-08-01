import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type ExoPlugin from "../../main";
import type { HubTabContext } from "./shared";
import { renderOverviewTab } from "./tab-overview";
import { renderMcpTab } from "./tab-mcp";
import { renderSkillsTab } from "./tab-skills";
import { renderPlaybooksTab } from "./tab-playbooks";
import { renderAutomationsTab } from "./tab-automations";
import { renderMemoryTab } from "./tab-memory";

/** The view-type STRING is workspace-persistent (saved verbatim in
 *  workspace.json) — it stays "exo-connections" forever even though the pane
 *  is now the Capabilities hub. Renaming it would break every saved layout. */
export const HUB_VIEW_TYPE = "exo-connections";
/** Registered via addIcon() in main.ts (Huge Icons puzzle-piece). */
export const HUB_ICON = "hi-puzzle";

export type HubTab = "overview" | "skills" | "mcp" | "playbooks" | "automations" | "memory";

interface TabDef {
  id: HubTab;
  label: string;
  render: (host: HTMLElement, ctx: HubTabContext) => Promise<void>;
}

const TABS: TabDef[] = [
  { id: "overview", label: "Overview", render: renderOverviewTab },
  { id: "skills", label: "Skills", render: renderSkillsTab },
  { id: "mcp", label: "MCP", render: renderMcpTab },
  { id: "playbooks", label: "Playbooks", render: renderPlaybooksTab },
  { id: "automations", label: "Automations", render: renderAutomationsTab },
  { id: "memory", label: "Memory", render: renderMemoryTab },
];

/**
 * The Capabilities hub — one pane for everything the agent can do and the
 * machinery around it. Tabs are self-contained renderers (see ./tab-*.ts);
 * this shell owns navigation, refresh, and the shared HubTabContext.
 */
export class HubView extends ItemView {
  private tab: HubTab = "overview";
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
  getDisplayText(): string { return "Capabilities"; }
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
    // The pane outlives what it reports on: the 30-min scheduler moves
    // scheduledLastRun, sessions connect and drop MCP servers. Re-render when
    // the leaf comes back into focus so a long-open hub is never stale.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf === this.leaf) void this.render();
      })
    );
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
