/**
 * The Agent Is the Folder — pure identity core (NO `obsidian` imports).
 *
 * The agent folder (`paths.agentDir`) is the vault's tool-agnostic identity layer: a manifest plus
 * three char-limited Markdown blocks (`persona.md`, `human.md`, `now.md`). Exo is
 * the single owner — it hydrates them at boot and maintains them through the
 * governed `rethink_memory` tool and observer proposals; external tools (Claude
 * Code, Codex, Cowork) read them at boot but never write. Single-writer,
 * many-readers (design `2026-07-10-agent-folder-design`).
 *
 * This module owns everything about identity that can be reasoned about without
 * Obsidian, so it is fully unit-testable:
 *
 *   - the block registry (names, advisory char limits, ownership tiers);
 *   - `parseManifest` — tolerant, hardcoded-default on corruption;
 *   - `compileIdentity(blocks, opts)` — assembles the identity SECTION prepended
 *     to the boot preamble: order persona → human → now, each headed and stamped
 *     with an "(updated N days ago)" staleness marker when its mtime is known,
 *     over-limit blocks included WHOLE with an over-budget warning (advisory
 *     limits never truncate a block), missing/blank blocks skipped silently, and
 *     an arbitration line appended so the blocks win any later conflict.
 *
 * The Obsidian-side wiring (reading the block files + mtimes, the boot overlay,
 * the `rethink_memory` tool, observer `now.md` proposals) lives in
 * `src/obsidian/memory.ts` / `src/obsidian/tools.ts` / `src/view.ts`.
 */

import { exoPaths, LEGACY_MEMORY_ROOT } from "./paths";

/** The three identity blocks, in the fixed compile order persona → human → now. */
export type BlockName = "persona" | "human" | "now";

/**
 * Ownership tier for a block's autonomous rewrite policy (design §3):
 *  - `rewrite`                — agent rewrites freely (low risk, high turnover). `now.md`.
 *  - `rewrite-with-rationale` — agent rewrites; the feed diff must surface the rationale. `human.md`.
 *  - `propose-only`           — v1: the tool records a pending proposal; the write
 *                               happens only on the user's Apply click. `persona.md`.
 */
export type BlockOwner = "rewrite" | "rewrite-with-rationale" | "propose-only";

/** Static registry entry for one block. */
export interface BlockSpec {
  name: BlockName;
  /** Advisory char limit — overflow WARNS, never truncates (non-negotiable #2). */
  limit: number;
  owner: BlockOwner;
  /** The heading rendered above the block in the compiled identity section. */
  heading: string;
}

/**
 * The canonical block registry — the single source of truth for names, advisory
 * char limits, ownership tiers, and headings. Order here IS the compile order.
 */
export const AGENT_BLOCKS: readonly BlockSpec[] = [
  { name: "persona", limit: 1500, owner: "propose-only", heading: "Persona — how you behave" },
  { name: "human", limit: 2000, owner: "rewrite-with-rationale", heading: "Human — who you work with" },
  { name: "now", limit: 1500, owner: "rewrite", heading: "Now — what matters right now" },
] as const;

/** Block names in compile order — `["persona", "human", "now"]`. */
export const AGENT_BLOCK_NAMES: readonly BlockName[] = AGENT_BLOCKS.map((b) => b.name);

/** Legacy default identity-layer folder — tests/fallback only;
 *  live callers derive the folder from the configured `paths.agentDir`. */
export const AGENT_DIR = exoPaths(LEGACY_MEMORY_ROOT).agentDir;

/** Current on-disk format version the manifest documents. */
export const AGENT_FORMAT_VERSION = 1;

/** The arbitration line appended to the identity section: the blocks win any
 *  conflict with a later boot section. Exported so the compiler and its tests
 *  share one source of truth. */
export const IDENTITY_ARBITRATION_LINE =
  "If these identity blocks conflict with any later section, the blocks win.";

