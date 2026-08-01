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
  scanLiveCaps,
  type ClaudeJson,
  type DiscoveryItem,
} from "../core/connections-scan";
import { connectMcp, disconnectMcp, setMcpEnabled, importSkill, removeSkill } from "../core/connections-install";
import { parseMcpJson, summarizeServer } from "../core/mcp-config";
import { resolveCli, mcpLogin } from "../cli";
import { McpServerModal } from "./mcp-server-modal";
import {
  gatherFromScopes,
  gatherFromVault,
  gatherOtherProjectSkills,
  gatherCodexSkills,
} from "../core/capability-scan";
import { reconcileList, type CardModel } from "./keyed-reconcile";

export const CONNECTIONS_VIEW_TYPE = "exo-connections";
/** Registered via addIcon() in main.ts (Huge Icons puzzle-piece — matches
 *  the "marketplace of capabilities" concept better than a generic grid). */
export const CONNECTIONS_ICON = "hi-puzzle";

type Tab = "mcp" | "skills";

const byOriginThenName = (a: DiscoveryItem, b: DiscoveryItem): number =>
  a.origin.localeCompare(b.origin) || a.name.localeCompare(b.name);

/**
 * The Connections pane — a two-tab (MCP / Skills) control surface AND marketplace
 * over what other tools already have on the system. It's the single place to
 * manage MCP: add a server, edit/enable/disable/remove vault-owned ones,
 * reconnect a failed one, re-authenticate one that needs OAuth, and one-tap
 * import servers other tools already have (never creating a duplicate).
 *
 * Action model by row:
 *  - vault-owned MCP → Edit · Enable/Disable · Remove (+ Reconnect/Re-auth on failure)
 *  - inherited / live-only MCP (global, connectors, plugins) → Reconnect (failed)
 *    or Re-auth (needs-auth); config is managed at its own source, so no edit
 *  - importable MCP (Codex) → Connect
 *  - skills: active (in vault) → Remove; importable → Import; have → shown muted
 *
 * Reconnect respawns the active Exo session (which resumes, so the conversation
 * survives) to re-attempt connections and pick up new OAuth creds / .mcp.json
 * edits. Re-auth shells out to `claude mcp login <name>` (browser OAuth), then
 * reconnects.
 */
export class ConnectionsView extends ItemView {
  private tab: Tab = "mcp";
  private listEl: HTMLElement | null = null;
  /** Names of MCP servers that live in the vault's own .mcp.json (ours to
   *  remove, vs inherited/live-only servers which the Settings manager owns). */
  private ourMcp = new Set<string>();

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

    const liveStatus = new Map<string, string>((caps?.mcpServers ?? []).map((m) => [m.name, m.status]));

    // Vault-owned servers (.mcp.json) — both enabled and disabled, each carrying
    // its config so the row can Edit / Enable / Disable / Remove it. These are the
    // servers WE manage; everything else is read-only-config (source manages it).
    let vaultServers: { name: string; config: Record<string, unknown>; enabled: boolean }[] = [];
    try {
      const parsed = parseMcpJson(await this.app.vault.adapter.read(".mcp.json"));
      if (!parsed.error) vaultServers = parsed.servers;
    } catch { /* no .mcp.json yet */ }
    this.ourMcp = new Set(vaultServers.map((s) => s.name));
    const vaultItems: DiscoveryItem[] = vaultServers.map((s) => ({
      kind: "mcp",
      name: s.name,
      source: "vault",
      origin: "vault",
      state: "active",
      config: s.config,
      desc: summarizeServer(s.config),
      // Disabled servers report "disabled" (no live connection); enabled ones take
      // the live status, or "unknown" before the session finishes connecting.
      status: s.enabled ? liveStatus.get(s.name) ?? "unknown" : "disabled",
    }));

