/**
 * Codex session toolset — the pure half of the Codex ↔ Obsidian bridge's
 * sandbox honesty (no Obsidian imports).
 *
 * Bridge tool handlers run in the Obsidian process and BYPASS codex's own
 * sandbox, so a read-only sandbox must get read tools only. `ask_user` is the
 * deliberate exception: it mutates nothing — blocking the turn on a question
 * card is user interaction, not a write — and a read-only session that cannot
 * ask a clarifying question would be needlessly dumber than its Claude twin.
 *
 * When the sandbox is not read-only, the input array is returned AS-IS (same
 * reference): the tool list sent to sessions stays byte-identical to a build
 * where this function is not in the path.
 */

/** Interaction tools that stay in a read-only sandbox besides the read set. */
const INTERACTION_TOOLS = new Set(["ask_user"]);

const MCP_PREFIX = "mcp__obsidian__";

export function codexSessionToolset<T extends { name: string }>(
  all: T[],
  readOnlySandbox: boolean,
  readToolNames: Iterable<string>
): T[] {
  if (!readOnlySandbox) return all;
  const readBasenames = new Set(
    [...readToolNames].map((n) => (n.startsWith(MCP_PREFIX) ? n.slice(MCP_PREFIX.length) : n))
  );
  return all.filter((t) => readBasenames.has(t.name) || INTERACTION_TOOLS.has(t.name));
}
