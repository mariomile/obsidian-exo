import { App, TFile } from "obsidian";
import { parseLoopsFile, activeLoops, dueLoops, type LoopEntry } from "../core/open-loops";

const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + "\n…(truncated)" : s);

/** Hard ceiling on the assembled preamble so a large vault can't blow the context budget. */
const MAX_BOOT = 9000;
/** Cap the rules list so a vault with dozens of rule files stays bounded. */
const MAX_RULES = 40;
/** Cap raw ledger bytes read before parsing (bounded cost even for a huge hand-edited file). */
const MAX_LOOPS_RAW = 20000;
/** Cap how many loop lines the boot section lists (bounded count, mirrors MAX_RULES). */
const MAX_LOOP_ITEMS = 12;
/** Cap the rendered open-loops section itself (bounded chars, a slice of the overall MAX_BOOT budget). */
const MAX_LOOP_SECTION = 1500;

/**
 * Compose a concise "memory preamble" from the vault's `_system/` layer so the
 * agent boots with the user's context, preferences, and active rules. The agent can
 * read deeper on demand via the read_note tool.
 */
export async function readBootContext(app: App): Promise<string> {
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

  const log = await read("_system/memory/session-log.md", 1200);
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

  if (!parts.length) return "";

  return cap(
    [
      "## Vault memory — you are Exo, embedded in this Obsidian vault.",
      "Honor these conventions: prefer the `mcp__obsidian__*` tools for vault operations (they respect links/tags/frontmatter); follow the tag system (#type/*, #status/*, #domain/*) and the object schema; use [[wikilinks]] for internal references; never create files at the vault root.",
      "Precedence: the sections below (especially `Recent sessions`) are BACKGROUND from prior sessions. The conversation you are in right now is authoritative — when the user says 'continue', refers to 'the proposed/other things', 'as above', or otherwise points back, resolve it from the CURRENT conversation's own history, never from a prior session's topic.",
      ...parts,
    ].join("\n\n"),
    MAX_BOOT
  );
}
