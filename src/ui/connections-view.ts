import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { homedir } from "os";
import { readFile } from "fs/promises";
import type ExoPlugin from "../main";
import {
  scanCodexMcp,
  scanClaudeGlobalMcp,
  assignMcpState,
  scanSkillDirs,
  assignSkillState,
  type ClaudeJson,
  type DiscoveryItem,
} from "../core/connections-scan";
import { connectMcp, importSkill, removeSkill } from "../core/connections-install";
import { parseMcpJson } from "../core/mcp-config";
import {
  gatherFromScopes,
  gatherFromVault,
  gatherOtherProjectSkills,
  gatherCodexSkills,
} from "./capabilities";
import { reconcileList, type CardModel } from "./keyed-reconcile";

export const CONNECTIONS_VIEW_TYPE = "exo-connections";
/** Registered via addIcon() in main.ts (Huge Icons puzzle-piece — matches
 *  the "marketplace of capabilities" concept better than a generic grid). */
export const CONNECTIONS_ICON = "hi-puzzle";

type Tab = "mcp" | "skills";

/**
 * The Connections pane — a two-tab (MCP / Skills) marketplace over what other
 * tools already have on the system. Shows Exo's active capabilities and, for
 * anything importable (Codex MCP, other-project + Codex-exclusive skills),
 * offers a one-tap connect that never creates a duplicate.
 *
 * v1 action model: importable → connect/import; active MCP → status only
 * (removal lives in the Settings MCP manager, which owns the inherited-vs-ours
 * distinction); active skill (in the vault) → remove (unambiguous vault copy).
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
      b.toggleClass("is-active", this.tab === id);
      b.onclick = () => { this.tab = id; void this.render(); };
    };
    mkTab("mcp", "MCP");
    mkTab("skills", "Skills");
    const refresh = tabs.createEl("button", { cls: "mva-icon-btn mva-conn-refresh", text: "↻", attr: { "aria-label": "Refresh" } });
    refresh.onclick = () => void this.render();

    this.listEl = root.createDiv({ cls: "mva-conn-list" });
    await this.render();
  }

  private base(): string {
    return (this.app.vault.adapter as unknown as { getBasePath?(): string }).getBasePath?.() ?? "";
  }

  /** Read every source, normalize, and diff against what Exo already has. */
  private async gatherConnections(): Promise<{ mcp: DiscoveryItem[]; skills: DiscoveryItem[] }> {
    const home = homedir();
    const caps = this.plugin.lastSessionCaps;

    // ---- MCP ----
    let claudeJson: ClaudeJson = {};
    try { claudeJson = JSON.parse(await readFile(`${home}/.claude.json`, "utf8")) as ClaudeJson; } catch { /* absent */ }
    let codexToml = "";
    try { codexToml = await readFile(`${home}/.codex/config.toml`, "utf8"); } catch { /* absent */ }

    const mcpItems = [...scanCodexMcp(codexToml), ...scanClaudeGlobalMcp(claudeJson)];
    // Active = live session servers UNION the ones we've already written into the
    // vault's .mcp.json (enabled). Without the .mcp.json half, a just-connected
    // server keeps showing "Connetti" until the next session — looks like a no-op.
    let ourServers: string[] = [];
    try {
      const parsed = parseMcpJson(await this.app.vault.adapter.read(".mcp.json"));
      if (!parsed.error) ourServers = parsed.servers.filter((s) => s.enabled).map((s) => s.name);
    } catch { /* no .mcp.json yet */ }
    const activeNames = new Set<string>([...(caps?.mcpServers ?? []).map((m) => m.name), ...ourServers]);
    const inheritedNames = new Set<string>(Object.keys(claudeJson.mcpServers ?? {}));
    const mcp = assignMcpState(mcpItems, { activeNames, inheritedNames }).map((it) => ({
      ...it,
      status: caps?.mcpServers?.find((m) => m.name === it.name)?.status,
    }));

    // ---- Skills (sources: other projects + Codex-native) ----
    const projectRoots = [`${home}/Dev Projects`, `${home}/Projects`];
    const dirs = [...await gatherOtherProjectSkills(projectRoots), await gatherCodexSkills()];
    const skillItems = scanSkillDirs(dirs);
    // "Already have" = the live session's loaded skills UNION the on-disk global
    // catalog. Union, not `??`: caps is authoritative when present but null
    // pre-init and on Codex; the disk scan (now symlink-aware) covers that gap
    // so a skill Exo already has is never offered as importable.
    const haveNames = new Set<string>([
      ...(caps?.skills ?? []),
      ...(await gatherFromScopes("skills")).map((s) => s.name),
    ]);
    const vaultNames = new Set<string>((await gatherFromVault(this.app, "skills")).map((s) => s.name));
    const skills = assignSkillState(skillItems, haveNames, vaultNames);

    return { mcp, skills };
  }

  private async render(): Promise<void> {
    if (!this.listEl) return;
    const pills = this.contentEl.querySelectorAll(".mva-conn-tabs .mva-pill");
    pills.forEach((p, i) => p.toggleClass("is-active", (i === 0) === (this.tab === "mcp")));

    const { mcp, skills } = await this.gatherConnections();
    const items = this.tab === "mcp" ? mcp : skills;

    if (!items.length) {
      this.listEl.empty();
      this.listEl.createDiv({ cls: "mva-conn-empty", text: this.tab === "mcp"
        ? "Tutto allineato — nessun MCP importabile da Codex."
        : "Nessuna skill esterna da importare." });
      return;
    }

    const models: CardModel[] = items.map((it) => ({
      key: `${it.kind}:${it.name}`,
      sig: `${it.state}:${it.status ?? ""}`,
      build: () => this.buildRow(it),
    }));
    reconcileList(this.listEl, models);
  }

  private buildRow(it: DiscoveryItem): HTMLElement {
    const row = createDiv({ cls: "mva-conn-row" });
    row.toggleClass("is-muted", it.state === "have");
    row.createSpan({ cls: "mva-conn-name", text: it.name });
    row.createSpan({ cls: "mva-conn-origin", text: it.origin });
    if (it.desc) row.createSpan({ cls: "mva-conn-desc", text: it.desc });

    const right = row.createDiv({ cls: "mva-conn-actions" });
    if (it.state === "active") {
      if (it.kind === "mcp") {
        const dot = right.createSpan({ cls: "mva-conn-dot" });
        dot.toggleClass("is-connected", it.status === "connected");
        right.createSpan({ cls: "mva-conn-state", text: "attivo" });
      } else {
        right.createSpan({ cls: "mva-conn-state", text: "nel vault" });
        const btn = right.createEl("button", { cls: "mva-btn", text: "Rimuovi" });
        btn.onclick = () => void this.doRemoveSkill(it, btn);
      }
    } else if (it.state === "have") {
      right.createSpan({ cls: "mva-conn-state is-muted", text: "già in Exo" });
    } else {
      const btn = right.createEl("button", { cls: "mva-btn", text: it.kind === "mcp" ? "Connetti" : "Importa" });
      btn.onclick = () => void this.doImport(it, btn);
    }
    return row;
  }

  private async doImport(it: DiscoveryItem, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      if (it.kind === "mcp") {
        const path = ".mcp.json";
        const adapter = this.app.vault.adapter;
        let raw = '{\n  "mcpServers": {}\n}';
        try { raw = await adapter.read(path); } catch { /* create fresh */ }
        await adapter.write(path, connectMcp(raw, it.name, it.config ?? {}));
        new Notice(`MCP "${it.name}" connesso — attivo alla prossima sessione.`);
      } else {
        const dest = `${this.base()}/.claude/skills/${it.name}`;
        const res = await importSkill(it.path!, dest);
        if (res === "exists") {
          if (!confirm(`Una skill "${it.name}" esiste già nel vault. Sovrascrivere?`)) { btn.disabled = false; return; }
          await importSkill(it.path!, dest, { overwrite: true });
        }
        new Notice(`Skill "${it.name}" importata nel vault.`);
      }
      await this.render();
    } catch (e) {
      new Notice(`Import fallito: ${e instanceof Error ? e.message : String(e)}`);
      btn.disabled = false;
    }
  }

  private async doRemoveSkill(it: DiscoveryItem, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      await removeSkill(`${this.base()}/.claude/skills/${it.name}`);
      new Notice(`Skill "${it.name}" rimossa dal vault.`);
      await this.render();
    } catch (e) {
      new Notice(`Rimozione fallita: ${e instanceof Error ? e.message : String(e)}`);
      btn.disabled = false;
    }
  }
}
