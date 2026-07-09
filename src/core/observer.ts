/**
 * Self-Writing Memory — pure observer core (NO `obsidian` imports).
 *
 * After a healthy chat turn, a cheap background model reads a capped digest of
 * the exchange and proposes candidate durable memories. This module owns every
 * piece of that pipeline that can be reasoned about without Obsidian:
 *
 *   - `buildObserverPrompt(digest)` — prompt construction from a truncated turn.
 *   - `parseObserverOutput(raw)`   — tolerant parser: JSON array, fenced JSON,
 *                                    prose-wrapped JSON, or a line format. Never
 *                                    throws; `[]` on garbage; hard caps enforced.
 *   - `shouldSkipTurn(digest)`     — cheap skip heuristic for trivial turns.
 *   - `dedupeCandidates(...)`      — drop near-duplicates of recalled entries.
 *
 * The Obsidian-side wiring (session spawn, write-queue, veto UI) lives in
 * `src/obsidian/observer.ts`.
 */

import { isMemoryKind, type MemoryKind } from "./memory-store";

/** Hard char cap on the user half of the digest fed to the observer prompt. */
export const MAX_USER_CHARS = 4000;
/** Hard char cap on the assistant half of the digest fed to the observer prompt. */
export const MAX_ASSISTANT_CHARS = 4000;
/** Max candidate memories accepted from a single turn (extras are dropped). */
export const MAX_CANDIDATES = 4;
/** Max chars kept for any one candidate's verbatim-leaning text (truncated). */
export const MAX_CANDIDATE_TEXT_CHARS = 400;
/** Below this combined user+assistant length a turn is too trivial to observe. */
export const MIN_TURN_CHARS = 60;

/** A capped snapshot of a completed turn. */
export interface TurnDigest {
  user: string;
  assistant: string;
}

/** A candidate durable memory proposed by the observer. */
export interface Candidate {
  kind: MemoryKind;
  /** Short, verbatim-leaning statement of the memory. */
  text: string;
  tags: string[];
}

/**
 * Delimiters wrapping a proactive-recall injection in the OUTBOUND turn (see the
 * send path in `view.ts`). Exported so the send path, the observer strip guard,
 * and their tests share one source of truth for the fence.
 */
export const RECALLED_MEMORY_OPEN = "[recalled-memory]";
export const RECALLED_MEMORY_CLOSE = "[/recalled-memory]";

/** Matches one `[recalled-memory]…[/recalled-memory]` block, or an unterminated
 *  open fence to end-of-string (defensive: a malformed injection must not leak). */
const RECALLED_MEMORY_BLOCK = new RegExp(
  `${escapeRe(RECALLED_MEMORY_OPEN)}[\\s\\S]*?(?:${escapeRe(RECALLED_MEMORY_CLOSE)}|$)`,
  "g"
);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Observer feedback-loop guard (design §3). Strip every proactive-recall
 * `[recalled-memory]…[/recalled-memory]` block from a piece of turn text BEFORE
 * the observer extracts memories from it. Without this, memory the plugin
 * injected into the outbound turn would be re-observed and re-captured as "new"
 * memory — a self-reinforcing duplication loop. Pure and idempotent; a message
 * with no block is returned unchanged.
 */
export function stripRecalledMemory(text: string): string {
  if (!text) return text;
  return text.replace(RECALLED_MEMORY_BLOCK, "");
}

/** Collapse runaway whitespace and hard-cap a string. */
function cap(s: string, n: number): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}

/**
 * Build the observer prompt from a capped digest. The model is asked to return
 * a JSON array of durable-memory candidates, each `{ kind, text, tags }`.
 */
export function buildObserverPrompt(digest: TurnDigest): string {
  // Strip proactive-recall injections BEFORE the observer sees them (§3 guard) —
  // injected memory must never be re-extracted as new memory.
  const user = cap(stripRecalledMemory(digest.user), MAX_USER_CHARS);
  const assistant = cap(digest.assistant, MAX_ASSISTANT_CHARS);
  return [
    "You are a memory observer. Read one chat turn between a user and an assistant and extract",
    "any DURABLE memories worth remembering across future sessions — stable preferences, lasting",
    "facts, decisions, or lessons. Ignore ephemeral chatter, one-off requests, and anything that",
    "will not still be true next week.",
    "",
    `Return ONLY a JSON array (max ${MAX_CANDIDATES} items). Each item is an object with:`,
    '  - "kind": one of "preference", "fact", "decision", "lesson"',
    '  - "text": a short, verbatim-leaning statement of the memory (one sentence)',
    '  - "tags": an array of 0-3 short lowercase tags',
    "If there is nothing durable to remember, return an empty array [].",
    "Do not invent memories. Prefer the user's own words. No prose outside the JSON.",
    "",
    `User: ${user}`,
    "",
    `Assistant: ${assistant}`,
  ].join("\n");
}

