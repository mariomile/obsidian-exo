import { App, TFile } from "obsidian";
import type { WriteQueue } from "../core/write-queue";
import { parseStoreFile, resolveSupersedence, type MemoryEntry } from "../core/memory-store";
import {
  parseProposals,
  parseKnownFalse,
  runGate,
  planLlmWrites,
  type Proposal,
  type CulledProposal,
  type LlmWritePlan,
} from "../core/dream-proposals";
import type { ClaudeMemObservation } from "../core/claudemem-reader";
import { exoPaths, LEGACY_MEMORY_ROOT, type ExoPaths } from "../core/paths";

/** Legacy defaults for tests/fallback; the live plugin passes `plugin.paths`. */
const LEGACY_PATHS = exoPaths(LEGACY_MEMORY_ROOT);

/** Transient, tool-less utility pass (the observer chassis, generalized). */
export type RunUtilityPass = (prompt: string, opts: { signal: AbortSignal; model?: string }) => Promise<string>;

/** Per-entry text cap in the prompt, to keep the input bounded. */
const ENTRY_TEXT_CAP = 400;
const OBS_TEXT_CAP = 300;

export interface DreamLlmDeps {
  app: App;
  runUtilityPass: RunUtilityPass;
  queue: WriteQueue;
  /** Up to N=100 unimported claude-mem observations (read by the W2-1 caller). */
  observations: ClaudeMemObservation[];
  /** Canonical keys of proposals applied on previous runs (dedup). */
  appliedKeys: Set<string>;
  /** `memoryFileBudget` — over this, the prompt asks for defrag merges. */
  memoryFileBudget: number;
  signal: AbortSignal;
  /** Base epoch for new entry ids + run timestamp. */
  now: number;
  session: string;
  model?: string;
  /** Resolved memory-layer paths. Absent → the legacy root (test/fallback). */
  paths?: ExoPaths;
}

export interface DreamLlmResult {
  kept: Proposal[];
  culled: CulledProposal[];
  /** Deterministic defrag pre-check verdict (store or learnings over budget). */
  defrag: boolean;
  /** Pre-computed append-only write plan for the kept proposals. */
  writePlan: LlmWritePlan;
  /** All current store entries (for downstream apply/undo bookkeeping). */
  storeEntries: MemoryEntry[];
  /** Raw model output — logged verbatim when the batch is rejected. */
  raw: string;
  /** Set when the batch was rejected (schema mismatch / no output). */
  error?: string;
}

/** Read + parse every monthly store file into entries (active + superseded). */
export async function collectStoreEntries(app: App, storeDir: string = LEGACY_PATHS.store): Promise<MemoryEntry[]> {
  const files = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(`${storeDir}/`));
  const all: MemoryEntry[] = [];
  for (const f of files) {
    try {
      all.push(...parseStoreFile(await app.vault.cachedRead(f)));
    } catch {
      /* skip unreadable file */
    }
  }
  return all;
}

/** Markdown files directly under a memory-layer directory. */
function filesIn(app: App, dir: string): TFile[] {
  return app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(dir + "/"));
}

/** Read the truth-firewall patterns; empty list when the file is absent. */
async function readKnownFalse(app: App, knownFalsePath: string): Promise<RegExp[]> {
  try {
    const adapter = app.vault.adapter;
    if (!(await adapter.exists(knownFalsePath))) return [];
    return parseKnownFalse(await adapter.read(knownFalsePath));
  } catch {
    return [];
  }
}

const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + "…" : s);

/**
 * Build the LLM input (pure). Lists active store entries, learnings filenames, and
 * unimported claude-mem candidates, then demands ONLY the strict proposal JSON. A
 * `defrag` flag injects an explicit "propose merges to reduce sprawl" instruction.
 */
