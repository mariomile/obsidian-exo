/**
 * Pure logic for the in-note AI ("Inline AI") feature — no DOM, no CodeMirror,
 * no Obsidian imports, so it's unit-testable in isolation.
 *
 * Two responsibilities:
 *  1. Prompt building for the Edit / Continue actions (shared by the plugin's
 *     transient streaming sessions and the legacy inline-edit modal).
 *  2. Turning a rewrite into an ordered list of accept/reject hunks, so the UI
 *     can render an inline diff and reconstruct the final text from per-hunk
 *     decisions. v1 accepts/rejects the whole edit, but the hunk model is the
 *     seam that per-hunk accept slots into later.
 */

export interface DiffSeg {
  type: "same" | "add" | "del";
  text: string;
}

/**
 * Word-level diff via LCS. Returns ordered segments for rendering. Lives here
 * (pure) and is re-exported from `ui/inline-edit.ts` for the modal + note-diff.
 */
export function wordDiff(a: string, b: string): DiffSeg[] {
  const split = (s: string) => s.split(/(\s+)/).filter((t) => t.length > 0);
  const aw = split(a);
  const bw = split(b);
  const n = aw.length;
  const m = bw.length;
  // Guard: the LCS matrix is O(n*m). For very large inputs (e.g. diffing a whole
  // big note) skip it and show a coarse whole-block replacement instead of
  // freezing the UI allocating tens of millions of cells.
  const MAX_DIFF_CELLS = 2_000_000;
  if (n * m > MAX_DIFF_CELLS) {
    if (a === b) return [{ type: "same", text: a }];
    const coarse: DiffSeg[] = [];
    if (a) coarse.push({ type: "del", text: a });
    if (b) coarse.push({ type: "add", text: b });
    return coarse;
  }
  // LCS table
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aw[i] === bw[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffSeg[] = [];
  const push = (type: DiffSeg["type"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aw[i] === bw[j]) {
      push("same", aw[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("del", aw[i++]);
    } else {
      push("add", bw[j++]);
    }
  }
  while (i < n) push("del", aw[i++]);
  while (j < m) push("add", bw[j++]);
  return out;
}

/**
 * One piece of a diffed rewrite. `context` is unchanged text shared by both
 * sides; `hunk` is a change with a stable `index`, the removed `before` text
 * and the added `after` text. Rendering walks the parts in order; applying
 * walks them and, per hunk, emits `after` (accepted) or `before` (rejected).
 */
export type DiffPart =
  | { kind: "context"; text: string }
  | { kind: "hunk"; index: number; before: string; after: string };

/**
 * Split a rewrite into ordered accept/reject hunks. Consecutive add/del
 * segments collapse into a single hunk (so a replaced phrase is one decision,
 * not one-per-word). A pure insertion has `before === ""`; a pure deletion has
 * `after === ""`.
 */
export function computeHunks(original: string, revised: string): DiffPart[] {
  const segs = wordDiff(original, revised);
  const parts: DiffPart[] = [];
  let index = 0;
  let before = "";
  let after = "";
  let pending = false;
  const flush = () => {
    if (!pending) return;
    parts.push({ kind: "hunk", index: index++, before, after });
    before = "";
    after = "";
    pending = false;
  };
  for (const s of segs) {
    if (s.type === "same") {
      flush();
      parts.push({ kind: "context", text: s.text });
    } else if (s.type === "del") {
      before += s.text;
      pending = true;
    } else {
      after += s.text;
      pending = true;
    }
  }
  flush();
  return parts;
}

/**
 * Reconstruct text from diff parts given a per-hunk accept predicate. Accepted
 * hunks contribute their `after`; rejected ones their `before`. Context always
 * passes through. `applyDiff(parts, () => true)` === the revised text;
 * `applyDiff(parts, () => false)` === the original.
 */
export function applyDiff(parts: DiffPart[], accepted: (index: number) => boolean): string {
  let out = "";
  for (const p of parts) {
    out += p.kind === "context" ? p.text : accepted(p.index) ? p.after : p.before;
  }
  return out;
}

/** Number of change hunks in a parts list (context excluded). */
export function hunkCount(parts: DiffPart[]): number {
  let n = 0;
  for (const p of parts) if (p.kind === "hunk") n++;
  return n;
}

/**
 * Map each hunk onto document offsets, given the doc position `from` where the
 * diffed region starts (the start of the original selection). Walking the parts
 * in order: `context` and a hunk's `before` consume ORIGINAL characters (advance
 * the offset); a hunk's `after` consumes none (it's an inserted widget, not in
 * the doc yet). For each hunk we emit its `before` doc range and the `at` offset
 * — the end of that before-range — where the `after` widget is inserted.
 *
 * Pure counterpart to the decoration layer: the CM6 field turns these ranges
 * into a `Decoration.mark` over `before` and `Decoration.widget` at `at`.
 *
 *  - pure insertion (`before === ""`): `before.from === before.to === at`.
 *  - pure deletion (`after === ""`): `at === before.to`, no widget text.
 *  - replace: `before` spans the removed text, `at` is its end.
 */
export function hunkDocRanges(
  from: number,
  parts: DiffPart[]
): { index: number; before: { from: number; to: number }; at: number }[] {
  const ranges: { index: number; before: { from: number; to: number }; at: number }[] = [];
  let offset = from;
  for (const p of parts) {
    if (p.kind === "context") {
      offset += p.text.length;
    } else {
      const start = offset;
      const end = offset + p.before.length;
      ranges.push({ index: p.index, before: { from: start, to: end }, at: end });
      offset = end; // `before` consumed; `after` (widget) consumes nothing
    }
  }
  return ranges;
}

/**
 * Move a hunk cursor over the contiguous hunk-index space `[0, hunkCount-1]`.
 * Hunks from `computeHunks` are numbered 0..n-1, so navigation is plain integer
 * stepping. We **clamp** at the ends (no wrap) — landing on the first/last hunk
 * and pressing again is a no-op, which reads as "you're at the edge" rather than
 * silently teleporting across the document. Empty parts → 0.
 */
export function nextHunk(parts: DiffPart[], current: number, dir: 1 | -1): number {
  const n = hunkCount(parts);
  if (n === 0) return 0;
  const next = current + dir;
  if (next < 0) return 0;
  if (next > n - 1) return n - 1;
  return next;
}

/**
 * Prompt for the Edit action: apply a free-text INSTRUCTION to a TEXT selection
 * and return only the rewritten text. Shared by `oneShot` (modal) and
 * `oneShotStream` (inline) so the wording has a single source of truth.
 */
export function buildEditPrompt(instruction: string, text: string): string {
  return (
    "You are an inline text editor inside Obsidian. Apply the instruction to the TEXT and return ONLY " +
    "the resulting text — no preamble, no explanation, no code fences, no quotes.\n\n" +
    `Instruction: ${instruction}\n\nTEXT:\n${text}`
  );
}

/**
 * Prompt for the Continue action: keep writing from where TEXT stops, in the
 * same voice, returning ONLY the new continuation (never repeating the input).
 */
export function buildContinuePrompt(precedingText: string): string {
  return (
    "You are an inline writing assistant inside Obsidian, continuing a note from where it stops. " +
    "Continue in the same voice, tense, and formatting. Return ONLY the new text to append after the " +
    "TEXT — no preamble, no repetition of the TEXT, no explanation, no code fences, no quotes.\n\n" +
    `TEXT SO FAR:\n${precedingText}`
  );
}
