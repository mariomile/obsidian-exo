import { setIcon } from "obsidian";
import { basename as noteBasename } from "../obsidian/graph";
import { clickable } from "./dom";

/** Build a labelled row of "related note" chips inside `container`. Clicking a
 *  chip runs `attach(path)` (attach the note as context + focus the composer).
 *  Shared by the empty-state surfacing and the quieter in-conversation tail
 *  variant — only the classes (and therefore the look) differ between the two.
 *  Returns the wrapper element so callers can track/remove it. */
export function buildRelatedChips(
  container: HTMLElement,
  related: string[],
  opts: { wrapCls: string; labelCls: string; labelText: string; rowCls: string; chipCls: string },
  attach: (path: string) => void
): HTMLElement {
  const wrap = container.createDiv({ cls: opts.wrapCls });
  wrap.createDiv({ cls: opts.labelCls, text: opts.labelText });
  const row = wrap.createDiv({ cls: opts.rowCls });
  for (const p of related) {
    const chip = row.createDiv({ cls: `mva-chip ${opts.chipCls}` });
    setIcon(chip.createSpan({ cls: "mva-chip-icon" }), "file-text");
    chip.createSpan({ cls: "mva-chip-label", text: noteBasename(p) });
    clickable(chip, () => attach(p));
  }
  return wrap;
}
