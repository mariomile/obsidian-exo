/**
 * Slash-command surface — what `/` offers, and where a `/command` may sit.
 *
 * The CLI expands `/command` only when it opens the message. Claude Code's
 * terminal UI hides this because it intercepts commands at the input layer;
 * Exo sends raw text through the SDK, so a command typed mid-message ("do X
 * for me\n/goal") reaches the model as literal text and never expands.
 *
 * hoistSlashCommand() closes the gap at send time: wherever a KNOWN command
 * sits in the message, it is moved to the front and the surrounding text
 * becomes its argument. "Known" is the load-bearing word — the match is always
 * against the session's live command+skill roster, never a bare "/" pattern,
 * so URLs and paths in prose can't false-positive.
 */

const COMMAND_LINE = /^\/([A-Za-z0-9][\w:-]*)(?:\s+(.*))?$/;

/**
 * A command embedded in prose. The delimiters are what keep it safe:
 * the "/" must open a whitespace-delimited token, and the name must end one.
 *
 *   "perché. /grilling"   → matches (space before, end of string after)
 *   "https://a.b/goal"    → no match ("/" follows "b", not whitespace)
 *   "/Users/mario/goal"   → no match ("/Users" is followed by "/", not space)
 */
const INLINE_COMMAND = /(?:^|\s)\/([A-Za-z0-9][\w:-]*)(?=\s|$)/g;

/**
 * If `text` contains a known `/command` that isn't already at the start, hoist
 * it to the front. The rest of the message becomes the argument:
 *
 *   "organize my notes\n/goal"  →  "/goal organize my notes"
 *   "sharpen this. /grilling"   →  "/grilling sharpen this."
 *   "/goal organize my notes"   →  unchanged (already leading)
 *   "see https://a.b/goal now"  →  unchanged (not a command token)
 *   "text\n/unknowncmd"         →  unchanged (not in the known list)
 *
 * Only the first match is hoisted. A command that OWNS its line keeps whatever
 * arguments follow it on that line, and the rest of the message trails below —
 * the explicit shape, so "fix the tests\n/goal ship v2" doesn't swallow
 * "ship v2" into the prose. A command embedded in prose has no such slot: it
 * is lifted out of the sentence and the sentence becomes the argument.
 */
export function hoistSlashCommand(text: string, known: ReadonlySet<string>): string {
  if (!text.includes("/") || known.size === 0) return text;
  const lines = text.split("\n");
  // Already command-first? Leave the message alone — the CLI handles it. Only
  // leading whitespace is shaved: the CLI wants the "/" to literally open the
  // message, so " /goal" would otherwise pass this guard and expand nowhere.
  const first = COMMAND_LINE.exec(lines[0].trim());
  if (first && known.has(first[1])) return text.trimStart();

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

  // No command owns a line — take one out of the middle of a sentence. This is
  // the shape the composer's own autocomplete produces: typing "/" mid-message
  // opens the menu and inserts "/name " right there, so refusing to hoist it
  // made the palette offer something the send path then ignored.
  for (const m of text.matchAll(INLINE_COMMAND)) {
    if (m.index === undefined || !known.has(m[1])) continue;
    const rest = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
    const cmd = `/${m[1]}`;
    return rest ? `${cmd} ${rest}` : cmd;
  }
  return text;
}

/** A `/command` that OPENS the message, split into its name and arguments.
 *  Null for anything else — prose, a mid-message command (hoist first), or a
 *  bare "/". */
export function parseLeadingCommand(text: string): { name: string; args: string } | null {
  const trimmed = text.trimStart();
  const nl = trimmed.indexOf("\n");
  const firstLine = nl === -1 ? trimmed : trimmed.slice(0, nl);
  const rest = nl === -1 ? "" : trimmed.slice(nl + 1);
  const m = COMMAND_LINE.exec(firstLine.trim());
  if (!m) return null;
  const args = [m[2]?.trim(), rest.trim()].filter(Boolean).join("\n");
  return { name: m[1], args };
}

/**
 * Expand a `.claude/commands/<name>.md` body the way the Claude CLI would, for
 * engines that don't read `.claude/` at all.
 *
 * Claude Code resolves these natively, so Exo never touched them. Codex does
 * not: it received "/brief" as literal text while the composer's autocomplete
 * happily offered the command — an affordance that looked identical on both
 * providers and worked on one. This is that expansion, done client-side.
 *
 * Supported, because the vault's own commands use them: frontmatter is
 * stripped, `$ARGUMENTS` and `$1`…`$9` are substituted, and a command with no
 * placeholder gets its arguments appended so they are never silently dropped.
 *
 * NOT supported: `!`-prefixed shell execution and `@`-prefixed file inlining.
 * Those run BEFORE the prompt reaches the model and would need Exo to execute
 * on the CLI's behalf — a different and much larger contract. They are left
 * verbatim rather than half-emulated, so a command that uses them reads as
 * unexpanded instead of quietly wrong.
 */
export function expandCommandBody(body: string, args: string): string {
  const withoutFm = body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  const positional = args.split(/\s+/).filter(Boolean);
  let out = withoutFm;
  let substituted = false;
  if (out.includes("$ARGUMENTS")) {
    out = out.split("$ARGUMENTS").join(args);
    substituted = true;
  }
  out = out.replace(/\$([1-9])\b/g, (whole, digit: string) => {
    substituted = true;
    return positional[Number(digit) - 1] ?? whole;
  });
  const text = out.trim();
  if (substituted || !args) return text;
  // No placeholder but the user passed arguments: appending is the only way
  // they reach the model at all. Dropping them would make "/brief for Q3"
  // behave exactly like a bare "/brief" with no sign anything was lost.
  return `${text}\n\n${args}`;
}

/**
 * Resolve a leading `/command` against `.claude/commands/` and return the
 * expanded prompt, for an engine that doesn't do it itself.
 *
 * `read` carries the provider gate as well as the I/O: pass the vault adapter
 * for Codex, `null` for Claude (whose CLI expands these natively — expanding
 * here too would send the body AND the command). Injecting it also keeps this
 * free of Obsidian, so it tests as a pure function.
 *
 * A miss — no such file, unreadable, not a command at all — returns the text
 * untouched: exactly the behaviour that existed before expansion, so this can
 * only add resolution, never take it away.
 */
export async function expandVaultCommand(
  text: string,
  read: ((path: string) => Promise<string>) | null
): Promise<string> {
  if (!read) return text;
  const parsed = parseLeadingCommand(text);
  if (!parsed) return text;
  try {
    return expandCommandBody(await read(`.claude/commands/${parsed.name}.md`), parsed.args);
  } catch {
    return text;
  }
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