/** Normalize one raw object into a Candidate, or null if unusable. */
function normalizeCandidate(raw: unknown): Candidate | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const kind = typeof obj.kind === "string" ? obj.kind.trim().toLowerCase() : "";
  if (!isMemoryKind(kind)) return null;
  const text = typeof obj.text === "string" ? obj.text.trim().slice(0, MAX_CANDIDATE_TEXT_CHARS) : "";
  if (!text) return null;
  const tags = Array.isArray(obj.tags)
    ? obj.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean)
    : [];
  return { kind: kind as MemoryKind, text, tags };
}

/** Pull a JSON array substring out of arbitrary text (fences, prose). */
function extractJsonArray(raw: string): unknown[] | null {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Line format: `kind: text | tag1, tag2` or `- [kind] text`. A bracketed kind
 * needs no separator; a bare kind must be followed by `:` or `-`.
 */
const LINE_RE =
  /^\s*(?:[-*]\s*)?(?:\[(preference|fact|decision|lesson)\]|(preference|fact|decision|lesson)\s*[:-])\s*(.+)$/i;

function parseLineFormat(raw: string): unknown[] {
  const out: unknown[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const kind = (m[1] ?? m[2]).toLowerCase();
    let text = m[3].trim();
    let tags: string[] = [];
    const bar = text.lastIndexOf(" | ");
    if (bar !== -1) {
      tags = text
        .slice(bar + 3)
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      text = text.slice(0, bar).trim();
    }
    out.push({ kind, text, tags });
  }
  return out;
}

/**
 * Tolerant parser. Accepts a JSON array, JSON wrapped in code fences or prose,
 * or a simple line format. Never throws; returns `[]` on garbage. Enforces the
 * per-turn count cap, the per-candidate text cap, and drops invalid kinds.
 */
export function parseObserverOutput(raw: string): Candidate[] {
  if (!raw || typeof raw !== "string") return [];
  const rawItems = extractJsonArray(raw) ?? parseLineFormat(raw);
  const candidates: Candidate[] = [];
  for (const item of rawItems) {
    const c = normalizeCandidate(item);
    if (c) candidates.push(c);
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates;
}

/**
 * Skip trivial turns before spending a model call: empty sides, pure slash
 * commands, or exchanges below the combined-length threshold.
 */
export function shouldSkipTurn(digest: TurnDigest): boolean {
  // Recall injections are stripped first (§3 guard): a turn whose only novel user
  // content is an injected block collapses to empty here and is skipped, so the
  // injected memory can never be re-captured.
  const user = stripRecalledMemory(digest.user ?? "").trim();
  const assistant = (digest.assistant ?? "").trim();
  if (!user || !assistant) return true;
  if (user.startsWith("/")) return true; // pure slash command — nothing durable
  if (user.length + assistant.length < MIN_TURN_CHARS) return true;
  return false;
}

/** Lowercase alphanumeric token set for similarity comparison. */
function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

/** Normalized-string similarity: substring containment OR high token overlap. */
function similar(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const nb = b.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 && inter / union >= 0.8; // Jaccard overlap
}

/**
 * Drop candidates that near-duplicate an existing recalled entry (passed as
 * plain strings) or an earlier candidate in the same batch.
 */
export function dedupeCandidates(candidates: Candidate[], existing: readonly string[]): Candidate[] {
  const kept: Candidate[] = [];
  for (const c of candidates) {
    const dupOfExisting = existing.some((e) => similar(c.text, e));
    const dupOfKept = kept.some((k) => similar(c.text, k.text));
    if (!dupOfExisting && !dupOfKept) kept.push(c);
  }
  return kept;
}
