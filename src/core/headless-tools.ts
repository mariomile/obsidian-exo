/**
 * Read-only classification for EXTERNAL MCP tools in headless playbook runs
 * (the digest's Dia-style source pulls: Gmail, Slack, Calendar, Readwise…).
 *
 * Headless runs are read-only by contract: vault reads are auto-allowed,
 * mutations auto-denied. When external tools are enabled, the same contract
 * must hold for MCP tools we don't control — so this classifier is
 * DENY-FIRST: a tool is allowed only when its name carries a known read verb
 * AND no known mutating verb. Anything ambiguous stays denied; a denied read
 * tool degrades a digest section, a wrongly-allowed write sends an email.
 */

/** Verbs that mutate state or trigger side effects — any hit denies. */
const MUTATING = /\b(create|send|write|update|delete|remove|add|set|post|put|edit|move|merge|apply|execute|exec|run|label|unlabel|upload|publish|reply|respond|schedule|cancel|archive|restore|rename|duplicate|copy|invite|react|resolve|submit|start|stop|pause|deploy|authenticate|complete|save|import|export|mark|replace|insert|append|modify|clear|reset|revert|comment|drop|purge|dismiss)\b/;

/** Verbs that read — required for an allow. */
const READING = /\b(read|get|list|search|find|fetch|query|count|retrieve|show|describe|lookup|view|check|status|context|help)\b/;

/** True when an EXTERNAL MCP tool (mcp__<server>__<tool>, non-obsidian) is
 *  safe to auto-allow in a read-only headless run. Non-MCP and in-process
 *  obsidian tools are out of scope (handled by their own sets). */
export function isReadOnlyExternalTool(name: string): boolean {
  if (!name.startsWith("mcp__")) return false;
  if (name.startsWith("mcp__obsidian__")) return false; // in-process — has its own gate
  const tool = name.slice(name.lastIndexOf("__") + 2);
  // Normalize word boundaries: snake_case, kebab-case, camelCase all split.
  const words = tool
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .toLowerCase();
  if (MUTATING.test(words)) return false;
  return READING.test(words);
}
