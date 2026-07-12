/**
 * Pure .mcp.json operations for the settings MCP manager. The file keeps
 * Claude Code's contract (`mcpServers` at the top level); servers toggled off
 * move to a sibling `mcpServersDisabled` key that the CLI ignores, so a
 * disable is reversible and survives round-trips through other editors.
 */

export interface McpServerEntry {
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

export interface ParsedMcpJson {
  servers: McpServerEntry[];
  /** Non-null when the raw text wasn't a valid config — callers should freeze
   *  structured editing (never clobber a file we couldn't parse). */
  error: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseMcpJson(raw: string): ParsedMcpJson {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { servers: [], error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isRecord(json)) return { servers: [], error: "Expected a top-level object." };
  const on = json.mcpServers;
  const off = json.mcpServersDisabled;
  if (on !== undefined && !isRecord(on)) return { servers: [], error: '"mcpServers" must be an object.' };
  if (off !== undefined && !isRecord(off)) return { servers: [], error: '"mcpServersDisabled" must be an object.' };
  const servers: McpServerEntry[] = [];
  for (const [name, config] of Object.entries(on ?? {})) {
    if (isRecord(config)) servers.push({ name, config, enabled: true });
  }
  for (const [name, config] of Object.entries(off ?? {})) {
    if (isRecord(config) && !servers.some((s) => s.name === name)) servers.push({ name, config, enabled: false });
  }
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { servers, error: null };
}

export function serializeMcpJson(servers: McpServerEntry[]): string {
  const on: Record<string, unknown> = {};
  const off: Record<string, unknown> = {};
  for (const s of servers) (s.enabled ? on : off)[s.name] = s.config;
  const out: Record<string, unknown> = { mcpServers: on };
  if (Object.keys(off).length) out.mcpServersDisabled = off;
  return JSON.stringify(out, null, 2) + "\n";
}

export function upsertServer(servers: McpServerEntry[], name: string, config: Record<string, unknown>): McpServerEntry[] {
  const rest = servers.filter((s) => s.name !== name);
  const prev = servers.find((s) => s.name === name);
  return [...rest, { name, config, enabled: prev?.enabled ?? true }].sort((a, b) => a.name.localeCompare(b.name));
}

export function removeServer(servers: McpServerEntry[], name: string): McpServerEntry[] {
  return servers.filter((s) => s.name !== name);
}

export function setServerEnabled(servers: McpServerEntry[], name: string, enabled: boolean): McpServerEntry[] {
  return servers.map((s) => (s.name === name ? { ...s, enabled } : s));
}

/** One-line human summary of a server config: transport + target. */
export function summarizeServer(config: Record<string, unknown>): string {
  const type = typeof config.type === "string" ? config.type : config.url ? "http" : "stdio";
  if (type === "stdio" || (!config.url && config.command)) {
    const cmd = typeof config.command === "string" ? config.command : "?";
    const args = Array.isArray(config.args) ? config.args.map(String).join(" ") : "";
    return `stdio · ${[cmd, args].filter(Boolean).join(" ").slice(0, 60)}`;
  }
  const url = typeof config.url === "string" ? config.url : "?";
  return `${type} · ${url.slice(0, 60)}`;
}

export interface ServerFormInput {
  name: string;
  type: "stdio" | "http" | "sse";
  /** Command (stdio) or URL (http/sse). */
  target: string;
  /** Space-separated args (stdio only). */
  args: string;
  /** Optional JSON object: env (stdio) or headers (http/sse). */
  extraJson: string;
}

/** Validate the add/edit form and build the server config. */
export function buildServerConfig(input: ServerFormInput): { name: string; config: Record<string, unknown> } | { error: string } {
  const name = input.name.trim();
  if (!name) return { error: "Name is required." };
  if (!/^[\w-]+$/.test(name)) return { error: "Name: letters, digits, - and _ only." };
  const target = input.target.trim();
  if (!target) return { error: input.type === "stdio" ? "Command is required." : "URL is required." };
  let extra: Record<string, unknown> | null = null;
  if (input.extraJson.trim()) {
    try {
      const parsed = JSON.parse(input.extraJson) as unknown;
      if (!isRecord(parsed)) return { error: "Env/headers must be a JSON object." };
      extra = parsed;
    } catch {
      return { error: "Env/headers: invalid JSON." };
    }
  }
  if (input.type === "stdio") {
    const args = input.args.trim() ? input.args.trim().split(/\s+/) : [];
    return { name, config: { command: target, ...(args.length ? { args } : {}), ...(extra ? { env: extra } : {}) } };
  }
  if (!/^https?:\/\//.test(target)) return { error: "URL must start with http(s)://." };
  return { name, config: { type: input.type, url: target, ...(extra ? { headers: extra } : {}) } };
}
