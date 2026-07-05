/**
 * Dream Pass v2 — proposal validation + negative-selection gate (pure).
 *
 * "LLM proposes, kernel disposes." The LLM stage emits ONLY typed proposals; this
 * module (no Obsidian imports) hard-validates them, culls the dangerous ones with
 * a deterministic gate that runs BEFORE anything is shown, and maps the survivors
 * to concrete append-only store writes. All model output flows through here, so
 * the model can never directly mutate memory.
 *
 * Proposal schema (fixed by spec — validate hard, reject the WHOLE batch on any
 * mismatch):
 *   { kind: "merge",      keepId, dropIds[],  reason }
 *   { kind: "supersede",  newText, supersedesId, reason }
 *   { kind: "rule_draft", slug, text, evidenceIds[], reason }
 *   { kind: "import",     claudememId, text, reason }
 */

import { formatEntry, monthFileName, type MemoryEntry } from "./memory-store";

export type Proposal =
  | { kind: "merge"; keepId: string; dropIds: string[]; reason: string }
  | { kind: "supersede"; newText: string; supersedesId: string; reason: string }
  | { kind: "rule_draft"; slug: string; text: string; evidenceIds: string[]; reason: string }
  | { kind: "import"; claudememId: number; text: string; reason: string };

export type ParseResult = { ok: true; proposals: Proposal[] } | { ok: false; error: string };

export interface CulledProposal {
  proposal: Proposal;
  reason: string;
}

export interface GateContext {
  /** Ids of store entries with `source: user` — never merge-away/supersede these. */
  userEntryIds: Set<string>;
  /** Truth-firewall patterns from `_system/memory/known-false.md`. */
  knownFalse: RegExp[];
  /** Canonical keys of proposals already applied on a prior run (dedup). */
  appliedKeys: Set<string>;
}

export interface GateResult {
  kept: Proposal[];
  culled: CulledProposal[];
}

export interface DreamCounts {
  merged: number;
  superseded: number;
  ruleDrafts: number;
  imported: number;
}

/* ------------------------------ parsing --------------------------------- */

function extractJsonObject(raw: string): unknown | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

const isNonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isNonEmptyStr);

/** Validate one raw item into a typed Proposal, or null if it violates the schema. */
function validateProposal(item: unknown): Proposal | null {
  if (typeof item !== "object" || item === null) return null;
  const p = item as Record<string, unknown>;
  if (!isStr(p.reason)) return null;
  switch (p.kind) {
    case "merge":
      if (!isNonEmptyStr(p.keepId)) return null;
      if (!isStrArray(p.dropIds) || p.dropIds.length === 0) return null;
      return { kind: "merge", keepId: p.keepId, dropIds: p.dropIds, reason: p.reason };
    case "supersede":
      if (!isNonEmptyStr(p.newText) || !isNonEmptyStr(p.supersedesId)) return null;
      return { kind: "supersede", newText: p.newText, supersedesId: p.supersedesId, reason: p.reason };
    case "rule_draft":
      if (!isNonEmptyStr(p.slug) || !isNonEmptyStr(p.text)) return null;
      if (!Array.isArray(p.evidenceIds) || !p.evidenceIds.every(isStr)) return null;
      return { kind: "rule_draft", slug: p.slug, text: p.text, evidenceIds: p.evidenceIds as string[], reason: p.reason };
    case "import":
      if (typeof p.claudememId !== "number" || !Number.isFinite(p.claudememId)) return null;
      if (!isNonEmptyStr(p.text)) return null;
      return { kind: "import", claudememId: p.claudememId, text: p.text, reason: p.reason };
    default:
      return null;
  }
}

/**
 * Parse the LLM's raw output into a validated proposal batch. Tolerant of prose /
 * code fences around the JSON object, but STRICT on schema: any single malformed
 * proposal rejects the WHOLE batch (`ok: false`) so a partial hallucination can
 * never be half-applied. The caller logs the raw output on rejection.
 */
