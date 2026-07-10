import { App, TFile } from "obsidian";
import { parseLoopsFile, activeLoops, dueLoops, type LoopEntry } from "../core/open-loops";
import {
  AGENT_BLOCKS,
  AGENT_DIR,
  compileIdentity,
  type IdentityBlock,
} from "../core/agent-self";

const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + "\n…(truncated)" : s);

/** Hard ceiling on the assembled preamble so a large vault can't blow the context budget.
 *  Raised to {@link MAX_BOOT_AGENT} ONLY when the agent-folder flag is ON — with the flag
 *  OFF this stays the historical value so the output is provably byte-identical. */
const MAX_BOOT = 9000;
/** Preamble ceiling when the agent folder is ON — room for the prepended identity section. */
const MAX_BOOT_AGENT = 12000;
/** Cap the rules list so a vault with dozens of rule files stays bounded. */
const MAX_RULES = 40;
/** Cap raw ledger bytes read before parsing (bounded cost even for a huge hand-edited file). */
const MAX_LOOPS_RAW = 20000;
/** Cap how many loop lines the boot section lists (bounded count, mirrors MAX_RULES). */
const MAX_LOOP_ITEMS = 12;
/** Cap the rendered open-loops section itself (bounded chars, a slice of the overall MAX_BOOT budget). */
const MAX_LOOP_SECTION = 1500;
/** Session-log slice when the identity `now.md` is absent — the historical value. */
const SESSION_LOG_CHARS = 1200;
/** Session-log slice when `now.md` exists non-empty — halved, since `now.md` is the
 *  strictly-better "what matters right now" signal (design §4). */
const SESSION_LOG_CHARS_WITH_NOW = 600;

/** Options for {@link readBootContext}. Absent/false → today's behavior, byte-identical. */
export interface BootOpts {
  /** Master flag for the identity layer (`agentFolderEnabled`, default OFF). */
  agentFolderEnabled?: boolean;
}

/**
 * Compose a concise "memory preamble" from the vault's `_system/` layer so the
 * agent boots with the user's context, preferences, and active rules. The agent can
 * read deeper on demand via the read_note tool.
 *
 * When `agentFolderEnabled` is ON, the compiled identity section (from
 * `_system/agent/`) is prepended BEFORE every existing section, the session-log
 * slice halves when `now.md` carries signal, and the overall cap widens to
 * {@link MAX_BOOT_AGENT}. When OFF (or absent), none of the folder is read and the
 * output is byte-identical to before this feature existed (seam test).
 */
export async function readBootContext(app: App, opts: BootOpts = {}): Promise<string> {
  const read = async (path: string, max: number): Promise<string> => {
    const f = app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      try {
        return cap(await app.vault.cachedRead(f), max);
      } catch {
        /* ignore */
      }
    }
    return "";
  };

  // Identity overlay (design §4) — read the three blocks + mtimes here (impure);
  // compilation is the pure `compileIdentity`. OFF → identity is "" and `now.md`
  // is treated as absent, so nothing below changes.
  const agentOn = opts.agentFolderEnabled === true;
  let identity = "";
  let nowHasSignal = false;
  if (agentOn) {
    const blocks: IdentityBlock[] = [];
    for (const spec of AGENT_BLOCKS) {
      const path = `${AGENT_DIR}/${spec.name}.md`;
      const f = app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) continue;
      try {
        const content = await app.vault.cachedRead(f);
        blocks.push({ name: spec.name, content, mtime: f.stat?.mtime });
        if (spec.name === "now" && content.trim().length > 0) nowHasSignal = true;
      } catch {
        /* unreadable block — skip silently (§8) */
      }
    }
    identity = compileIdentity(blocks, { now: Date.now() });
  }

  const parts: string[] = [];
  const ctx = await read("_system/vault-context.md", 3500);
  if (ctx) parts.push(`### Vault context\n${ctx}`);
  const prefs = await read("_system/memory/preferences/preferences.md", 2500);
  if (prefs) parts.push(`### Preferences\n${prefs}`);

  const ruleFiles = app.vault
    .getMarkdownFiles()
    .filter((f) => f.path.startsWith("_system/memory/rules/"));
  const rules = ruleFiles.slice(0, MAX_RULES).map((f) => `- ${f.basename}`);
  if (ruleFiles.length > MAX_RULES) rules.push(`- …and ${ruleFiles.length - MAX_RULES} more`);
  if (rules.length) parts.push(`### Active rules (read the file for detail)\n${rules.join("\n")}`);

  // A non-empty `now.md` is a strictly-better "what matters right now" signal than
  // the recent-sessions digest, so we spend fewer chars on the log when it exists.
  const logChars = nowHasSignal ? SESSION_LOG_CHARS_WITH_NOW : SESSION_LOG_CHARS;
  const log = await read("_system/memory/session-log.md", logChars);
  if (log) parts.push(`### Recent sessions (prior sessions — background, NOT the current conversation)\n${log}`);

  const loopsRaw = await read("_system/memory/open-loops.md", MAX_LOOPS_RAW);
  if (loopsRaw) {
    const entries: LoopEntry[] = parseLoopsFile(loopsRaw);
    const due = dueLoops(entries);
    const dueIds = new Set(due.map((e) => e.id));
    const others = activeLoops(entries).filter((e) => !dueIds.has(e.id));
    const combined = [...due, ...others].slice(0, MAX_LOOP_ITEMS);
    // Emit the section only when there's at least one due/active loop — an all-closed
    // or empty ledger shouldn't cost boot budget for nothing to show.
    if (combined.length) {
      const lines = combined.map((e) => {
        const label = dueIds.has(e.id) ? "due" : e.resurface ? `resurface ${e.resurface}` : "open";
        return `- [${label}] ${e.title} (${e.id})`;
      });
      parts.push(cap(`### Open loops (due/active)\n${lines.join("\n")}`, MAX_LOOP_SECTION));
    }
  }

  // Nothing to say at all (no sections AND no identity) → empty, exactly as before.
  if (!parts.length && !identity) return "";

  const maxBoot = agentOn ? MAX_BOOT_AGENT : MAX_BOOT;
  return cap(
    [
      // Identity FIRST when present — it's the arbitration-winning frame (design §4).
      ...(identity ? [identity] : []),
      "## Vault memory — you are Exo, embedded in this Obsidian vault.",
      "Honor these conventions: prefer the `mcp__obsidian__*` tools for vault operations (they respect links/tags/frontmatter); follow the tag system (#type/*, #status/*, #domain/*) and the object schema; use [[wikilinks]] for internal references; never create files at the vault root.",
      "Precedence: the sections below (especially `Recent sessions`) are BACKGROUND from prior sessions. The conversation you are in right now is authoritative — when the user says 'continue', refers to 'the proposed/other things', 'as above', or otherwise points back, resolve it from the CURRENT conversation's own history, never from a prior session's topic.",
      ...parts,
    ].join("\n\n"),
    maxBoot
  );
}