    // Importable / inherited servers from OTHER tools, minus anything already in
    // the vault (dedup — a vault server is never also offered to import).
    const external = [...scanCodexMcp(codexToml), ...scanClaudeGlobalMcp(claudeJson)].filter(
      (it) => !this.ourMcp.has(it.name)
    );
    const activeNames = new Set<string>([
      ...(caps?.mcpServers ?? []).map((m) => m.name),
      ...vaultServers.filter((s) => s.enabled).map((s) => s.name),
    ]);
    const inheritedNames = new Set<string>(Object.keys(claudeJson.mcpServers ?? {}));
    const mcpFromConfig = assignMcpState(external, { activeNames, inheritedNames }).map((it) => ({
      ...it,
      status: liveStatus.get(it.name),
    }));
    // Everything the live session loaded that ISN'T in a local config file:
    // claude.ai account connectors + plugin servers. Read-only — shown so the
    // pane reflects ALL connected MCPs, not just the file-backed ones.
    const covered = new Set([...this.ourMcp, ...mcpFromConfig.map((i) => i.name)]);
    const live = scanLiveCaps(caps?.mcpServers ?? [], covered);
    const mcp = [...vaultItems, ...mcpFromConfig, ...live];

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

    if (this.tab === "mcp") {
      const connected = mcp.filter((i) => i.state === "active" && i.status !== "disabled").sort(byOriginThenName);
      const disabled = mcp.filter((i) => i.state === "active" && i.status === "disabled").sort(byOriginThenName);
      const importable = mcp.filter((i) => i.state === "importable").sort(byOriginThenName);
      const have = mcp.filter((i) => i.state === "have").sort(byOriginThenName);
      const models: CardModel[] = [];
      // Always-present "Add MCP server" action — the control-surface entry point.
      models.push({ key: "add-mcp", sig: "add", build: () => this.buildAddMcp() });
      if (!mcp.length) {
        models.push({ key: "mcp-empty", sig: "empty", build: () => createDiv({ cls: "mva-conn-empty", text: "No MCP servers yet — add one above." }) });
      }
      const section = (label: string, items: DiscoveryItem[]) => {
        if (!items.length) return;
        models.push({ key: `sec:${label}`, sig: `${items.length}`, build: () => this.buildGroupHeader(label, items.length) });
        for (const it of items) models.push({
          key: `mcp:${it.name}`,
          sig: `${it.state}:${it.status ?? ""}:${this.ourMcp.has(it.name)}:${it.desc ?? ""}`,
          build: () => this.buildRow(it),
        });
      };
      section("Connected", connected);
      section("Disabled", disabled);
      section("Importable", importable);
      section("Inherited", have);
      reconcileList(this.listEl, models);
      return;
    }

    // Skills tab: active (vault) first, then importable grouped by origin, then a
    // single collapsed count for the hundreds already available (not 281 rows).
    const vault = skills.filter((s) => s.state === "active");
    const importable = skills.filter((s) => s.state === "importable");
    const haveCount = skills.filter((s) => s.state === "have").length;

    if (!vault.length && !importable.length) {
      this.listEl.empty();
      this.listEl.createDiv({ cls: "mva-conn-empty", text: haveCount
        ? `No external skills to import — ${haveCount} already in Exo.`
        : "No external skills to import." });
      return;
    }

    const models: CardModel[] = [];
    for (const it of vault) models.push({ key: `skill:${it.name}`, sig: "active", build: () => this.buildRow(it) });

    const byOrigin = new Map<string, DiscoveryItem[]>();
    for (const it of importable) {
      const arr = byOrigin.get(it.origin) ?? [];
      arr.push(it);
      byOrigin.set(it.origin, arr);
    }
    for (const origin of [...byOrigin.keys()].sort((a, b) => a.localeCompare(b))) {
      const group = byOrigin.get(origin)!;
      models.push({ key: `hdr:${origin}`, sig: `${group.length}`, build: () => this.buildGroupHeader(origin, group.length) });
      for (const it of group) models.push({ key: `skill:${it.name}`, sig: "importable", build: () => this.buildRow(it) });
    }
    if (haveCount) models.push({ key: "have-summary", sig: `${haveCount}`, build: () => this.buildHaveSummary(haveCount) });

