import type { Editor, EditorPosition } from "obsidian";

/**
 * Toggle a symmetric wrap marker (e.g. "**", "*", "~~", "==", "`") around the
 * current selection.
 *
 * Detection covers two natural ways a user may have selected marked text:
 *   (A) the markers are inside the selection:  |**bold**|  -> strip them
 *   (B) the markers sit just outside it:        **|bold|**  -> strip them
 * Otherwise the selection is wrapped.
 */
export function applyWrapToggle(editor: Editor, marker: string): void {
  const selected = editor.getSelection();
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  const len = marker.length;

  // Empty selection: insert the markers and drop the cursor between them.
  if (selected.length === 0) {
    editor.replaceSelection(marker + marker);
    const cur = editor.getCursor();
    editor.setSelection({ line: cur.line, ch: cur.ch - len });
    return;
  }

  // Case (A): the selection already contains the markers.
  if (
    selected.length >= len * 2 &&
    selected.startsWith(marker) &&
    selected.endsWith(marker)
  ) {
    const unwrapped = selected.slice(len, selected.length - len);
    editor.replaceSelection(unwrapped);
    const head = editor.offsetToPos(editor.posToOffset(from) + unwrapped.length);
    editor.setSelection(from, head);
    return;
  }

  // Case (B): the markers sit just outside the selection.
  if (markersFlank(editor, from, to, marker)) {
    const beforeStart = editor.offsetToPos(editor.posToOffset(from) - len);
    editor.setSelection(
      beforeStart,
      editor.offsetToPos(editor.posToOffset(to) + len)
    );
    editor.replaceSelection(selected);
    const head = editor.offsetToPos(editor.posToOffset(beforeStart) + selected.length);
    editor.setSelection(beforeStart, head);
    return;
  }

  // Default: wrap.
  editor.replaceSelection(marker + selected + marker);
  const newAnchor = editor.offsetToPos(editor.posToOffset(from) + len);
  const newHead = editor.offsetToPos(editor.posToOffset(from) + len + selected.length);
  editor.setSelection(newAnchor, newHead);
}

/** Whether the exact marker strings flank (sit immediately outside) the range. */
function markersFlank(
  editor: Editor,
  from: EditorPosition,
  to: EditorPosition,
  marker: string
): boolean {
  const len = marker.length;
  const fromOffset = editor.posToOffset(from);
  const toOffset = editor.posToOffset(to);
  if (fromOffset - len < 0) return false;
  const before = editor.getRange(editor.offsetToPos(fromOffset - len), from);
  const after = editor.getRange(to, editor.offsetToPos(toOffset + len));
  return before === marker && after === marker;
}

/** isActive probe used to render the button's active state. */
export function isWrapActive(editor: Editor, marker: string): boolean {
  const selected = editor.getSelection();
  if (selected.length === 0) return false;
  const len = marker.length;
  if (
    selected.length >= len * 2 &&
    selected.startsWith(marker) &&
    selected.endsWith(marker)
  ) {
    return true;
  }
  return markersFlank(editor, editor.getCursor("from"), editor.getCursor("to"), marker);
}
