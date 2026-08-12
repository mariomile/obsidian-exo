/**
 * Pure assembly of the "active context" block that rides on the OUTBOUND provider
 * message — the single source of truth for what the model actually receives as
 * context.
 *
 * WHY THIS EXISTS (2026-07-30): the composer showed context in the UI (a
 * "Current Document" card, manual attachments, and an ambient "Selection" chip)
 * but two things never reached the prompt:
 *   1. Attached notes were sent as *paths only* — the model got a filename and
 *      had to remember to read it, so open pages were weakly "considered".
 *   2. The ambient selection chip was pure UI: `currentSelection` was read only
 *      by the renderer, never by the serializer → the highlighted text was shown
 *      as active context but never sent.
 *
 * Both bugs were "display-state ≠ send-state" disconnects. Centralising the
 * serialization here (and binding it to the exact same selection the chip shows)
 * makes the two states impossible to drift apart, and makes the whole thing
 * unit-testable without mounting Obsidian.
 */

export interface ContextSelection {
  text: string;
  path: string;
}

export interface AssembleContextInput {
  /** Attached note paths (active note first, then manual attachments), in order. */
  paths: string[];
  /** The ambient selection mirrored by the composer chip, or null when none. */
  selection: ContextSelection | null;
  /** When true, inline note bodies (from `contents`) instead of bare paths. */
  injectContent: boolean;
  /**
   * path -> body, supplied by the caller when `injectContent` is on. A path with
   * no entry here falls back to a bare-path line, so a failed/oversized read
   * degrades gracefully rather than dropping the note entirely.
   */
  contents?: Record<string, string>;
  /**
   * Per-note ceiling on an inlined body (chars). Over-cap bodies are cut with an
   * explicit marker pointing at the note, because the model can always read the
   * rest on demand via its file tools: bounded injection, unbounded access.
   * Absent → unbounded (legacy behaviour, byte-identical).
   */
  maxCharsPerNote?: number;
  /**
   * Paths whose body was already inlined earlier in THIS conversation and whose
   * file is unchanged since (the caller checks mtime, see `selectUnchangedPaths`).
   * They degrade to an annotated pointer line: the content already lives in the
   * transcript, so re-inlining pays for the same bytes every turn. An edited note
   * must NOT be in this set: staleness beats savings.
   */
  unchangedPaths?: ReadonlySet<string>;
}

export interface AssembledContext {
  /** The context block to prepend to the user's text; "" when there is none. */
  block: string;
  /** Paths that made it into the block (order preserved). */
  includedPaths: string[];
  /** Subset of `includedPaths` whose body was inlined. */
  injectedContentPaths: string[];
  /** Subset of `injectedContentPaths` whose body was cut at `maxCharsPerNote`. */
  truncatedPaths: string[];
  /** Paths that degraded to a pointer because their unchanged body was already sent. */
  reusedPaths: string[];
  /** Whether the ambient selection was serialized. */
  includedSelection: boolean;
  /** Character count of the serialized selection (0 when none). */
  selectionChars: number;
}