    reconcileList(this.listEl, models);
  }

  private buildGroupHeader(origin: string, count: number): HTMLElement {
    const h = createDiv({ cls: "mva-conn-group" });
    h.createSpan({ cls: "mva-conn-group-name", text: origin });
    h.createSpan({ cls: "mva-conn-group-count", text: String(count) });
    return h;
  }

  private buildHaveSummary(count: number): HTMLElement {
    const s = createDiv({ cls: "mva-conn-have-summary" });
    s.setText(`${count} skills already in Exo — not shown`);
    return s;
  }

  private buildAddMcp(): HTMLElement {
    const row = createDiv({ cls: "mva-conn-addrow" });
    const btn = row.createEl("button", { cls: "mva-btn mva-btn-primary", text: "+ Add MCP server" });
    btn.onclick = () =>
      new McpServerModal(this.app, {
        onSubmit: async (built) => {
          const adapter = this.app.vault.adapter;
          let raw = '{\n  "mcpServers": {}\n}';
          try { raw = await adapter.read(".mcp.json"); } catch { /* create fresh */ }
          await adapter.write(".mcp.json", connectMcp(raw, built.name, built.config));
          await this.applyAndRender(`MCP "${built.name}" added.`);
        },
      }).open();
    return row;
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
        dot.toggleClass("is-failed", it.status === "failed" || it.status === "needs-auth");
        dot.toggleClass("is-disabled", it.status === "disabled");
        // Honest status: "active" only when actually connected; otherwise the
        // real reason (needs-auth / failed / disabled) so the user knows why.
        const label = !it.status || it.status === "connected" ? "active" : it.status;
        right.createSpan({ cls: "mva-conn-state", text: label });
        // Recovery actions apply to ANY server (ours, inherited, connector) since
        // reconnect respawns the session and `claude mcp login` resolves by name.
        if (it.status === "failed") {
          const b = right.createEl("button", { cls: "mva-btn", text: "Reconnect" });
          b.onclick = () => void this.doReconnect(b);
        } else if (it.status === "needs-auth") {
          const b = right.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Re-auth" });
          b.onclick = () => void this.doReauth(it, b);
        }
        // Full lifecycle only for servers WE wrote into .mcp.json — inherited /
        // live-only / connector servers are configured at their own source.
        if (this.ourMcp.has(it.name)) {
          const edit = right.createEl("button", { cls: "mva-btn", text: "Edit" });
          edit.onclick = () => this.doEditMcp(it);
          const enabled = it.status !== "disabled";
          const toggle = right.createEl("button", { cls: "mva-btn", text: enabled ? "Disable" : "Enable" });
          toggle.onclick = () => void this.doToggleMcp(it, !enabled, toggle);
          const rm = right.createEl("button", { cls: "mva-btn mva-btn-danger", text: "Remove" });
          rm.onclick = () => void this.doRemoveMcp(it, rm);
        }
      } else {
        right.createSpan({ cls: "mva-conn-state", text: "in vault" });
        const btn = right.createEl("button", { cls: "mva-btn", text: "Remove" });
        btn.onclick = () => void this.doRemoveSkill(it, btn);
      }
    } else if (it.state === "have") {
      right.createSpan({ cls: "mva-conn-state is-muted", text: "already in Exo" });
    } else {
      const btn = right.createEl("button", { cls: "mva-btn", text: it.kind === "mcp" ? "Connect" : "Import" });
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
        await this.applyAndRender(`MCP "${it.name}" connected.`);
        return;
      }
      const dest = `${this.base()}/.claude/skills/${it.name}`;
      const res = await importSkill(it.path!, dest);
      if (res === "exists") {
        if (!confirm(`A skill named "${it.name}" already exists in the vault. Overwrite it?`)) { btn.disabled = false; return; }
        await importSkill(it.path!, dest, { overwrite: true });
      }
      new Notice(`Skill "${it.name}" imported into the vault.`);
      await this.render();
    } catch (e) {
      new Notice(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
      btn.disabled = false;
    }
  }

  /** Persist a `.mcp.json` change, then make it live: respawn the active session
   *  (which resumes, so the conversation survives) so the tools appear/vanish
   *  immediately. Falls back to a "applies next session" notice when no chat is
   *  open or a turn is running — the write already persisted regardless. */
  private async applyAndRender(okMsg: string): Promise<void> {
    const res = await this.plugin.reloadMcpConnections();
    new Notice(res.ok ? `${okMsg} Reconnected.` : `${okMsg} ${res.error ?? "Applies on the next session."}`);
    await this.render();
  }

  private async doReconnect(btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    btn.setText("Reconnecting…");
    const res = await this.plugin.reloadMcpConnections();
    new Notice(res.ok ? "Reconnected." : `Reconnect failed: ${res.error}`);
    await this.render();
  }

  private async doReauth(it: DiscoveryItem, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      const cli = await resolveCli("claude", this.plugin.settings.claudeBin);
      new Notice(`Opening browser to authenticate "${it.name}"…`);
      const res = await mcpLogin(cli, it.name, this.base());
      if (!res.ok) {
        const tail = res.output ? res.output.split("\n").filter(Boolean).slice(-1)[0] : "";
        new Notice(`Authentication failed for "${it.name}".${tail ? ` ${tail}` : ""}`);
        btn.disabled = false;
        return;
      }
      new Notice(`Authenticated "${it.name}". Reconnecting…`);
      await this.plugin.reloadMcpConnections();
      await this.render();
    } catch (e) {
      new Notice(`Re-auth failed: ${e instanceof Error ? e.message : String(e)}`);
      btn.disabled = false;
    }
  }

  private doEditMcp(it: DiscoveryItem): void {
    if (!it.config) return;
    new McpServerModal(this.app, {
      initial: { name: it.name, config: it.config },
      onSubmit: async (built) => {
        const adapter = this.app.vault.adapter;
        await adapter.write(".mcp.json", connectMcp(await adapter.read(".mcp.json"), built.name, built.config));
        await this.applyAndRender(`MCP "${built.name}" updated.`);
      },
    }).open();
  }

  private async doToggleMcp(it: DiscoveryItem, enable: boolean, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      const adapter = this.app.vault.adapter;
      await adapter.write(".mcp.json", setMcpEnabled(await adapter.read(".mcp.json"), it.name, enable));
      await this.applyAndRender(`MCP "${it.name}" ${enable ? "enabled" : "disabled"}.`);
    } catch (e) {
      new Notice(`${enable ? "Enable" : "Disable"} failed: ${e instanceof Error ? e.message : String(e)}`);
      btn.disabled = false;
    }
  }

  private async doRemoveMcp(it: DiscoveryItem, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      const adapter = this.app.vault.adapter;
      await adapter.write(".mcp.json", disconnectMcp(await adapter.read(".mcp.json"), it.name));
      await this.applyAndRender(`MCP "${it.name}" removed.`);
    } catch (e) {
      new Notice(`Removal failed: ${e instanceof Error ? e.message : String(e)}`);
      btn.disabled = false;
    }
  }

  private async doRemoveSkill(it: DiscoveryItem, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      await removeSkill(`${this.base()}/.claude/skills/${it.name}`);
      new Notice(`Skill "${it.name}" removed from the vault.`);
      await this.render();
    } catch (e) {
      new Notice(`Removal failed: ${e instanceof Error ? e.message : String(e)}`);
      btn.disabled = false;
    }
  }
}
