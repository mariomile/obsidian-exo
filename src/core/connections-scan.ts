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
