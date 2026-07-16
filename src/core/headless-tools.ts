/**
 * Read-only classification for EXTERNAL MCP tools in headless playbook runs
 * (the digest's Dia-style source pulls: Gmail, Slack, Calendar, Readwise…).
 *
 * Headless runs are read-only by contract: vault reads are auto-allowed,
 * mutations auto-denied. When external tools are enabled, the same contract
 * must hold for MCP tools we don't control. Tool-name heuristics are not a
 * security boundary: an unknown server can expose a side-effecting tool named
 * `get_*`. Keep an explicit allowlist of the exact connected read primitives
 * Exo uses; everything else is denied until deliberately reviewed.
 */

const EXTERNAL_READ_ALLOWLIST = new Set([
  "mcp__claude_ai_Gmail__search_threads",
  "mcp__claude_ai_Gmail__get_message",
  "mcp__claude_ai_Gmail__get_thread",
  "mcp__claude_ai_Gmail__list_labels",
  "mcp__claude_ai_Slack__slack_read_channel",
  "mcp__claude_ai_Slack__slack_read_thread",
  "mcp__claude_ai_Slack__slack_search_public_and_private",
  "mcp__claude_ai_Slack__slack_search_users",
  "mcp__claude_ai_Google_Calendar__list_events",
  "mcp__claude_ai_Google_Calendar__get_event",
  "mcp__claude_ai_Google_Calendar__search_events",
  "mcp__claude_ai_Readwise__search",
  "mcp__claude_ai_Notion__notion-search",
  "mcp__claude_ai_Notion__notion-fetch",
]);

/** True when an EXTERNAL MCP tool (mcp__<server>__<tool>, non-obsidian) is
 *  safe to auto-allow in a read-only headless run. Non-MCP and in-process
 *  obsidian tools are out of scope (handled by their own sets). */
export function isReadOnlyExternalTool(name: string): boolean {
  return EXTERNAL_READ_ALLOWLIST.has(name);
}
