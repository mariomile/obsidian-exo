/**
 * In-note AI ("Inline AI") — a CodeMirror 6 extension that brings Exo into the
 * markdown editor. Selecting text raises a floating toolbar over the selection
 * with three actions:
 *
 *   • Edit     — rewrite the selection with a streaming inline diff you
 *                accept/reject (a single, undoable transaction on accept).
 *   • Continue — keep writing from the end of the selection in the same voice,
 *                previewed and accepted/rejected.
 *   • Ask Exo  — reveal the chat and seed the selection as quoted context.
 *
 * Design choices for v1 (see the report / PRODUCT.md):
 *   - The toolbar and panels are plain DOM anchored via `coordsAtPos`, appended
 *     to `document.body` (position:fixed) so they escape editor overflow. The
 *     toolbar hides on scroll and selection-clear; the panel repositions on
 *     scroll so its Accept/Reject stay reachable.
 *   - Nothing is written to the document while streaming. The generated text is
 *     shown in the anchored panel, and committed exactly once — on Accept — via
 *     a single CM transaction (one undo step, trivially abort-safe). If the user
 *     edits the doc while a panel is open, the op aborts (positions are stale).
 *   - Whole-edit accept/reject only; the diff is computed as hunks (see
 *     `core/inline-ai`) so per-hunk accept is a later, additive step.
 *
 * All pure logic (prompts, hunks) lives in `core/inline-ai` and is unit-tested;
 * this file is the DOM/CM6 shell and is intentionally not unit-tested.
 */
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { MarkdownView, setIcon } from "obsidian";
import type ExoPlugin from "../main";
import { computeHunks, applyDiff } from "../core/inline-ai";

/** Max chars of preceding context fed to Continue (keeps the call cheap/fast). */
const CONTINUE_CONTEXT_CHARS = 2000;

type Phase = "idle" | "edit-input" | "streaming" | "diff" | "continue-preview" | "error";

/** Per-editor controller: owns the floating toolbar, the action panel, and the
 *  transient streaming session for one CodeMirror view. */
class InlineAiController {
  private bar: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private abort: AbortController | null = null;
  private phase: Phase = "idle";
  /** The selection the toolbar is anchored to (doc offsets); drives repositioning
   *  while the bar is up. Actions read the LIVE selection at click time, not this. */
  private barRange: { from: number; to: number } | null = null;
  /** The selection range the current panel operates on (doc offsets). */
  private range: { from: number; to: number } | null = null;
  /** Set true only around our own commit dispatch, so `update()` doesn't mistake
   *  it for an external edit and tear the panel down before we're done. */
  private committing = false;
  private readonly onScroll = () => this.reposition();

  constructor(
    private view: EditorView,
    private plugin: ExoPlugin
  ) {
    this.view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("scroll", this.onScroll, { passive: true, capture: true });
    window.addEventListener("resize", this.onScroll, { passive: true });
  }

  private get enabled(): boolean {
    return this.plugin.settings.inlineAi;
  }

  update(u: ViewUpdate): void {
    if (!this.enabled) {
      this.teardownAll();
      return;
    }
    // An external edit while a panel is open invalidates our stored offsets —
    // abort the op rather than risk writing at the wrong place.
    if (u.docChanged && this.panel && !this.committing) {
      this.cancel();
      return;
    }
    // While a panel is open we own the surface; selection changes don't move the
    // toolbar. Otherwise, (re)evaluate the toolbar for the current selection.
    if (!this.panel && (u.selectionSet || u.docChanged || u.focusChanged)) {
      this.syncToolbar();
    }
  }

  /* ------------------------------- toolbar ------------------------------- */

  private syncToolbar(): void {
    const sel = this.view.state.selection.main;
    if (sel.empty || !this.view.hasFocus) {
      this.removeBar();
      return;
    }
    this.barRange = { from: sel.from, to: sel.to };
    // Reuse the existing bar (just reposition) so a drag-select doesn't rebuild
    // and re-flash the entrance on every tick. Actions read the live selection.
    if (this.bar) {
      this.placeAbove(this.bar, sel.from);
      return;
    }
    this.showToolbar(sel.from);
  }

