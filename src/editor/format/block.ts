import type { Editor } from "obsidian";

/** Wrap the selected lines in a fenced ``` code block, or unwrap if already fenced. */
export function applyCodeBlock(editor: Editor): void {
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  const blockStart = { line: from.line, ch: 0 };
  const blockEnd = { line: to.line, ch: editor.getLine(to.line).length };
  const sel = editor.getRange(blockStart, blockEnd);

  if (/^```[\s\S]*```$/.test(sel.trim())) {
    const inner = sel.replace(/^```[^\n]*\n?/, "").replace(/\n?```\s*$/, "");
    editor.replaceRange(inner, blockStart, blockEnd);
  } else {
    editor.replaceRange("```\n" + sel + "\n```", blockStart, blockEnd);
  }
}

/** Toggle a %% comment %% around the inline selection. */
export function applyComment(editor: Editor): void {
  const sel = editor.getSelection();
  if (sel.startsWith("%%") && sel.endsWith("%%") && sel.length >= 4) {
    editor.replaceSelection(sel.slice(2, -2).trim());
  } else {
    editor.replaceSelection("%% " + sel + " %%");
  }
}
