/**
 * Per-source documentation — the note that turns an MCP server from "a list of
 * tools" into "a capability the agent knows when to reach for".
 *
 * A server's config says how to connect; it never says what the thing is FOR,
 * what's in scope, or what to avoid. That knowledge lives in a vault note the
 * user writes and the agent pulls on demand (via `list_capabilities`), rather
 * than being pushed into every session's system prompt — most turns don't need
 * it, and the ones that do can ask.
 *
 * Pure: paths and text only. The vault I/O lives in the callers.
 */

/** Where a server's doc note lives, relative to the vault root. */
export const MCP_DOCS_DIR = ".claude/mcp";

export function mcpDocPath(server: string): string {
  return `${MCP_DOCS_DIR}/${server}.md`;
}

/** Can this server name be a filename in the docs dir?
 *
 *  Server names come from `.mcp.json` keys, Codex TOML and live session caps —
 *  `buildServerConfig` restricts the ones WE create to `[\w-]+`, but inherited
 *  and connector names are not ours and arrive as-is ("Booking.com",
 *  "plugin:brand-voice:figma"). So this rejects what would actually be unsafe
 *  or unwritable rather than allow-listing a narrow shape: path separators and
 *  `..` (traversal), a leading dot (hidden file, and `.`/`..` themselves), `:`
 *  (a path separator in classic macOS APIs), and control characters. */
export function isSafeDocName(server: string): boolean {
  if (!server || server.length > 120) return false;
  if (server.startsWith(".")) return false;
  if (server.includes("..")) return false;
  // eslint-disable-next-line no-control-regex -- rejecting control chars is the point
  return !/[/\\:\u0000-\u001f]/.test(server);
}

/** Starter note for a server that has none yet. Deliberately a set of prompts,
 *  not prose: an empty template the user never fills is worse than none. */
export function mcpDocTemplate(server: string, summary: string): string {
  return `---
tags:
  - type/reference
---

# ${server}

${summary ? `> Connection: ${summary}\n\n` : ""}## What it's for

<!-- One or two lines: what this server gives Exo that nothing else does. -->

## Scope

<!-- What to use it for. Bullet list beats prose here. -->
-

## Avoid

<!-- Anything expensive, destructive, rate-limited, or simply out of scope. -->
-
`;
}

/** Strip frontmatter and HTML comments, collapse blank runs, and clamp — what
 *  the agent actually reads. The prompts in the template are comments, so a
 *  never-filled doc reduces to nearly nothing and reads as "no notes yet". */
export function summarizeMcpDoc(raw: string, limit = 1200): string {
  const body = raw
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .filter((l) => l.trim() !== "-") // empty bullet placeholders
    .join("\n")
    .trim();
  return body.length > limit ? `${body.slice(0, limit)}…` : body;
}

/** True when the note carries real content beyond headings. */
export function hasMcpDocContent(raw: string): boolean {
  const body = summarizeMcpDoc(raw);
  return body.split("\n").some((l) => l.trim() && !l.trim().startsWith("#") && !l.trim().startsWith(">"));
}