export function parseProposals(raw: string): ParseResult {
  if (!raw || typeof raw !== "string") return { ok: false, error: "empty output" };
  const obj = extractJsonObject(raw);
  if (typeof obj !== "object" || obj === null) return { ok: false, error: "no JSON object" };
  const proposalsRaw = (obj as Record<string, unknown>).proposals;
  if (!Array.isArray(proposalsRaw)) return { ok: false, error: "no proposals array" };
  const proposals: Proposal[] = [];
  for (const item of proposalsRaw) {
    const valid = validateProposal(item);
    if (!valid) return { ok: false, error: "schema mismatch" };
    proposals.push(valid);
  }
  return { ok: true, proposals };
}

/* --------------------------- known-false parse -------------------------- */

/**
 * Parse `_system/memory/known-false.md` into a tolerant regex list: one pattern
 * per non-blank, non-`#`-comment line, compiled case-insensitive. A line that is
 * not a valid regex is SKIPPED (never crashes the pass).
 */
export function parseKnownFalse(content: string): RegExp[] {
  if (!content) return [];
  const out: RegExp[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    try {
      out.push(new RegExp(trimmed, "i"));
    } catch {
      /* malformed regex — skip this line */
    }
  }
  return out;
}

/* -------------------------------- gate ---------------------------------- */

/** The store-entry ids a proposal would supersede/merge away (the ones at risk). */
function supersededTargets(p: Proposal): string[] {
  if (p.kind === "merge") return [p.keepId, ...p.dropIds];
  if (p.kind === "supersede") return [p.supersedesId];
  return []; // import / rule_draft never supersede an existing entry
}

/** The free-text a proposal would introduce (checked against the truth firewall). */
function proposalText(p: Proposal): string {
  if (p.kind === "supersede") return p.newText;
  if (p.kind === "rule_draft") return p.text;
  if (p.kind === "import") return p.text;
  return ""; // merge introduces no new text (it keeps the survivor's verbatim text)
}

/** Canonical identity of a proposal, stable across runs — the dedup key. */
export function proposalKey(p: Proposal): string {
  switch (p.kind) {
    case "merge":
      return `merge:${p.keepId}:${[...p.dropIds].sort().join(",")}`;
    case "supersede":
      return `supersede:${p.supersedesId}:${p.newText.trim()}`;
    case "rule_draft":
      return `rule_draft:${p.slug}`;
    case "import":
      return `import:${p.claudememId}`;
  }
}

/**
 * Negative-selection gate. Runs BEFORE the preview and culls any proposal that
 * (a) would merge away or supersede a `source: user` entry, (b) introduces text
 * matching a known-false pattern, or (c) duplicates an already-applied proposal.
 * Culled proposals are returned (with a reason) for transparent display and are
 * NEVER applied. Each proposal is checked independently — one bad apple doesn't
 * cull the batch (that's parsing's job).
 */
export function runGate(proposals: Proposal[], ctx: GateContext): GateResult {
  const kept: Proposal[] = [];
  const culled: CulledProposal[] = [];
  for (const p of proposals) {
    const userHit = supersededTargets(p).find((id) => ctx.userEntryIds.has(id));
    if (userHit) {
      culled.push({ proposal: p, reason: `would touch @user entry ${userHit}` });
      continue;
    }
    const text = proposalText(p);
    const falseHit = text ? ctx.knownFalse.find((re) => re.test(text)) : undefined;
    if (falseHit) {
      culled.push({ proposal: p, reason: `matches known-false pattern /${falseHit.source}/` });
      continue;
    }
    if (ctx.appliedKeys.has(proposalKey(p))) {
      culled.push({ proposal: p, reason: "already applied on a previous run" });
      continue;
    }
    kept.push(p);
  }
  return { kept, culled };
}

/* ------------------------------ summary --------------------------------- */

export function summarizeProposals(proposals: Proposal[]): DreamCounts {
  const c: DreamCounts = { merged: 0, superseded: 0, ruleDrafts: 0, imported: 0 };
  for (const p of proposals) {
    if (p.kind === "merge") c.merged++;
    else if (p.kind === "supersede") c.superseded++;
    else if (p.kind === "rule_draft") c.ruleDrafts++;
    else if (p.kind === "import") c.imported++;
  }
  return c;
}

