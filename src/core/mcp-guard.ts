/**
 * Two guards against external MCP servers stalling an Exo turn. Pure module:
 * the caller does the fs reads and passes parsed config in.
 *
 * 1. External Obsidian-vault servers (mcp-obsidian, obsidian-mcp, the Local
 *    REST API bridges, plugin-shipped `.obsidian/plugins/.../mcp-server`
 *    binaries) are redundant inside Exo, which already reads and writes the
 *    vault directly (built-in file tools + its own in-process `obsidian`
 *    server). They are a common source of hung tool calls for users who
 *    followed "Claude + Obsidian" tutorials, so Exo sessions skip them via the
 *    CLI's `deniedMcpServers` setting, passed per session through the SDK
 *    `settings` option. The user's own Claude config is never touched.
 *
 * 2. A default idle timeout for external MCP tool calls, so a server that goes
 *    silent fails the call instead of freezing the turn.
 */

/** Name of Exo's own in-process MCP server (see providers/claude.ts). */
export const EXO_MCP_SERVER_NAME = "obsidian";

/** Shown in the Connections pane for a server Exo skips. */
export const OBSIDIAN_MCP_SKIP_REASON = "Skipped in Exo: Exo already reads the vault directly";

export interface ConfiguredMcpServer {
  name: string;
  config: Record<string, unknown>;
}

