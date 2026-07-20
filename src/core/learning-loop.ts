/**
 * Learning loop (pure).
 *
 * LEGACY (retired 2026-07-20, P4-T03): the recurrence-ledger + inline-nudge path
 * (`turnQualifies`, `buildDistillPrompt`, `parseDistillReply`, `recordTurnSignal`,
 * `signalLabel`, `topicKeywords`, `anchors`) is no longer wired into the turn
 * loop — the Workflow Foundry now distills playbooks through the Proposal Kernel
 * (`foundry-distill.ts`). These exports are kept only for their tests and a
 * possible migration. `uniquePlaybookName` is the exception: it is STILL live,
 * imported by `obsidian/proposal-targets.ts` for collision-safe playbook saves.
 *
 * After a successful, substantial turn, Exo offered to save the flow as a
 * reusable playbook (Hermes pattern — from "remembering" to "learning how to
 * do"). The proposal card was free (no tokens); the LLM distillation ran only
 * when the user accepted.
 *
 * This module owns the three testable decisions: does a turn qualify, what
 * does the distillation pass get asked, and how is its reply parsed.
 */

export interface TurnStats {
  /** Turn finished healthy (not stopped, not poisoned by an execution error). */
  ok: boolean;
  toolCount: number;
  distinctTools: number;
  durationMs: number;
  userText: string;
}

/** A turn is worth proposing when it was real work (several tool calls across
 *  more than one tool, long enough to not be a one-shot lookup) and the user
 *  wasn't already running a command/playbook. Thresholds are deliberately
 *  conservative — a noisy nudge would get the feature turned off. */
export function turnQualifies(s: TurnStats): boolean {
  if (!s.ok) return false;
  if (s.userText.trim().startsWith("/")) return false; // already a command/playbook
  return s.toolCount >= 5 && s.distinctTools >= 2 && s.durationMs >= 30_000;
}

export interface DistillInput {
  userText: string;
  /** One line per tool call, e.g. "search_vault: Captoo GTM" (capped by caller). */
  toolLines: string[];
  /** The turn's final assistant text (capped by caller). */
  finalText: string;
}

/** The utility-pass prompt: strict JSON out, so parsing is mechanical. */
export function buildDistillPrompt(input: DistillInput): string {
  return `You are distilling a completed AI-agent task into a REUSABLE playbook prompt.

The user asked:
"""
${input.userText.slice(0, 1200)}
"""

The agent's tool calls (in order):
${input.toolLines.join("\n")}

The agent's final answer began:
"""
${input.finalText.slice(0, 1200)}
"""

Write a reusable playbook that would reproduce this KIND of task on future inputs — generalize away the specifics of this one run (names, dates, single files) but keep the method: which sources to consult, in what order, what to produce. Use {{placeholders}} only if the task genuinely needs a variable input. Write the prompt in the same language as the user's request.

Reply with ONLY a JSON object, no markdown fences, exactly:
{"name": "<3-5 word title>", "prompt": "<the reusable playbook prompt, 3-10 sentences>"}`;
}

/** Tolerant parse of the distillation reply: find the JSON object, validate
 *  shapes and sane lengths. Null on anything off — the caller shows a soft
 *  failure, never a broken playbook. */
export function parseDistillReply(raw: string): { name: string; prompt: string } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const { name, prompt } = obj as { name?: unknown; prompt?: unknown };
  if (typeof name !== "string" || typeof prompt !== "string") return null;
  const cleanName = name.trim().slice(0, 60);
  const cleanPrompt = prompt.trim();
  if (!cleanName || cleanPrompt.length < 30 || cleanPrompt.length > 4000) return null;
  return { name: cleanName, prompt: cleanPrompt };
}

/* ------------------- recurrence: topic fingerprint ------------------- */
// A playbook is worth proposing only for a task you do REPEATEDLY. Instead of
// nudging after one substantial turn (which is almost always a one-off), Exo
// keeps a lightweight, token-free ledger fingerprinting each qualifying turn by
// TOPIC — the salient words of your request — and proposes only when the same
// topic recurs (rule of three). Matching anchors on "entity" words (length ≥ 5:
// linkedin, pricing, captoo…) so "write a LinkedIn post on X" and "draft a
// LinkedIn post on Y" cluster on `linkedin`, while short/generic words don't.

const FP_STOP = new Set([
  // EN function words
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "is", "it",
  "as", "by", "be", "we", "with", "this", "that", "from", "into", "your", "you",
  // IT function words
  "il", "lo", "la", "le", "gli", "un", "uno", "una", "di", "da", "con", "su",
  "per", "tra", "fra", "che", "chi", "non", "si", "se", "ma", "ed", "al", "del",
  "come", "sul", "nel", "una", "dei", "delle", "questo", "questa",
  // generic task words that would over-merge unrelated tasks
  "nota", "note", "file", "cosa", "cose", "roba", "lavoro", "fai", "fare",
  "make", "help", "want", "need", "thing", "stuff",
]);

const ANCHOR_MIN_LEN = 5;

