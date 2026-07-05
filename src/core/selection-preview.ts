/** Format an editor selection into a compact chip preview.
 *
 *  Drives the composer's "current selection" chip: a one-line label (the first
 *  non-empty line, truncated with an ellipsis) plus a short count summary. The
 *  label collapses internal whitespace so a multi-space or tab-indented line
 *  still reads as one tidy line; the count reports lines when the selection
 *  spans more than one line, otherwise characters. Pure + deterministic so it's
 *  unit-tested independently of the DOM. */

/** Max chars shown in the chip label before eliding with an ellipsis. */
const MAX_LABEL = 50;

export interface SelectionPreview {
  /** One-line, whitespace-collapsed, ellipsized label ("" for a blank/whitespace selection). */
  label: string;
  /** Short summary: "N chars" for a single line, "N lines" for a multi-line selection. */
  count: string;
}

/** Pluralize a unit word against a count ("1 char", "2 chars"). */
function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

export function selectionPreview(text: string, maxLabel = MAX_LABEL): SelectionPreview {
  const normalized = text.replace(/\r\n?/g, "\n");
  // First non-empty line for the label, with internal whitespace collapsed.
  const firstLine =
    normalized
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .find((l) => l.length > 0) ?? "";
  const label = firstLine.length > maxLabel ? firstLine.slice(0, maxLabel).trimEnd() + "…" : firstLine;

  // Count lines by newlines actually present (a trailing newline still bounds a
  // block); character count excludes the newline separators so it reflects the
  // visible characters selected.
  const lineCount = normalized.split("\n").length;
  const chars = normalized.replace(/\n/g, "").length;
  const count = lineCount > 1 ? plural(lineCount, "line") : plural(chars, "char");

  return { label, count };
}
