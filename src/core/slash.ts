/**
 * Slash-command surface — what `/` offers, and where a `/command` may sit.
 *
 * The CLI expands `/command` only when it opens the message. Claude Code's
 * terminal UI hides this because it intercepts commands at the input layer;
 * Exo sends raw text through the SDK, so a command typed mid-message ("do X
 * for me\n/goal") reaches the model as literal text and never expands.
 *
 * hoistSlashCommand() closes the gap at send time: if a line of the message
 * is a KNOWN command (matched against the session's live command list — never
 * a bare "/" pattern, so URLs and paths in prose can't false-positive), the
 * command is moved to the front and the surrounding text becomes its argument.
 */

const COMMAND_LINE = /^\/([A-Za-z0-9][\w:-]*)(?:\s+(.*))?$/;

/**
 * If `text` contains a known `/command` line that isn't already at the start,
 * hoist it to the front. The rest of the message becomes the argument:
 *
 *   "organize my notes\n/goal"  →  "/goal organize my notes"
 *   "/goal organize my notes"   →  unchanged (already leading)
 *   "see https://a.b/goal now"  →  unchanged (not a standalone command line)
 *   "text\n/unknowncmd"         →  unchanged (not in the known list)
 *
 * Only the first matching command line is hoisted. If the command line carried
 * its own arguments they stay attached to it, and the remaining text follows
 * on the next lines (the model still sees everything).
 */
export function hoistSlashCommand(text: string, known: ReadonlySet<string>): string {
  if (!text.includes("/") || known.size === 0) return text;
  const lines = text.split("\n");
  // Already command-first? Leave the message alone — the CLI handles it.
  const first = COMMAND_LINE.exec(lines[0].trim());
  if (first && known.has(first[1])) return text;

  for (let i = 0; i < lines.length; i++) {
    const m = COMMAND_LINE.exec(lines[i].trim());
    if (!m || !known.has(m[1])) continue;
    const rest = [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n").trim();
    const cmd = `/${m[1]}`;
    const ownArgs = m[2]?.trim();
    if (!rest) return ownArgs ? `${cmd} ${ownArgs}` : cmd;
    // No inline args → the surrounding text IS the argument (same line, the
    // shape the CLI parses). Inline args win the same-line slot; the rest of
    // the message follows below and still reaches the model.
    return ownArgs ? `${cmd} ${ownArgs}\n${rest}` : `${cmd} ${rest}`;
  }
  return text;
}

export interface SlashEntry {
  name: string;
  /** What the thing IS, not which roster it came from. Drives the label + icon. */
  kind: "command" | "skill";
}

/**
 * One row per name for the `/` menu.
 *
 * The CLI's command roster already contains every skill — a plugin skill is
 * invocable as `/plugin:skill` without shipping a `commands/*.md` of its own.
 * Listing both rosters therefore printed each skill twice, and the two rows
 * were indistinguishable in effect: same name, same `/name ` insertion.
 *
 * A name present in both is a skill, so the skill kind wins. That keeps the
 * kind tag meaningful: every `/` row says what the underlying artifact is,
 * instead of leaking which of the two lists happened to yield it first.
 * Commands keep their position ahead of skills.
 */
export function mergeSlashEntries(commands: readonly string[], skills: readonly string[]): SlashEntry[] {
  const skillNames = new Set(skills);
  const out: SlashEntry[] = [];
  // `seen` also absorbs repeats inside a single roster — the vault scan reads
  // .claude/skills as both folders and files, so `foo/` + `foo.md` collide.
  const seen = new Set<string>();
  const take = (name: string, kind: SlashEntry["kind"]) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ name, kind });
  };
  for (const name of commands) if (!skillNames.has(name)) take(name, "command");
  for (const name of skills) take(name, "skill");
  return out;
}