/** Look up a block's static spec by name. */
export function blockSpec(name: BlockName): BlockSpec {
  const spec = AGENT_BLOCKS.find((b) => b.name === name);
  // AGENT_BLOCK_NAMES is exhaustive over BlockName, so this never throws in practice.
  if (!spec) throw new Error(`unknown agent block: ${name}`);
  return spec;
}

/** True for a string that is one of the three identity block names. */
export function isAgentBlock(s: string): s is BlockName {
  return (AGENT_BLOCK_NAMES as readonly string[]).includes(s);
}

/** The rewrite policy for a block — the tier `rethink_memory` enforces. */
export function rethinkPolicy(name: BlockName): BlockOwner {
  return blockSpec(name).owner;
}

/* ---------------------------- rethink plan ------------------------------ */

/**
 * The action `rethink_memory` should take for a block, decided purely from its
 * ownership tier (design §3). The Obsidian tool enacts the plan; this keeps the
 * tier policy fully unit-testable and impossible to drift per call-site:
 *  - `write`        — rewrite `now.md` freely; render a feed diff + undo.
 *  - `write`+rationale — rewrite `human.md`; the feed diff must surface the rationale.
 *  - `propose`      — record a pending `persona.md` proposal card; write only on Apply.
 */
export type RethinkAction =
  | { verb: "write"; block: BlockName; requireRationale: false }
  | { verb: "write"; block: BlockName; requireRationale: true }
  | { verb: "propose"; block: BlockName };

/**
 * Map a target block to its rethink action from the registry's ownership tier.
 * Unknown block names are rejected upstream by {@link isAgentBlock}; this assumes
 * a valid block.
 */
export function planRethink(block: BlockName): RethinkAction {
  switch (rethinkPolicy(block)) {
    case "rewrite":
      return { verb: "write", block, requireRationale: false };
    case "rewrite-with-rationale":
      return { verb: "write", block, requireRationale: true };
    case "propose-only":
      return { verb: "propose", block };
  }
}

/* ------------------------------ manifest -------------------------------- */

/** The parsed manifest contract. */
export interface Manifest {
  version: number;
  blocks: BlockSpec[];
}

/** The hardcoded default manifest — the fallback on empty/corrupt input (§8). */
export function defaultManifest(): Manifest {
  return { version: AGENT_FORMAT_VERSION, blocks: AGENT_BLOCKS.map((b) => ({ ...b })) };
}

/** Parse one `| block | limit | owner |` table row into a spec override, or null. */
function parseManifestRow(line: string): Partial<BlockSpec> & { name: BlockName } | null {
  const cells = line.split("|").map((c) => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
  if (cells.length < 1) return null;
  const name = cells[0].toLowerCase();
  if (!isAgentBlock(name)) return null;
  const out: Partial<BlockSpec> & { name: BlockName } = { name };
  const limit = Number.parseInt(cells[1] ?? "", 10);
  if (Number.isFinite(limit) && limit > 0) out.limit = limit;
  return out;
}

/**
 * Tolerant manifest parser. Reads a `version:` line and an optional
 * `| block | limit | owner |` table, merging any well-formed rows over the
 * canonical defaults. ANY corruption (empty input, no rows, garbage) degrades to
 * {@link defaultManifest} — never throws (§8). Owners are NOT taken from the file:
 * ownership tiers are a code-level invariant (the truth firewall of identity), so
 * a hand-edit can nudge a limit but can never widen a block's write policy.
 */
export function parseManifest(content: string): Manifest {
  const base = defaultManifest();
  if (!content || typeof content !== "string") return base;

  let version = base.version;
  const vMatch = /^\s*version:\s*(\d+)\s*$/im.exec(content);
  if (vMatch) {
    const v = Number.parseInt(vMatch[1], 10);
    if (Number.isFinite(v) && v > 0) version = v;
  }

  const overrides = new Map<BlockName, Partial<BlockSpec>>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const row = parseManifestRow(trimmed);
    if (row) overrides.set(row.name, row);
  }

  const blocks = base.blocks.map((b) => {
    const o = overrides.get(b.name);
    return o ? { ...b, ...(o.limit ? { limit: o.limit } : {}) } : b;
  });
  return { version, blocks };
}