/** Last path segment, without a leading `./`. Kept local so this module has no deps. */
function basename(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = clean.lastIndexOf("/");
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

/** Render text as a Markdown blockquote (matches the in-note "Ask Exo" grammar). */
function blockquote(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

export function assembleContext(input: AssembleContextInput): AssembledContext {
  const includedPaths: string[] = [];
  const injectedContentPaths: string[] = [];
  const truncatedPaths: string[] = [];
  const reusedPaths: string[] = [];
  const sections: string[] = [];

  if (input.paths.length) {
    if (input.injectContent) {
      // Inline each note body the model shouldn't have to fetch. Missing content
      // degrades to a bare-path line collected into a trailing list.
      const inlined: string[] = [];
      const bare: string[] = [];
      for (const p of input.paths) {
        includedPaths.push(p);
        if (input.unchangedPaths?.has(p)) {
          reusedPaths.push(p);
          bare.push(`- ${p} (content already provided earlier in this conversation)`);
          continue;
        }
        const body = input.contents?.[p];
        if (typeof body === "string") {
          injectedContentPaths.push(p);
          let text = body.trim();
          const cap = input.maxCharsPerNote;
          if (cap !== undefined && text.length > cap) {
            text = `${text.slice(0, cap)}\n…[truncated, read "${p}" for the rest]`;
            truncatedPaths.push(p);
          }
          inlined.push(`Context note "${p}":\n${text}`);
        } else {
          bare.push(`- ${p}`);
        }
      }
      if (inlined.length) sections.push(inlined.join("\n\n"));
      if (bare.length) sections.push(`Context notes:\n${bare.join("\n")}`);
    } else {
      for (const p of input.paths) includedPaths.push(p);
      sections.push(`Context notes:\n${input.paths.map((p) => `- ${p}`).join("\n")}`);
    }
  }

  let includedSelection = false;
  let selectionChars = 0;
  const selText = input.selection?.text ?? "";
  if (selText.trim()) {
    includedSelection = true;
    selectionChars = selText.length;
    const from = input.selection?.path ? basename(input.selection.path) : "the current note";
    sections.push(`Selected text (from "${from}"):\n${blockquote(selText)}`);
  }

  return {
    block: sections.join("\n\n"),
    includedPaths,
    injectedContentPaths,
    truncatedPaths,
    reusedPaths,
    includedSelection,
    selectionChars,
  };
}

/**
 * Which of this turn's attached notes can degrade to a pointer: the ones whose
 * body was already inlined into an earlier outbound turn of this conversation AND
 * whose file has not been modified since.
 *
 * Every unusable mtime (0, NaN, absent) degrades to "changed", so the fallback is
 * always to re-inline. The alternative failure mode would be serving the model a
 * body it never received, or a stale one, to save bytes: not a trade worth making.
 * This is not hypothetical: the repo's own Obsidian mock hands back
 * `stat = { mtime: 0 }`, and equality alone would call that pair unchanged.
 */
export function selectUnchangedPaths(
  noteMtimes: Record<string, number | undefined>,
  stamped: ReadonlyMap<string, number> | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!stamped) return out;
  for (const [p, mtime] of Object.entries(noteMtimes)) {
    if (typeof mtime !== "number" || !Number.isFinite(mtime) || mtime <= 0) continue;
    if (stamped.get(p) === mtime) out.add(p);
  }
  return out;
}

export interface ContextDebugInput {
  /** A short label for the turn (e.g. a counter or convo id). */
  turnLabel: string;
  /** What the UI chips are advertising this turn. */
  chips: { doc: string | null; manual: string[]; selectionChars: number | null };
  /** The assembled result actually serialized into the outbound message. */
  assembled: AssembledContext;
  /** Byte length of the full outbound payload. */
  outboundBytes: number;
}

/**
 * Build the `[Exo][ctx]` debug line: chips (what you SEE) vs the serialized block
 * (what the model GETS), so a display-state≠send-state disconnect is obvious at a
 * glance in the devtools console.
 */
export function formatContextDebug(d: ContextDebugInput): string {
  const chipSel =
    d.chips.selectionChars != null ? `"…"(${d.chips.selectionChars}ch)` : "none";
  const selLine = d.assembled.includedSelection
    ? `selection included: yes (${d.assembled.selectionChars}ch)`
    : d.chips.selectionChars != null
      ? `selection NOT included ✖ (chip shows ${d.chips.selectionChars}ch)`
      : "selection included: no";
  const contentLine = d.assembled.injectedContentPaths.length
    ? `content injected: ${d.assembled.injectedContentPaths.join(", ")}`
    : "content injected: none (paths only)";
  const serialized = d.assembled.block
    ? d.assembled.block
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n")
    : "    (empty)";
  return [
    `[Exo][ctx] ${d.turnLabel}`,
    `  UI chips:  doc=${d.chips.doc ?? "none"}, manual=[${d.chips.manual.join(", ")}], selection=${chipSel}`,
    `  SERIALIZED → model:`,
    serialized,
    `  ${selLine}; ${contentLine}`,
    `  outbound bytes: ${d.outboundBytes}`,
  ].join("\n");
}
