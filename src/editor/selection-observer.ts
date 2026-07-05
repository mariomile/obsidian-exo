/**
 * Selection observer — a tiny CodeMirror 6 extension that keeps the Exo chat
 * composer aware of the *current* editor selection, so a highlighted excerpt
 * shows up as an ambient "Selection" chip in the composer context row (not only
 * reachable via the in-note "Ask Exo" toolbar).
 *
 * On any selection/focus/doc change it reports the active markdown editor's
 * selection to the plugin (`reportSelection(text, sourcePath)`, `text=""` when
 * empty), which forwards it to the active ChatView. The work is intentionally
 * cheap: a lightly-debounced update listener that no-ops when the reported
 * (text, path) pair is unchanged, and only fires for markdown editors. Gated
 * live behind `settings.showSelectionChip` so toggling it off makes the
 * extension inert without a reload.
 */
import { EditorView, ViewUpdate } from "@codemirror/view";
import { MarkdownView } from "obsidian";
import type ExoPlugin from "../main";

/** Debounce window for selection reports (ms) — smooths out drag-selects and
 *  rapid caret moves without lagging behind the user's intent. */
const DEBOUNCE_MS = 120;

/** The registerable CodeMirror 6 update listener. One instance per editor view;
 *  it holds the debounce timer + last-reported pair so a settle that reports the
 *  same selection is a true no-op. */
export function selectionObserverExtension(plugin: ExoPlugin) {
  return EditorView.updateListener.of((u: ViewUpdate) => {
    if (!u.selectionSet && !u.focusChanged && !u.docChanged) return;
    const st = observerState(u.view);
    st.schedule(plugin, u.view);
  });
}

/** Per-view observer state, lazily attached to the EditorView (CM6 has no
 *  first-class per-view storage for a bare updateListener, so we stash it on the
 *  view object — one small closure-backed record, cleaned up by GC with the view). */
interface ObserverState {
  timer: number | null;
  lastText: string;
  lastPath: string;
  schedule(plugin: ExoPlugin, view: EditorView): void;
}

const STATE_KEY = "__mvaSelObserver";

function observerState(view: EditorView): ObserverState {
  const host = view as unknown as Record<string, ObserverState | undefined>;
  let st = host[STATE_KEY];
  if (st) return st;
  st = {
    timer: null,
    lastText: "\0", // sentinel that no real selection ("" included) can equal on first report
    lastPath: "\0",
    schedule(plugin: ExoPlugin, v: EditorView) {
      if (this.timer !== null) window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        this.timer = null;
        report(this, plugin, v);
      }, DEBOUNCE_MS);
    },
  };
  host[STATE_KEY] = st;
  return st;
}

/** Read the active markdown editor's selection and, if it changed, report it to
 *  the plugin. Only the ACTIVE markdown editor drives the chip. Crucially, when
 *  this update fires with no active markdown editor — the common case being the
 *  user clicking into the Exo composer to type an instruction, which blurs the
 *  editor — we DO NOT report/clear: the selection must persist so it can be acted
 *  on from the chat. The chip then only changes when the active editor's own
 *  selection changes (collapsing it clears the chip; selecting elsewhere replaces it). */
function report(st: ObserverState, plugin: ExoPlugin, view: EditorView): void {
  if (!plugin.settings.showSelectionChip) return;
  const mdView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  // This update belongs to the active markdown editor (not a foreign CM6 instance,
  // and not a blurred editor while focus sits in the Exo view)?
  const isActiveMd = !!mdView && (mdView.editor as unknown as { cm?: EditorView })?.cm === view;
  if (!isActiveMd) return; // focus left the editor (e.g. into the chat) — keep the chip

  const path = mdView.file?.path ?? "";
  const sel = view.state.selection.main;
  const text = sel.empty ? "" : view.state.doc.sliceString(sel.from, sel.to);

  if (text === st.lastText && path === st.lastPath) return;
  st.lastText = text;
  st.lastPath = path;
  plugin.reportSelection(text, path);
}
