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
}

export interface AssembledContext {
  /** The context block to prepend to the user's text; "" when there is none. */
  block: string;
  /** Paths that made it into the block (order preserved). */
  includedPaths: string[];
  /** Subset of `includedPaths` whose body was inlined. */
  injectedContentPaths: string[];
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
  const sections: string[] = [];

  if (input.paths.length) {
    if (input.injectContent) {
      // Inline each note body the model shouldn't have to fetch. Missing content
      // degrades to a bare-path line collected into a trailing list.
      const inlined: string[] = [];
      const bare: string[] = [];
      for (const p of input.paths) {
        includedPaths.push(p);
        const body = input.contents?.[p];
        if (typeof body === "string") {
          injectedContentPaths.push(p);
          inlined.push(`Context note "${p}":\n${body.trim()}`);
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
    includedSelection,
    selectionChars,
  };
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