/* ------------------------------- seeder --------------------------------- */

/** Escape a literal string for embedding in a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Fence delimiters for one distilled block in the seeder's LLM output. */
const SEED_OPEN = (name: BlockName): string => `<<<${name}>>>`;
const SEED_CLOSE = (name: BlockName): string => `<<<end-${name}>>>`;

/** The raw source material the seeder distills the three blocks FROM. */
export interface SeedSources {
  /** The mental-model note (`paths.mentalModel`). */
  mentalModel: string;
  /** The preferences note (`paths.preferences`). */
  preferences: string;
  /** The vault-context note (`paths.vaultContext`). */
  vaultContext: string;
}

/**
 * Build the one-shot seeder prompt (design §6). The frontier model is asked to
 * DISTILL — not copy — the three identity blocks from the vault's existing
 * scattered files, each within its advisory limit, and return them in fenced
 * sections this module can parse deterministically. The per-block char budgets
 * come straight from the registry, so a limit change here needs no prompt edit.
 */
export function buildSeedPrompt(sources: SeedSources): string {
  const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
  const persona = blockSpec("persona").limit;
  const human = blockSpec("human").limit;
  const now = blockSpec("now").limit;
  return [
    "You are seeding a tool-agnostic identity layer for an AI knowledge partner named Exo, embedded",
    "in the user's Obsidian vault. Distill THREE short Markdown blocks from the source material below.",
    "Distill — do NOT copy: each block is a tight, self-contained brief, not an excerpt dump.",
    "",
    `1. persona — how Exo behaves (tone, style, non-negotiables). Max ${persona} chars.`,
    `2. human — a distilled working model of the USER (who they are, what they do, how they work). Max ${human} chars.`,
    `3. now — what matters right now (hot projects, current focus, live context). Max ${now} chars.`,
    "",
    "Return EACH block wrapped in its own fence, exactly:",
    `${SEED_OPEN("persona")}\n…persona markdown…\n${SEED_CLOSE("persona")}`,
    `${SEED_OPEN("human")}\n…human markdown…\n${SEED_CLOSE("human")}`,
    `${SEED_OPEN("now")}\n…now markdown…\n${SEED_CLOSE("now")}`,
    "No prose outside the fences. Keep each block within its char limit.",
    "",
    "=== SOURCE: mental model of the user ===",
    cap(sources.mentalModel, 6000),
    "",
    "=== SOURCE: preferences ===",
    cap(sources.preferences, 6000),
    "",
    "=== SOURCE: vault context ===",
    cap(sources.vaultContext, 6000),
  ].join("\n");
}

/**
 * Parse the seeder's fenced output into `{ persona, human, now }`. Tolerant: a
 * missing block is simply absent from the map (the caller writes only what came
 * back); each captured body is trimmed. Never throws.
 */
export function parseSeedBlocks(raw: string): Partial<Record<BlockName, string>> {
  const out: Partial<Record<BlockName, string>> = {};
  if (!raw || typeof raw !== "string") return out;
  for (const name of AGENT_BLOCK_NAMES) {
    const re = new RegExp(
      `${escapeRe(SEED_OPEN(name))}([\\s\\S]*?)${escapeRe(SEED_CLOSE(name))}`
    );
    const m = re.exec(raw);
    if (m) {
      const body = m[1].trim();
      if (body) out[name] = body;
    }
  }
  return out;
}