function fpFold(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Light IT/EN suffix trim so plural/inflected forms fingerprint the same. */
function fpStem(w: string): string {
  if (w.length <= 4) return w;
  for (const suf of ["ing", "zione", "mente", "es", "hi", "he", "s", "i", "e", "o", "a"]) {
    if (w.length - suf.length >= 4 && w.endsWith(suf)) return w.slice(0, w.length - suf.length);
  }
  return w;
}

/** The salient keywords of a request — its topic fingerprint. Folded and
 *  stopword-filtered but kept in READABLE (unstemmed) form: stemming happens
 *  only at match time (see {@link sharedAnchors}) so `captoo` stays `captoo` in
 *  storage and labels while `prodotti`/`prodotto` still match. */
export function topicKeywords(text: string): string[] {
  const words = (fpFold(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (w) => w.length >= 3 && !FP_STOP.has(w),
  );
  return [...new Set(words)];
}

/** Anchors = the entity-ish keywords a topic is recognised by. */
export function anchors(keywords: string[]): string[] {
  return keywords.filter((w) => w.length >= ANCHOR_MIN_LEN);
}

export interface PlaybookSignal {
  /** Union of topic keywords seen across this cluster's turns. */
  keywords: string[];
  count: number;
  lastSeen: number;
  /** Up to 3 verbatim example requests, for the proposal preview. */
  examples: string[];
  /** Already nudged for this cluster — never propose the same one twice. */
  proposed: boolean;
}

export interface SignalLedger {
  signals: PlaybookSignal[];
}

export const EMPTY_LEDGER: SignalLedger = { signals: [] };

export interface RecordResult {
  ledger: SignalLedger;
  /** Set when THIS turn pushed a topic to the threshold — the card to show. */
  proposal: PlaybookSignal | null;
}

export interface RecordOptions {
  /** Recurrences before proposing (rule of three). */
  threshold?: number;
  /** Max clusters kept (oldest low-count pruned beyond this). */
  maxSignals?: number;
}

function trimExample(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 200);
}

/** Count of shared anchors between a turn and a cluster, comparing STEMMED forms
 *  so `prodotti` and `prodotto` count as the same anchor. */
function sharedAnchors(turnAnchors: string[], clusterKeywords: string[]): number {
  const set = new Set(clusterKeywords.map(fpStem));
  return turnAnchors.filter((a) => set.has(fpStem(a))).length;
}

/**
 * Fingerprint one qualifying turn and fold it into the ledger. A turn matches an
 * existing cluster when they share ≥1 anchor (the cluster with the most shared
 * anchors wins); otherwise it opens a new cluster. Returns a proposal only the
 * first time a cluster reaches `threshold`. Turns with no anchor (too thin/
 * generic to recognise) are ignored — never fingerprinted, never proposed.
 * Pure: never mutates the input ledger.
 */
export function recordTurnSignal(
  ledger: SignalLedger,
  userText: string,
  now: number,
  opts: RecordOptions = {},
): RecordResult {
  const threshold = opts.threshold ?? 3;
  const maxSignals = opts.maxSignals ?? 200;
  const kw = topicKeywords(userText);
  const turnAnchors = anchors(kw);
  if (turnAnchors.length === 0) return { ledger, proposal: null };

  const signals = ledger.signals.map((s) => ({
    ...s,
    keywords: [...s.keywords],
    examples: [...s.examples],
  }));

  let bestIdx = -1;
  let bestShared = 0;
  signals.forEach((s, i) => {
    const shared = sharedAnchors(turnAnchors, s.keywords);
    if (shared > bestShared) {
      bestShared = shared;
      bestIdx = i;
    }
  });

  let cluster: PlaybookSignal;
  if (bestIdx >= 0 && bestShared >= 1) {
    cluster = signals[bestIdx]!;
    cluster.keywords = [...new Set([...cluster.keywords, ...kw])];
    cluster.count += 1;
    cluster.lastSeen = now;
    if (cluster.examples.length < 3) cluster.examples.push(trimExample(userText));
  } else {
    cluster = { keywords: kw, count: 1, lastSeen: now, examples: [trimExample(userText)], proposed: false };
    signals.push(cluster);
  }

  let proposal: PlaybookSignal | null = null;
  if (cluster.count >= threshold && !cluster.proposed) {
    cluster.proposed = true;
    proposal = cluster;
  }

  // Prune: keep the strongest/most-recent clusters, always retaining the one we
  // just touched so accumulation never loses the active topic.
  let kept = signals;
  if (signals.length > maxSignals) {
    const ranked = [...signals].sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);
    kept = ranked.slice(0, maxSignals);
    if (!kept.includes(cluster)) kept = [cluster, ...kept.slice(0, maxSignals - 1)];
  }

  return { ledger: { signals: kept }, proposal };
}

/** A short human label for a topic cluster — its most salient anchors. */
export function signalLabel(signal: PlaybookSignal): string {
  const a = anchors(signal.keywords);
  return (a.length ? a : signal.keywords).slice(0, 3).join(", ");
}

/** Dedup a proposed name against existing playbooks: "Name", "Name 2", "Name 3"… */
export function uniquePlaybookName(name: string, existing: string[]): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