/** One entry of the CLI's `deniedMcpServers` setting. */
export type DeniedMcpServer = { serverName: string } | { serverCommand: [string, ...string[]] } | { serverUrl: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Default ports of the Obsidian "Local REST API" plugin (https / http). */
const LOCAL_REST_API_PORT = /:2712[34](\/|$)/;

/** A command or arg token that names an Obsidian MCP package or binary: one of
 *  its path/package segments carries both "obsidian" and "mcp"
 *  (`mcp-obsidian`, `obsidian-mcp-server@latest`, `@x/obsidian-mcp`,
 *  `C:\src\mcp-obsidian\dist\index.js`), or it lives inside a vault's plugin
 *  folder (`.obsidian/plugins/mcp-tools/bin/mcp-server`). A plain vault path
 *  like `~/Documents/Obsidian Vault` has no "mcp" segment, so a generic
 *  filesystem server pointed at the vault is left alone. */
function isObsidianMcpToken(token: string): boolean {
  const t = token.toLowerCase();
  if (/[\\/]\.obsidian[\\/]plugins[\\/]/.test(t)) return true;
  return t.split(/[\\/]/).some((seg) => seg.includes("obsidian") && seg.includes("mcp"));
}

/** True when this configured server is an EXTERNAL Obsidian-vault MCP server
 *  that Exo should skip. Never true for an in-process (`type: "sdk"`) server,
 *  which is how Exo's own server is registered. */
export function isExternalObsidianMcp(name: string, config: Record<string, unknown>): boolean {
  if (config.type === "sdk") return false;
  const command = typeof config.command === "string" ? config.command : "";
  const args = Array.isArray(config.args) ? config.args.map(String) : [];
  const url = typeof config.url === "string" ? config.url.toLowerCase() : "";
  // Exo's own name with no transport of its own is not an external server.
  if (name === EXO_MCP_SERVER_NAME && !command && !url) return false;
  if (name.toLowerCase().includes("obsidian")) return true;
  if ([command, ...args].some(isObsidianMcpToken)) return true;
  return url !== "" && (url.includes("obsidian") || LOCAL_REST_API_PORT.test(url));
}

/** The servers Claude Code loads from config for a session in `cwd`: user
 *  scope (`~/.claude.json` top-level), local scope (`~/.claude.json`
 *  projects[cwd]) and project scope (`<cwd>/.mcp.json`). Plugin servers and
 *  claude.ai connectors are resolved inside the CLI and are not listed here. */
export function configuredMcpServers(
  claudeJson: unknown,
  projectMcpJson: unknown,
  cwd: string,
): ConfiguredMcpServer[] {
  const out: ConfiguredMcpServer[] = [];
  const add = (servers: unknown) => {
    if (!isRecord(servers)) return;
    for (const [name, config] of Object.entries(servers)) if (isRecord(config)) out.push({ name, config });
  };
  if (isRecord(claudeJson)) {
    add(claudeJson.mcpServers);
    if (isRecord(claudeJson.projects)) {
      const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const want = norm(cwd);
      for (const [path, proj] of Object.entries(claudeJson.projects)) {
        if (norm(path) === want && isRecord(proj)) add(proj.mcpServers);
      }
    }
  }
  if (isRecord(projectMcpJson)) add(projectMcpJson.mcpServers);
  return out;
}

/** `deniedMcpServers` entries for every external Obsidian server in `servers`.
 *  Denied by name, EXCEPT a server literally named like Exo's own: a name
 *  entry would also block Exo's in-process server, so that one is denied by
 *  its exact command (stdio) or URL (remote) instead. Verified against CLI
 *  2.1.282: a config server named "obsidian" otherwise SHADOWS Exo's own. */
export function obsidianMcpDenyList(servers: ConfiguredMcpServer[]): DeniedMcpServer[] {
  const out: DeniedMcpServer[] = [];
  const seen = new Set<string>();
  const push = (entry: DeniedMcpServer) => {
    const key = JSON.stringify(entry);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };
  for (const { name, config } of servers) {
    if (!isExternalObsidianMcp(name, config)) continue;
    if (name !== EXO_MCP_SERVER_NAME) {
      push({ serverName: name });
    } else if (typeof config.command === "string" && config.command) {
      const args = Array.isArray(config.args) ? config.args.map(String) : [];
      push({ serverCommand: [config.command, ...args] });
    } else if (typeof config.url === "string" && config.url) {
      push({ serverUrl: config.url });
    }
  }
  return out;
}

/** Idle timeout (ms) for external MCP tool calls: a server that sends no
 *  response and no progress for this long fails the call. */
export const DEFAULT_MCP_TOOL_IDLE_TIMEOUT_MS = "120000";

/** Env for the Claude CLI subprocess: the caller's env, the enriched PATH, and
 *  a default `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` unless the user set one.
 *
 *  Why the idle timeout and not `MCP_TOOL_TIMEOUT`: the CLI applies
 *  `MCP_TOOL_TIMEOUT` to in-process SDK servers too (verified on CLI 2.1.282:
 *  an Exo tool was cut at the env value, and a per-server `timeout` on an SDK
 *  server is ignored), so a global cap would also kill Exo's own long waits
 *  (ask_user waiting on Mario, browser, invoke_agent). The idle timeout skips
 *  `sdk` servers by design and only fires on silence; a long-running external
 *  server that reports progress, or has a per-server `timeout`, is unaffected.
 *  Default otherwise: 30 min for stdio, 5 min for remote servers. */
export function claudeCliEnv(base: Record<string, string | undefined>, pathEnv: string): Record<string, string | undefined> {
  return {
    ...base,
    PATH: pathEnv,
    CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: base.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT || DEFAULT_MCP_TOOL_IDLE_TIMEOUT_MS,
  };
}

/** Connections pane: mark every Obsidian server Exo skips so the row says why
 *  instead of silently disappearing. Only sources Exo actually loads (Claude
 *  user scope, the vault's `.mcp.json`) are relabelled. */
export function markSkippedObsidianMcp<T extends { name: string; source: string; config?: Record<string, unknown>; state: string; status?: string; desc?: string }>(
  items: T[],
): T[] {
  return items.map((it) =>
    (it.source === "claude-global" || it.source === "vault") && it.config && isExternalObsidianMcp(it.name, it.config)
      ? { ...it, state: "active", status: "skipped", desc: OBSIDIAN_MCP_SKIP_REASON }
      : it,
  );
}