/** The `manifest.md` contract document written by the seeder (design §1/§7). */
export function manifestContent(): string {
  const rows = AGENT_BLOCKS.map(
    (b) => `| ${b.name}.md | ${b.limit} | ${b.owner} |`
  ).join("\n");
  return [
    "---",
    "created_by: exo",
    "tags:",
    "  - type/context",
    "---",
    "",
    "# Agent identity — manifest",
    "",
    `version: ${AGENT_FORMAT_VERSION}`,
    "",
    "This folder is the vault's **tool-agnostic identity layer**. It holds three short",
    "Markdown blocks that give Exo — and any external agent that touches the vault",
    "(Claude Code, Codex, Cowork) — a coherent sense of who the user is and how to behave.",
    "",
    "## Blocks",
    "",
    "| block | char limit | owner policy |",
    "|---|---|---|",
    rows,
    "",
    "- `persona.md` — how the agent behaves (tone, style, non-negotiables).",
    "- `human.md` — a distilled working model of the user (not a copy of source notes).",
    "- `now.md` — what matters right now (hot projects, focus, live context).",
    "",
    "## Contract",
    "",
    "- **Exo owns maintenance.** It hydrates these blocks at boot and updates them",
    "  through the governed `rethink_memory` tool and observer proposals.",
    "- **External tools: read, don't write.** Read all three blocks at boot to",
    "  understand who the user is; never edit them — Exo is the single writer.",
    "- **Hand-edits by the user are always welcome** — these are plain Markdown,",
    "  git-versioned, and editable at any time.",
    "- Char limits are **advisory**: overflow warns, it never truncates a block.",
  ].join("\n");
}

/* --------------------------- compileIdentity ---------------------------- */

/** One identity block as read from the vault, ready to compile. */
export interface IdentityBlock {
  name: BlockName;
  /** The raw block content (may be empty/whitespace when missing). */
  content: string;
  /** Last-modified time in epoch ms, or `undefined` when unknown (marker omitted). */
  mtime?: number;
}

/** Options for {@link compileIdentity}. */
export interface CompileOpts {
  /** "Now" in epoch ms — the reference point for staleness markers (injectable for tests). */
  now: number;
}

/** Whole days between two epoch-ms timestamps, floored, never negative. */
function daysSince(mtime: number, now: number): number {
  return Math.max(0, Math.floor((now - mtime) / 86_400_000));
}

/** The "(updated …)" staleness suffix for a block, or "" when the mtime is unknown. */
function stalenessMarker(mtime: number | undefined, now: number): string {
  if (mtime === undefined || !Number.isFinite(mtime)) return "";
  const d = daysSince(mtime, now);
  if (d === 0) return " (updated today)";
  if (d === 1) return " (updated 1 day ago)";
  return ` (updated ${d} days ago)`;
}

/**
 * Compile the three identity blocks into the section prepended to the boot
 * preamble (design §2). Contract:
 *  - Order is ALWAYS persona → human → now (the registry order), independent of
 *    the input array's order.
 *  - Each present block is rendered under its heading, stamped with an "(updated
 *    N days ago)" marker when its mtime is known.
 *  - An over-limit block is included WHOLE (verbatim) with an `⚠ over budget`
 *    marker — advisory limits warn, they never truncate a block (non-negotiable #2).
 *  - A missing/blank block is skipped silently (no empty heading).
 *  - When at least one block survives, the arbitration line is appended.
 *  - When EVERY block is missing/blank, the result is the empty string — so the
 *    boot overlay adds nothing (the flag-ON-but-no-folder case is byte-identical
 *    to no identity section at all).
 */
export function compileIdentity(blocks: readonly IdentityBlock[], opts: CompileOpts): string {
  const byName = new Map(blocks.map((b) => [b.name, b] as const));
  const sections: string[] = [];

  for (const spec of AGENT_BLOCKS) {
    const b = byName.get(spec.name);
    const content = (b?.content ?? "").trim();
    if (!content) continue; // missing/blank → skip silently

    const marker = stalenessMarker(b?.mtime, opts.now);
    const over = content.length > spec.limit ? "  ⚠ over budget — trim this block" : "";
    sections.push(`#### ${spec.heading}${marker}${over}\n${content}`);
  }

  if (sections.length === 0) return "";

  return [
    "## Identity — you are Exo, and this is who you are and who you serve.",
    IDENTITY_ARBITRATION_LINE,
    ...sections,
  ].join("\n\n");
}
