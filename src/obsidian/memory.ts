import { App, TFile } from "obsidian";
import { parseLoopsFile, activeLoops, dueLoops, type LoopEntry } from "../core/open-loops";
import {
  AGENT_BLOCKS,
  compileIdentity,
  type IdentityBlock,
} from "../core/agent-self";
import type { ExoPaths } from "../core/paths";
import { bootFileHead } from "../core/boot-content";
import { stripFrontmatter } from "../core/agents";
import type { MemoryCaps } from "../core/memory-caps";
import { autoMemoryNote, agentFolderNote } from "../core/memory-prompts";

const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + "\n…(truncated)" : s);

/** Hard ceiling on the assembled preamble so a large vault can't blow the context budget.
 *  Raised to {@link MAX_BOOT_AGENT} ONLY when the agent-folder flag is ON — with the flag
 *  OFF this stays the historical value so the output is provably byte-identical. */
const MAX_BOOT = 9000;
/** Preamble ceiling when the agent folder is ON — room for the prepended identity section. */
const MAX_BOOT_AGENT = 12000;
/** Cap the rules list so a vault with dozens of rule files stays bounded. */
const MAX_RULES = 40;
/** Cap the rules-index note read into the boot section (bounded chars, same idea
 *  as the other head-slices below). */
const MAX_RULES_INDEX = 1500;
/** Cap how many loop lines the boot section lists (bounded count, mirrors MAX_RULES). */
const MAX_LOOP_ITEMS = 12;
/** Cap the rendered open-loops section itself (bounded chars, a slice of the overall MAX_BOOT budget). */
const MAX_LOOP_SECTION = 1500;
/** Options for {@link readBootContext}. Absent/false → no identity section. */
export interface BootOpts {
  /** Prepend the agent folder (`memoryCaps(...).identity`). */
  identity?: boolean;
}

/**
 * Compose a concise "memory preamble" from the vault's memory layer so the
 * agent boots with the user's context, preferences, and active rules. The agent can
 * read deeper on demand via the read_note tool.
 *
 * When `identity` is ON, the compiled identity section (from the agent folder)
 * is prepended BEFORE every existing section and the overall cap widens to
 * {@link MAX_BOOT_AGENT}. When OFF (or absent), none of the folder is read and the
 * output is byte-identical to before this feature existed (seam test).
 */
