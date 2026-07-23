/**
 * Pure discovery scan for the Connections pane. Reads config already present on
 * the system (Claude global `~/.claude.json`, Codex `~/.codex/config.toml`,
 * other-project + Codex skill dirs), normalizes every entry into a common
 * `DiscoveryItem`, and diffs against what Exo already has so the pane never
 * offers to import a duplicate. No Obsidian, no network — fully unit-testable.
 * The caller (the view) does the fs reads and passes raw strings/objects in.
 */

export type ItemKind = "mcp" | "skill";
export type ItemState = "active" | "importable" | "have";
export type SourceId = "claude-global" | "claude-project" | "codex" | "vault" | "other-project";

export interface DiscoveryItem {
  kind: ItemKind;
  name: string;
  source: SourceId;
  origin: string;
  state: ItemState;
  /** MCP only: server config normalized to Claude's `.mcp.json` shape. */
  config?: Record<string, unknown>;
  /** Skill only: absolute source folder to copy on import. */
  path?: string;
  /** Skill only: description from frontmatter. */
  desc?: string;
  /** MCP active only: live status from SessionCaps ("connected"/"failed"). */
  status?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Map a Codex `[mcp_servers.X]` object to Claude's `.mcp.json` server shape.
 *  Returns null when the entry has no usable transport (url or command/args). */
export function normalizeCodexServer(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof raw.url === "string") {
    const out: Record<string, unknown> = { type: "http", url: raw.url };
    if (isRecord(raw.http_headers) && Object.keys(raw.http_headers).length) out.headers = raw.http_headers;
    return out;
  }
  const hasCmd = typeof raw.command === "string";
  const hasArgs = Array.isArray(raw.args);
  if (!hasCmd && !hasArgs) return null;
  const out: Record<string, unknown> = {};
  if (hasCmd) out.command = raw.command;
  if (hasArgs) out.args = (raw.args as unknown[]).map(String);
  if (isRecord(raw.env) && Object.keys(raw.env).length) out.env = raw.env;
  return out;
}

/** Parse the subset of TOML Codex uses for MCP servers into a name→object map.
 *  Handles `[mcp_servers.NAME]` tables, scalar `key = "value"`, inline arrays
 *  `args = [ "a", "b" ]`, and the `.http_headers` sub-table; deeper nested
 *  tables (`.tools.X`) are entered but their keys ignored. Purpose-built — not
 *  a general TOML parser (keeps the bundle lean; only this shape is needed). */
function parseCodexServers(toml: string): Map<string, Record<string, unknown>> {
  const servers = new Map<string, Record<string, unknown>>();
  let curName: string | null = null;
  let headerTarget: string | null = null; // name whose http_headers table we're in
  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");
  for (const rawLine of toml.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[mcp_servers\.([^\].]+)(\.[^\]]+)?\]$/);
    if (header) {
      const name = header[1];
      const sub = header[2]; // ".http_headers" or ".tools.browser_run_code_unsafe"
      if (!servers.has(name)) servers.set(name, {});
      if (sub === ".http_headers") {
        headerTarget = name;
        curName = null;
        (servers.get(name) as Record<string, unknown>).http_headers ??= {};
      } else if (sub) {
        curName = null; // deeper nested (tools.*) — ignore its keys
        headerTarget = null;
      } else {
        curName = name;
        headerTarget = null;
      }
      continue;
    }
    if (line.startsWith("[")) { curName = null; headerTarget = null; continue; } // unrelated section
    const kv = line.match(/^([\w-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    const valRaw = kv[2].trim();
    let value: unknown;
    if (valRaw.startsWith("[")) {
      value = valRaw.replace(/^\[|\]$/g, "").split(",").map((s) => unquote(s)).filter(Boolean);
    } else {
      value = unquote(valRaw);
    }
    if (headerTarget) {
      const h = (servers.get(headerTarget)!.http_headers ??= {}) as Record<string, unknown>;
      h[key] = value;
    } else if (curName) {
      servers.get(curName)![key] = value;
    }
  }
  return servers;
}

/** Scan a Codex `config.toml` string into importable MCP DiscoveryItems.
 *  State is provisional `"importable"` — the real diff runs in assignMcpState. */
export function scanCodexMcp(tomlText: string): DiscoveryItem[] {
  const out: DiscoveryItem[] = [];
  for (const [name, raw] of parseCodexServers(tomlText)) {
    const config = normalizeCodexServer(raw);
    if (!config) continue;
    out.push({ kind: "mcp", name, source: "codex", origin: "Codex", state: "importable", config });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface ClaudeJson {
  mcpServers?: Record<string, unknown>;
  projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
}

/** Scan `~/.claude.json` (already parsed) for MCP servers — top-level (Claude
 *  global, which Exo also loads) and per-project (other repos' servers). Config
 *  passes through verbatim: it's already in Claude's `.mcp.json` shape. */
export function scanClaudeGlobalMcp(claude: ClaudeJson): DiscoveryItem[] {
  const out: DiscoveryItem[] = [];
  for (const [name, config] of Object.entries(claude.mcpServers ?? {})) {
    if (isRecord(config)) out.push({ kind: "mcp", name, source: "claude-global", origin: "Claude global", state: "importable", config });
  }
  for (const [projPath, proj] of Object.entries(claude.projects ?? {})) {
    const base = projPath.split("/").filter(Boolean).pop() ?? projPath;
    for (const [name, config] of Object.entries(proj?.mcpServers ?? {})) {
      if (isRecord(config)) out.push({ kind: "mcp", name, source: "claude-project", origin: `Claude · ${base}`, state: "importable", config });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Diff MCP items against what Exo already has. `activeNames` = servers Exo
 *  toggled on itself (live caps ∪ enabled `.mcp.json`); `inheritedNames` =
 *  names Exo loads without a `.mcp.json` entry (Claude global). Dedups by name
 *  keeping the first occurrence, so a server in both Codex and Claude appears
 *  once. This is the guard that stops us importing a duplicate. */
export function assignMcpState(
  items: DiscoveryItem[],
  have: { activeNames: Set<string>; inheritedNames: Set<string> },
): DiscoveryItem[] {
  const seen = new Set<string>();
  const out: DiscoveryItem[] = [];
  for (const it of items) {
    if (seen.has(it.name)) continue;
    seen.add(it.name);
    const state: ItemState = have.activeNames.has(it.name)
      ? "active"
      : have.inheritedNames.has(it.name)
        ? "have"
        : "importable";
    out.push({ ...it, state });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
