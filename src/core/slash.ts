/**
 * Slash-command hoisting — TUI parity for command placement.
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