/** Descriptive commit summary, omitting zero parts (Letta context-repository style). */
export function formatDreamSummary(c: DreamCounts): string {
  const parts: string[] = [];
  if (c.merged > 0) parts.push(`merged ${c.merged}`);
  if (c.superseded > 0) parts.push(`superseded ${c.superseded}`);
  if (c.ruleDrafts > 0) parts.push(`drafted ${c.ruleDrafts} rule candidate${c.ruleDrafts === 1 ? "" : "s"}`);
  if (c.imported > 0) parts.push(`imported ${c.imported} from claude-mem`);
  return parts.length ? `dream — ${parts.join(", ")}` : "dream — no changes";
}

/* ---------------------------- planLlmWrites ----------------------------- */

export interface RuleDraftWrite {
  slug: string;
  text: string;
  evidenceIds: string[];
}

export interface LlmWritePlan {
  /** New `@generated` entries to append to the store, in order. */
  storeEntries: MemoryEntry[];
  /** Candidate rule-draft files to write under `_system/memory/learnings/`. */
  ruleDrafts: RuleDraftWrite[];
  /** claude-mem observation ids imported this run — advance the watermark ONLY on apply. */
  importedIds: number[];
  /** proposalKey of every proposal actually planned (persist for dedup). */
  keys: string[];
  summary: DreamCounts;
}

export interface PlanContext {
  /** Base epoch (ms) for new `mem-<id>` ids — one slot per new entry. */
  now: number;
  session: string;
  /** All current store entries (active + superseded) for survivor/kind/tags lookup. */
  storeEntries: MemoryEntry[];
}

/**
 * Map gate-survivor proposals to concrete append-only writes. Pure — no IO — so
 * the mapping (supersedence links, provenance, survivor-text selection) is fully
 * unit-tested; the Obsidian side just enacts the returned plan through the queue.
 */
export function planLlmWrites(kept: Proposal[], ctx: PlanContext): LlmWritePlan {
  const byId = new Map(ctx.storeEntries.map((e) => [e.id, e] as const));
  const storeEntries: MemoryEntry[] = [];
  const ruleDrafts: RuleDraftWrite[] = [];
  const importedIds: number[] = [];
  const keys: string[] = [];
  const summary: DreamCounts = { merged: 0, superseded: 0, ruleDrafts: 0, imported: 0 };

  const nextEntry = (over: Partial<MemoryEntry> & Pick<MemoryEntry, "kind" | "text">): MemoryEntry => {
    const at = ctx.now + storeEntries.length;
    return { id: `mem-${at}`, at, session: ctx.session, tags: [], source: "generated", ...over };
  };

  for (const p of kept) {
    if (p.kind === "merge") {
      const survivor = byId.get(p.keepId);
      if (!survivor) continue; // defensive: survivor gone — skip rather than fabricate
      storeEntries.push(
        nextEntry({
          kind: survivor.kind,
          tags: survivor.tags,
          text: survivor.text,
          supersedes: [p.keepId, ...p.dropIds].join(", "),
        })
      );
      summary.merged++;
      keys.push(proposalKey(p));
    } else if (p.kind === "supersede") {
      const target = byId.get(p.supersedesId);
      storeEntries.push(
        nextEntry({
          kind: target?.kind ?? "fact",
          tags: target?.tags ?? [],
          text: p.newText,
          supersedes: p.supersedesId,
        })
      );
      summary.superseded++;
      keys.push(proposalKey(p));
    } else if (p.kind === "import") {
      storeEntries.push(nextEntry({ kind: "fact", text: p.text, origin: `claude-mem:${p.claudememId}` }));
      importedIds.push(p.claudememId);
      summary.imported++;
      keys.push(proposalKey(p));
    } else if (p.kind === "rule_draft") {
      ruleDrafts.push({ slug: p.slug, text: p.text, evidenceIds: p.evidenceIds });
      summary.ruleDrafts++;
      keys.push(proposalKey(p));
    }
  }

  return { storeEntries, ruleDrafts, importedIds, keys, summary };
}

/* ------------------------- serialization helpers ------------------------ */

/** The monthly store file a batch of new entries lands in (all share `now`'s month). */
export function targetStoreFile(now: number): string {
  return monthFileName(now);
}

/** Render new store entries as a block to append (blank-line separated, trailing newline). */
export function renderStoreBlock(entries: MemoryEntry[]): string {
  return entries.map(formatEntry).join("\n\n");
}