export function buildDreamPrompt(input: {
  activeEntries: MemoryEntry[];
  learningFiles: string[];
  observations: ClaudeMemObservation[];
  defrag: boolean;
}): string {
  const { activeEntries, learningFiles, observations, defrag } = input;
  const lines: string[] = [];
  lines.push(
    "You are Exo's memory dream stage. Reason over the memory below and propose ONLY consolidation changes.",
    "You PROPOSE; a deterministic kernel disposes. Never invent facts. Prefer the user's own words.",
    "",
    "Return ONLY a JSON object of this exact shape (no prose, no code fences):",
    '{ "proposals": [',
    '  { "kind": "merge", "keepId": "mem-…", "dropIds": ["mem-…"], "reason": "…" },',
    '  { "kind": "supersede", "newText": "…", "supersedesId": "mem-…", "reason": "…" },',
    '  { "kind": "rule_draft", "slug": "…", "text": "…", "evidenceIds": ["mem-…"], "reason": "…" },',
    '  { "kind": "import", "claudememId": 123, "text": "…", "reason": "…" }',
    "] }",
    "- merge: collapse duplicate store entries (keepId survives; dropIds are retired).",
    "- supersede: replace an outdated entry's content with newText.",
    "- rule_draft: draft a reusable rule candidate from repeated evidence (NOT a final rule).",
    "- import: bring a durable claude-mem observation into the store verbatim.",
    "Only reference ids that appear below. Return an empty proposals array if nothing is worth changing.",
    ""
  );
  if (defrag) {
    lines.push(
      "DEFRAG: the memory layer is over its file budget. Actively propose merges to reduce entry/file sprawl.",
      ""
    );
  }
  lines.push("## Store entries (active)");
  if (activeEntries.length === 0) lines.push("(none)");
  for (const e of activeEntries) {
    lines.push(`- ${e.id} [${e.kind}, @${e.source}]: ${truncate(e.text.replace(/\s+/g, " ").trim(), ENTRY_TEXT_CAP)}`);
  }
  lines.push("", "## Learnings files");
  lines.push(learningFiles.length ? learningFiles.map((f) => `- ${f}`).join("\n") : "(none)");
  lines.push("", "## claude-mem candidates (unimported)");
  if (observations.length === 0) lines.push("(none)");
  for (const o of observations) {
    const body = truncate([o.title, o.subtitle, o.narrative].filter(Boolean).join(" — ").replace(/\s+/g, " ").trim(), OBS_TEXT_CAP);
    lines.push(`- claudememId ${o.id} [${o.type}]: ${body}`);
  }
  return lines.join("\n");
}

/**
 * Run the LLM proposal stage end-to-end (assemble → model → parse → gate → plan).
 * The budget must already be checked by the caller BEFORE invoking this. Never
 * throws: on rejected/empty output it returns `error` set with `raw` for logging
 * and an empty write plan, so apply is a guaranteed no-op (zero writes).
 */
export async function runDreamLlm(deps: DreamLlmDeps): Promise<DreamLlmResult> {
  const paths = deps.paths ?? LEGACY_PATHS;
  const storeEntries = await collectStoreEntries(deps.app, paths.store);
  const active = resolveSupersedence(storeEntries);
  const learningFiles = filesIn(deps.app, paths.learnings).map((f) => f.name);
  const storeCount = filesIn(deps.app, paths.store).length;
  const defrag = storeCount > deps.memoryFileBudget || learningFiles.length > deps.memoryFileBudget;

  const empty: LlmWritePlan = {
    storeEntries: [],
    ruleDrafts: [],
    importedIds: [],
    keys: [],
    summary: { merged: 0, superseded: 0, ruleDrafts: 0, imported: 0 },
  };

  const prompt = buildDreamPrompt({ activeEntries: active, learningFiles, observations: deps.observations, defrag });
  const raw = await deps.runUtilityPass(prompt, { signal: deps.signal, model: deps.model });

  const parsed = parseProposals(raw);
  if (!parsed.ok) {
    // Reject the WHOLE batch — zero writes — and log the raw output for forensics.
    console.warn(`[Exo] dream-llm rejected batch (${parsed.error}). Raw output follows:\n${raw}`);
    return { kept: [], culled: [], defrag, writePlan: empty, storeEntries, raw, error: parsed.error };
  }

  const knownFalse = await readKnownFalse(deps.app, paths.knownFalse);
  const userEntryIds = new Set(storeEntries.filter((e) => e.source === "user").map((e) => e.id));
  const { kept, culled } = runGate(parsed.proposals, { userEntryIds, knownFalse, appliedKeys: deps.appliedKeys });
  const writePlan = planLlmWrites(kept, { now: deps.now, session: deps.session, storeEntries });

  return { kept, culled, defrag, writePlan, storeEntries, raw };
}
