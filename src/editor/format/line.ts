import type { Editor } from "obsidian";

export interface LinePrefixSpec {
  /** Regex matching an existing prefix to strip (anchored at line start). */
  match: RegExp;
  /** Prefix to insert. A function for ordered lists (1. 2. 3.). */
  prefix: string | ((lineIndex: number, ordinal: number) => string);
  /** If true, strip any competing block prefix before applying. */
  exclusive?: boolean;
}

/** Any block-level line prefix — used to make block commands mutually exclusive. */
const MUTEX = /^(\s*)(#{1,6}\s|>\s|-\s\[[ xX]\]\s|-\s|\d+\.\s)/;

/**
 * Toggle a line prefix across every line the selection touches. Direction is
 * decided from the first line: if it already has the prefix, strip on all;
 * otherwise add on all.
 */
export function applyLinePrefixToggle(editor: Editor, spec: LinePrefixSpec): void {
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  const turningOff = spec.match.test(editor.getLine(from.line));

  let ordinal = 1;
  for (let line = from.line; line <= to.line; line++) {
    const text = editor.getLine(line);
    const lineStart = { line, ch: 0 };
    const lineEnd = { line, ch: text.length };

    if (turningOff) {
      editor.replaceRange(text.replace(spec.match, ""), lineStart, lineEnd);
    } else {
      const base = spec.exclusive ? text.replace(MUTEX, "$1") : text;
      const pfx =
        typeof spec.prefix === "function"
          ? spec.prefix(line - from.line, ordinal++)
          : spec.prefix;
      editor.replaceRange(pfx + base, lineStart, lineEnd);
    }
  }

  // Keep the affected line range selected so the toolbar stays anchored.
  editor.setSelection(
    { line: from.line, ch: 0 },
    { line: to.line, ch: editor.getLine(to.line).length }
  );
}