  private showToolbar(anchor: number): void {
    const bar = document.body.createDiv({ cls: "mva-inai-bar" });
    const mk = (label: string, icon: string, run: () => void) => {
      const btn = bar.createEl("button", { cls: "mva-inai-btn", attr: { "aria-label": label } });
      setIcon(btn.createSpan({ cls: "mva-inai-ico" }), icon);
      btn.createSpan({ text: label });
      btn.onclick = (e) => {
        e.preventDefault();
        run();
      };
      return btn;
    };
    mk("Edit", "wand-2", () => this.startEdit());
    mk("Continue", "pen-line", () => this.startContinue());
    mk("Ask Exo", "message-square", () => this.askExo());
    bar.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.removeBar();
        this.view.focus();
      }
    });
    this.bar = bar;
    this.placeAbove(bar, anchor);
    requestAnimationFrame(() => bar.addClass("is-shown"));
  }

  private removeBar(): void {
    this.bar?.remove();
    this.bar = null;
    this.barRange = null;
  }

  /** Live selection at action time, or null if it collapsed. */
  private liveSelection(): { from: number; to: number } | null {
    const sel = this.view.state.selection.main;
    return sel.empty ? null : { from: sel.from, to: sel.to };
  }

  /* ------------------------------- actions ------------------------------- */

  private startEdit(): void {
    const sel = this.liveSelection();
    if (!sel) return;
    const { from, to } = sel;
    this.removeBar();
    this.range = { from, to };
    this.phase = "edit-input";
    const panel = this.openPanel(to);
    const input = panel.createEl("textarea", {
      cls: "mva-inai-input",
      attr: { rows: "1", placeholder: "How should Exo edit this? (⏎ to run, esc to cancel)" },
    });
    const actions = panel.createDiv({ cls: "mva-inai-actions" });
    const runBtn = actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Edit" });
    const cancelBtn = actions.createEl("button", { cls: "mva-btn", text: "Cancel" });
    cancelBtn.onclick = () => this.cancel();
    const go = () => {
      const instruction = input.value.trim();
      if (!instruction) return;
      void this.runEdit(from, to, instruction);
    };
    runBtn.onclick = go;
    input.addEventListener("input", () => this.autosize(input));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        go();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.cancel();
      }
    });
    setTimeout(() => input.focus(), 0);
  }

  private async runEdit(from: number, to: number, instruction: string): Promise<void> {
    if (!this.panel) return;
    const original = this.view.state.doc.sliceString(from, to);
    this.phase = "streaming";
    const stream = this.renderStreaming("Rewriting…");
    this.abort = new AbortController();
    let live = "";
    try {
      const result = await this.plugin.oneShotStream(instruction, original, this.abort.signal, (d) => {
        live += d;
        stream.setText(live);
        this.reposition();
      });
      if (this.abort.signal.aborted) return;
      this.renderDiff(from, to, original, result.trim() || original);
    } catch (err) {
      if (!this.abort?.signal.aborted) this.renderError(err);
    }
  }

  private startContinue(): void {
    const sel = this.liveSelection();
    if (!sel) return;
    this.removeBar();
    this.range = { from: sel.from, to: sel.to };
    void this.runContinue(sel.to);
  }

  private async runContinue(at: number): Promise<void> {
    const doc = this.view.state.doc;
    const preceding = doc.sliceString(Math.max(0, at - CONTINUE_CONTEXT_CHARS), at);
    this.openPanel(at);
    this.phase = "streaming";
    const stream = this.renderStreaming("Writing…");
    this.abort = new AbortController();
    let live = "";
    try {
      const result = await this.plugin.continueStream(preceding, this.abort.signal, (d) => {
        live += d;
        stream.setText(live);
        this.reposition();
      });
      if (this.abort.signal.aborted) return;
      this.renderContinuePreview(at, result.trimEnd());
    } catch (err) {
      if (!this.abort?.signal.aborted) this.renderError(err);
    }
  }

  private askExo(): void {
    const sel = this.liveSelection();
    if (!sel) return;
    const text = this.view.state.doc.sliceString(sel.from, sel.to);
    this.removeBar();
    const path = this.plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? "";
    void this.plugin.attachSelectionToChat(text, path);
  }

  /* ------------------------------ rendering ------------------------------ */

  /** Open (or reset) the anchored panel below `pos` and return its body. */
  private openPanel(pos: number): HTMLElement {
    this.removePanel();
    const panel = document.body.createDiv({ cls: "mva-inai-panel" });
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.cancel();
      }
    });
    this.panel = panel;
    this.placeBelow(panel, pos);
    requestAnimationFrame(() => panel.addClass("is-shown"));
    return panel;
  }

  /** Live "writing…" state: a label + a growing text node. Returns the text node
   *  so the stream callback can update it in place. */
  private renderStreaming(label: string): HTMLElement {
    const panel = this.panel!;
    panel.empty();
    const head = panel.createDiv({ cls: "mva-inai-head" });
    setIcon(head.createSpan({ cls: "mva-inai-spin" }), "loader-2");
    head.createSpan({ text: label });
    const body = panel.createDiv({ cls: "mva-inai-stream" });
    const actions = panel.createDiv({ cls: "mva-inai-actions" });
    const stop = actions.createEl("button", { cls: "mva-btn", text: "Stop" });
    stop.onclick = () => this.cancel();
    return body;
  }

  private renderDiff(from: number, to: number, original: string, revised: string): void {
    const panel = this.panel;
    if (!panel) return;
    this.phase = "diff";
    const parts = computeHunks(original, revised);
    panel.empty();
    const diff = panel.createDiv({ cls: "mva-inai-diff" });
    for (const p of parts) {
      if (p.kind === "context") {
        diff.createSpan({ cls: "mva-ie-same", text: p.text });
      } else {
        if (p.before) diff.createSpan({ cls: "mva-ie-del", text: p.before });
        if (p.after) diff.createSpan({ cls: "mva-ie-add", text: p.after });
      }
    }
    const actions = panel.createDiv({ cls: "mva-inai-actions" });
    const accept = actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Accept" });
    // v1: accept the whole edit. The hunk model + applyDiff already support a
    // per-hunk predicate — swap `() => true` for a per-hunk toggle set later.
    accept.onclick = () => this.commitReplace(from, to, applyDiff(parts, () => true));
    const reject = actions.createEl("button", { cls: "mva-btn mva-btn-danger", text: "Reject" });
    reject.onclick = () => this.cancel();
    this.reposition();
  }

  private renderContinuePreview(at: number, continuation: string): void {
    const panel = this.panel;
    if (!panel) return;
    this.phase = "continue-preview";
    panel.empty();
    if (!continuation) {
      this.renderError(new Error("Nothing to continue."));
      return;
    }
    panel.createDiv({ cls: "mva-inai-cont", text: continuation });
    const actions = panel.createDiv({ cls: "mva-inai-actions" });
    const accept = actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Accept" });
    accept.onclick = () => this.commitInsert(at, continuation);
    const reject = actions.createEl("button", { cls: "mva-btn mva-btn-danger", text: "Reject" });
    reject.onclick = () => this.cancel();
    this.reposition();
  }

  private renderError(err: unknown): void {
    const panel = this.panel;
    if (!panel) return;
    this.phase = "error";
    panel.empty();
    panel.createDiv({
      cls: "mva-inai-error",
      text: `Inline AI failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    const actions = panel.createDiv({ cls: "mva-inai-actions" });
    const dismiss = actions.createEl("button", { cls: "mva-btn", text: "Dismiss" });
    dismiss.onclick = () => this.cancel();
    this.reposition();
  }

  /* ------------------------------- commit -------------------------------- */

  /** Replace [from,to) with `text` in a single transaction (Edit accept). */
  private commitReplace(from: number, to: number, text: string): void {
    this.committing = true;
    try {
      this.view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
    } finally {
      this.committing = false;
    }
    this.teardownAll();
    this.view.focus();
  }

  /** Insert `text` at `at` in a single transaction (Continue accept). */
  private commitInsert(at: number, text: string): void {
    this.committing = true;
    try {
      this.view.dispatch({
        changes: { from: at, insert: text },
        selection: { anchor: at + text.length },
      });
    } finally {
      this.committing = false;
    }
    this.teardownAll();
    this.view.focus();
  }

  /* ------------------------------ lifecycle ------------------------------ */

  /** Abort any stream, drop the panel, restore the original selection. */
  private cancel(): void {
    this.abort?.abort();
    this.abort = null;
    const r = this.range;
    this.teardownAll();
    if (r) {
      try {
        this.view.dispatch({ selection: { anchor: r.from, head: r.to } });
      } catch {
        /* doc shrank under us — ignore */
      }
    }
    this.view.focus();
  }

  private removePanel(): void {
    this.panel?.remove();
    this.panel = null;
    this.phase = "idle";
    this.range = null;
  }

  private teardownAll(): void {
    this.abort?.abort();
    this.abort = null;
    this.removeBar();
    this.removePanel();
  }

  destroy(): void {
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("scroll", this.onScroll, { capture: true } as EventListenerOptions);
    window.removeEventListener("resize", this.onScroll);
    this.teardownAll();
  }

  /* ----------------------------- positioning ----------------------------- */

  private reposition(): void {
    if (this.bar && this.barRange) this.placeAbove(this.bar, this.barRange.from);
    if (this.panel && this.range) this.placeBelow(this.panel, this.range.to);
  }

  /** Anchor an element above `pos` (the toolbar). Fixed coords from CM; the
   *  element's own CSS transform lifts it above the line. Hidden if scrolled off. */
  private placeAbove(el: HTMLElement, pos: number): void {
    const c = this.view.coordsAtPos(pos);
    if (!c) {
      el.addClass("is-off");
      return;
    }
    el.removeClass("is-off");
    const left = Math.max(8, Math.min(c.left, window.innerWidth - el.offsetWidth - 8));
    el.style.left = `${left}px`;
    el.style.top = `${c.top}px`;
  }

  /** Anchor an element just below `pos` (the panel), so the selection stays
   *  visible above it. Clamped to the viewport. */
  private placeBelow(el: HTMLElement, pos: number): void {
    const c = this.view.coordsAtPos(pos);
    if (!c) {
      el.addClass("is-off");
      return;
    }
    el.removeClass("is-off");
    const left = Math.max(8, Math.min(c.left, window.innerWidth - el.offsetWidth - 8));
    el.style.left = `${left}px`;
    el.style.top = `${c.bottom + 6}px`;
  }

  private autosize(el: HTMLTextAreaElement): void {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
    this.reposition();
  }
}

/** The registerable CodeMirror 6 extension. Gated live behind `settings.inlineAi`
 *  (checked inside the controller), so it's inert when the setting is off. */
export function inlineAiExtension(plugin: ExoPlugin) {
  return ViewPlugin.fromClass(
    class {
      private ctrl: InlineAiController;
      constructor(view: EditorView) {
        this.ctrl = new InlineAiController(view, plugin);
      }
      update(u: ViewUpdate): void {
        this.ctrl.update(u);
      }
      destroy(): void {
        this.ctrl.destroy();
      }
    }
  );
}