export async function readBootContext(app: App, paths: ExoPaths, opts: BootOpts = {}): Promise<string> {
  // Head-slices are frontmatter-free: the boot budget buys content, never YAML.
  const read = async (path: string, max: number): Promise<string> => {
    const f = app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      try {
        return bootFileHead(await app.vault.cachedRead(f), max);
      } catch {
        /* ignore */
      }
    }
    return "";
  };
  // Frontmatter-stripped, UNTRUNCATED — for files that must be parsed whole
  // before any cap is applied (open loops: a loop past a raw-char cutoff would
  // never reach the parser, regardless of how few loops the rendered section keeps).
  const readFull = async (path: string): Promise<string> => {
    const f = app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      try {
        return stripFrontmatter(await app.vault.cachedRead(f));
      } catch {
        /* ignore */
      }
    }
    return "";
  };

  // Identity overlay (design §4) — read the three blocks + mtimes here (impure);
  // compilation is the pure `compileIdentity`. OFF → identity is "", so nothing
  // below changes.
  const agentOn = opts.identity === true;
  let identity = "";
  if (agentOn) {
    const blocks: IdentityBlock[] = [];
    for (const spec of AGENT_BLOCKS) {
      const path = `${paths.agentDir}/${spec.name}.md`;
      const f = app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) continue;
      try {
        const content = await app.vault.cachedRead(f);
        blocks.push({ name: spec.name, content, mtime: f.stat?.mtime });
      } catch {
        /* unreadable block — skip silently (§8) */
      }
    }
    identity = compileIdentity(blocks, { now: Date.now() });
  }

  const parts: string[] = [];
  const ctx = await read(paths.vaultContext, 3500);
  if (ctx) parts.push(`### Vault context\n${ctx}`);
  const prefs = await read(paths.preferences, 2500);
  if (prefs) parts.push(`### Preferences\n${prefs}`);

  // The index carries the trigger for each rule (when to load it) — a bare file-name
  // list never does, so the model can't tell which rules apply without reading every
  // one. Prefer it; fall back to the name list when no index exists.
  const rulesIndex = await read(`${paths.rules}/_index.md`, MAX_RULES_INDEX);
  if (rulesIndex) {
    parts.push(`### Active rules (index — read the file for detail)\n${rulesIndex}`);
  } else {
    const rulesPrefix = `${paths.rules}/`;
    const ruleFiles = app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(rulesPrefix));
    const rules = ruleFiles.slice(0, MAX_RULES).map((f) => `- ${f.basename}`);
    if (ruleFiles.length > MAX_RULES) rules.push(`- …and ${ruleFiles.length - MAX_RULES} more`);
    if (rules.length) parts.push(`### Active rules (read the file for detail)\n${rules.join("\n")}`);
  }

  const loopsRaw = await readFull(paths.openLoops);
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
      "Honor these conventions: prefer the `mcp__obsidian__*` tools for vault operations (they respect links/tags/frontmatter); follow the tag system (#type/*, #domain/*), track status via the `status:` frontmatter property, and the object schema; use [[wikilinks]] for internal references; never create files at the vault root.",
      "Precedence: the sections below are BACKGROUND from prior sessions. The conversation you are in right now is authoritative: when the user says 'continue', refers to 'the proposed/other things', 'as above', or otherwise points back, resolve it from the CURRENT conversation's own history, never from a prior session's topic.",
      ...parts,
    ].join("\n\n"),
    maxBoot
  );
}

/** Everything the boot preamble depends on besides the files it reads. */
export interface PreambleInputs {
  caps: MemoryCaps;
  /** The Obsidian tool server is registered for this session. */
  tools: boolean;
  paths: ExoPaths;
}

/** The full session preamble: vault memory plus the standing memory notes.
 *  "" when boot reads are off. */
export async function buildBootPreamble(app: App, inputs: PreambleInputs): Promise<string> {
  const { caps, tools, paths } = inputs;
  if (!caps.bootRead) return "";
  const parts = [await readBootContext(app, paths, { identity: caps.identity })];
  if (caps.autoCapture || caps.autoRecall) {
    parts.push(autoMemoryNote({ recall: caps.autoRecall, chats: tools && caps.chatSearch }));
  }
  if (tools && caps.rethink) parts.push(agentFolderNote(paths.agentDir));
  return parts.filter(Boolean).join("\n\n");
}

/** Cache key: the inputs plus the mtime of every file the preamble reads, so an
 *  edit to a memory note, a caps change, or a new memory root rebuilds it. */
function preambleKey(app: App, inputs: PreambleInputs): string {
  const { paths } = inputs;
  const sources = [
    paths.vaultContext,
    paths.preferences,
    `${paths.rules}/_index.md`,
    paths.openLoops,
    ...AGENT_BLOCKS.map((spec) => `${paths.agentDir}/${spec.name}.md`),
  ];
  const mtimes = sources.map((path) => {
    const f = app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f.stat?.mtime ?? 0 : -1;
  });
  return JSON.stringify([inputs.caps, inputs.tools, paths.root, mtimes]);
}

/** One per view: rebuilds only when {@link preambleKey} changes. */
export class BootPreambleCache {
  private key: string | null = null;
  private value = "";

  async get(app: App, inputs: PreambleInputs): Promise<string> {
    const key = preambleKey(app, inputs);
    if (key !== this.key) {
      this.value = await buildBootPreamble(app, inputs);
      this.key = key;
    }
    return this.value;
  }
}
