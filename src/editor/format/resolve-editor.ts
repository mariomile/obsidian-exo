import { MarkdownView, type App, type Editor } from "obsidian";
import type { EditorView } from "@codemirror/view";

/** Map a CM EditorView to the Obsidian Editor of the matching markdown leaf. */
export function editorForView(app: App, view: EditorView): Editor | null {
  let found: Editor | null = null;
  app.workspace.iterateAllLeaves((leaf) => {
    if (found) return;
    const v = leaf.view;
    if (v instanceof MarkdownView) {
      const cm = (v.editor as unknown as { cm?: EditorView }).cm;
      if (cm === view) found = v.editor;
    }
  });
  return found;
}
