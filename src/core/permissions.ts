import { toolFilePath } from "../ui/tools";
import { WRITE_TOOLS } from "./touched";

/** Signature for the "Always allow" list — argument-aware so allowing one
 *  Bash command (or one file edit) does NOT blanket-approve all of them.
 *  Bash → keyed by the leading command token (the binary); file-mutating
 *  tools → keyed by target path; everything else → the bare tool name. */
export function allowKey(tool: string, input: unknown): string {
  const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (tool === "Bash") {
    const cmd = typeof i.command === "string" ? i.command : "";
    const first = cmd.trim().split(/\s+/)[0] ?? "";
    return first ? `Bash:${first}` : "Bash";
  }
  const fp = toolFilePath(tool, input);
  if (fp && WRITE_TOOLS.test(tool)) return `${tool}:${fp}`;
  return tool;
}

/** The argument text a permission rule matches against — the full command for
 *  Bash, the target file path for write tools, "" otherwise. Mirrors the
 *  argument axis of allowKey so hand-written and card-created rules agree. */
export function permArgText(tool: string, input: unknown): string {
  const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (tool === "Bash") return typeof i.command === "string" ? i.command.trim() : "";
  const fp = toolFilePath(tool, input);
  if (fp && WRITE_TOOLS.test(tool)) return fp;
  return "";
}

/** The permission-rule line equivalent to an "Always allow" card choice —
 *  `Tool(argPrefix)` scoped like allowKey (leading command token / target path). */
export function permRuleLine(tool: string, input: unknown): string {
  const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (tool === "Bash") {
    const first = (typeof i.command === "string" ? i.command : "").trim().split(/\s+/)[0] ?? "";
    return first ? `Bash(${first})` : "Bash";
  }
  const fp = toolFilePath(tool, input);
  if (fp && WRITE_TOOLS.test(tool)) return `${tool}(${fp})`;
  return tool;
}

/** Does a rule's tool-name segment cover `tool`?
 *
 *  Exact by default. A trailing `*` matches a prefix, which is what makes a
 *  whole MCP source governable by one line: `mcp__notion__*` covers every tool
 *  that server exposes, so a user can allow (or deny) a source rather than
 *  re-deciding per tool as the server's tool list grows.
 *
 *  The prefix must end at a segment boundary (`__`), so `mcp__notion__*` never
 *  reaches `mcp__notion_admin__delete` — the neighbouring server whose name
 *  merely starts the same way. `*` alone is refused: a rule that matches every
 *  tool is never what someone meant to write, and in the allow list it would
 *  silently disable the permission card entirely. */
export function matchToolName(pattern: string, tool: string): boolean {
  if (!pattern.endsWith("*")) return pattern === tool;
  const prefix = pattern.replace(/\*+$/, "");
  if (!prefix) return false; // bare "*" — refused, see above
  if (tool === prefix.replace(/__$/, "")) return true; // mcp__notion__* covers mcp__notion
  return tool.startsWith(prefix.endsWith("__") ? prefix : `${prefix}__`);
}

/** The first rule line whose tool-name segment covers `tool`, or null. Used to
 *  SHOW a standing rule (the hub's MCP rows) — never to decide anything;
 *  `decidePermission` remains the single decision path. */
export function findToolRule(rules: string, tool: string): string | null {
  for (const raw of rules.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([\w-]+(?:__[\w-]+)*(?:__)?\*?)(?:\((.*?)\))?$/);
    if (m && matchToolName(m[1], tool)) return line;
  }
  return null;
}

export type ToolPermStatus = "denied" | "auto-allowed" | "asks";

/** What a tool's standing rules say WOULD happen, at a glance — for display
 *  only (the MCP tab's Permissions accordion). This is deliberately not the
 *  same function as `decidePermission`: that one also factors in the live
 *  session's `isRead`/`alreadyAllowed`/`autoAllowRead`, none of which are
 *  known from settings alone, and mixing them in here would make the badge
 *  claim a certainty the static rules don't have. Same deny-before-allow
 *  order as the real decision, just narrower. */
export function toolPermissionStatus(tool: string, allowRules: string, denyRules: string): ToolPermStatus {
  if (matchPermRule(denyRules, tool, "")) return "denied";
  if (matchPermRule(allowRules, tool, "")) return "auto-allowed";
  return "asks";
}

/** Match one Exo permission rule against a tool invocation. */
export function matchPermRule(rules: string, tool: string, argText: string): boolean {
  for (const raw of rules.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([\w-]+(?:__[\w-]+)*(?:__)?\*?)(?:\((.*?)\))?$/);
    if (!m || !matchToolName(m[1], tool)) continue;
    const rawArg = m[2] ?? "";
    const wildcard = rawArg.endsWith("*");
    const prefix = wildcard ? rawArg.replace(/\*+$/, "") : rawArg;
    if (!prefix) return true;
    if (tool === "Bash") {
      if (argText === prefix || argText.startsWith(prefix + " ")) return true;
    } else if (wildcard ? argText.startsWith(prefix) : argText === prefix) {
      return true;
    }
  }
  return false;
}

/** Outcome of the gated permission decision — mirrors the four branches of the
 *  original if/else-if chain in `view.ts`'s `case "permission-request":` handler. */
export type PermissionOutcome = "deny-rule" | "auto-allow" | "memory-deny" | "card";

/** Pure permission-decision reducer — extracted verbatim from `view.ts`. The
 *  branch order (deny → auto-allow → memory-deny → card) is the security bar:
 *  a deny rule always wins, even over an auto-allow-eligible or memory tool. */
export function decidePermission(p: {
  tool: string;
  argText: string;
  isRead: boolean;
  isMemoryTool: boolean;
  alreadyAllowed: boolean;
  autoAllowRead: boolean;
  memoryWriteEnabled: boolean;
  permDenyRules: string;
  permAllowRules: string;
}): PermissionOutcome {
  if (matchPermRule(p.permDenyRules, p.tool, p.argText)) return "deny-rule";
  if ((p.autoAllowRead && p.isRead) || p.alreadyAllowed || matchPermRule(p.permAllowRules, p.tool, p.argText)) {
    return "auto-allow";
  }
  if (p.isMemoryTool && !p.memoryWriteEnabled) return "memory-deny";
  return "card";
}
