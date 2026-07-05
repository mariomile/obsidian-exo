/**
 * In-note AI v2 — the CodeMirror 6 decoration layer for the inline diff.
 *
 * A rewrite is reviewed IN THE DOCUMENT, non-destructively: the original text
 * stays in the doc untouched; decorations dim/strike the parts that would be
 * removed and inject the new text as green inline widgets, each with its own
 * ✓/✗ control. Nothing is written until commit — so there is no offset risk and
 * a reject leaves the note byte-for-byte identical.
 *
 * The whole feature is a single `StateField<InlineDiff | null>`:
 *   - `StateEffect`s drive the state (`setDiff`, `toggleHunk`, `setHunk`,
 *     `setAllHunks`, `moveCursor`, `clearDiff`).
 *   - The field derives a `DecorationSet` (via `EditorView.decorations`) from
 *     `hunkDocRanges` (pure, tested in `core/inline-ai`).
 *   - A high-precedence keymap (Tab / Shift-Tab / y / n / Mod-Enter / Escape)
 *     is active only while the field is non-null; otherwise the keys fall
 *     through to the editor's defaults.
 *
 * SOFT-LOCK CORRECTNESS: on every `docChanged` transaction the field maps its
 * stored `from`/`to` through `tr.changes` so decorations track edits made
 * ELSEWHERE in the note; if a change overlaps the target range (or the range
 * collapses) the field returns `null` — self-clearing, which is how "editing
 * the target range aborts the op" is enforced. See `update()` below.
 *
 * Pure logic (`hunkDocRanges`, `nextHunk`, `applyDiff`) lives in
 * `core/inline-ai` and is unit-tested; this file is the DOM/CM6 shell.
 */
import { Decoration, DecorationSet, EditorView, WidgetType, keymap } from "@codemirror/view";
import {
  EditorSelection,
  Prec,
  type Range,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import { applyDiff, hunkCount, hunkDocRanges, nextHunk, type DiffPart } from "../core/inline-ai";

/** The reviewable inline diff: the original doc range plus the hunked rewrite
 *  and per-hunk accept decisions. `accepted` holds the indices currently kept
 *  as the new text; `cursorHunk` is the keyboard focus. */
export interface InlineDiff {
  from: number;
  to: number;
  parts: DiffPart[];
  accepted: Set<number>;
  cursorHunk: number;
}

/* ------------------------------- effects -------------------------------- */

/** Install a fresh diff over `[from,to)` (all hunks start accepted/pending). */
export const setDiff = StateEffect.define<{ from: number; to: number; parts: DiffPart[] }>();
/** Flip one hunk's accept state. */
export const toggleHunk = StateEffect.define<number>();
/** Set one hunk's accept state explicitly (from the inline ✓/✗ chips). */
export const setHunk = StateEffect.define<{ index: number; value: boolean }>();
/** Accept (true) or reject (false) every hunk. */
export const setAllHunks = StateEffect.define<boolean>();
/** Move the keyboard cursor between hunks (clamped at the ends). */
export const moveCursor = StateEffect.define<1 | -1>();
/** Drop the diff entirely (reject-all; the doc is untouched). */
export const clearDiff = StateEffect.define<null>();

/* -------------------------------- field --------------------------------- */

/** Does any change in this transaction touch `[from,to)`? Insertions exactly at
 *  a boundary don't count (they're "adjacent, elsewhere", not "inside"). */
function rangeOverlapped(from: number, to: number, tr: Transaction): boolean {
  let hit = false;
  tr.changes.iterChanges((fromA: number, toA: number) => {
    if (fromA < to && toA > from) hit = true;
  });
  return hit;
}

export const inlineDiffField = StateField.define<InlineDiff | null>({
  create() {
    return null;
  },
  update(value, tr) {
    // 1) Wholesale effects first: setDiff installs, clearDiff removes. Both
    //    short-circuit before any range mapping.
    for (const e of tr.effects) {
      if (e.is(setDiff)) {
        const { from, to, parts } = e.value;
        const accepted = new Set<number>();
        for (let i = 0; i < hunkCount(parts); i++) accepted.add(i); // pending = accepted
        return { from, to, parts, accepted, cursorHunk: 0 };
      }
      if (e.is(clearDiff)) return null;
    }
    if (!value) return null;

    // 2) SOFT-LOCK: map the target range through the doc changes so the diff
    //    tracks edits made elsewhere in the note; if a change overlaps the
    //    range (or it collapses), self-clear — this is how editing the target
    //    range aborts the op.
    if (tr.docChanged) {
      if (rangeOverlapped(value.from, value.to, tr)) return null;
      const from = tr.changes.mapPos(value.from, 1);
      const to = tr.changes.mapPos(value.to, -1);
      if (to <= from) return null;
      value = { ...value, from, to };
    }

    // 3) Per-hunk effects on the (possibly re-based) value.
    for (const e of tr.effects) {
      if (e.is(toggleHunk)) {
        const accepted: Set<number> = new Set(value.accepted);
        if (accepted.has(e.value)) accepted.delete(e.value);
        else accepted.add(e.value);
        value = { ...value, accepted, cursorHunk: e.value };
      } else if (e.is(setHunk)) {
        const accepted: Set<number> = new Set(value.accepted);
        if (e.value.value) accepted.add(e.value.index);
        else accepted.delete(e.value.index);
        value = { ...value, accepted, cursorHunk: e.value.index };
      } else if (e.is(setAllHunks)) {
        const accepted = new Set<number>();
        if (e.value) for (let i = 0; i < hunkCount(value.parts); i++) accepted.add(i);
        value = { ...value, accepted };
      } else if (e.is(moveCursor)) {
        value = { ...value, cursorHunk: nextHunk(value.parts, value.cursorHunk, e.value) };
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, buildDecorations),
});

/** Read the active diff, or null if the field isn't present / is empty. */
export function activeDiff(view: EditorView): InlineDiff | null {
  return view.state.field(inlineDiffField, false) ?? null;
}

/* ------------------------------- widgets -------------------------------- */

/** The green inline "new text" injected at a hunk boundary. */
class AddWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: AddWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "mva-inai-add";
    span.textContent = this.text;
    return span;
  }
}

/** The per-hunk ✓/✗ control chip. Clicks dispatch `setHunk`. `eq()` keys on
 *  everything that changes its DOM so streaming/redraw doesn't thrash. */
class HunkCtrlWidget extends WidgetType {
  constructor(
    readonly index: number,
    readonly accepted: boolean,
    readonly current: boolean
  ) {
    super();
  }
  eq(other: HunkCtrlWidget): boolean {
    return (
      other.index === this.index &&
      other.accepted === this.accepted &&
      other.current === this.current
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "mva-inai-hunk-ctl" + (this.current ? " is-current" : "");
    const mk = (symbol: string, cls: string, value: boolean, on: boolean) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mva-inai-chip " + cls + (on ? " is-on" : "");
      b.textContent = symbol;
      b.setAttribute("aria-label", value ? "Accept change" : "Reject change");
      // Keep editor focus (so the keymap stays live) — don't let the button steal it.
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.preventDefault();
        view.dispatch({ effects: setHunk.of({ index: this.index, value }) });
      });
      return b;
    };
    wrap.appendChild(mk("✓", "is-accept", true, this.accepted));
    wrap.appendChild(mk("✗", "is-reject", false, !this.accepted));
    return wrap;
  }
}

/* ----------------------------- decorations ------------------------------ */

function buildDecorations(value: InlineDiff | null): DecorationSet {
  if (!value) return Decoration.none;
  const out: Range<Decoration>[] = [];
  const hunks = value.parts.filter(
    (p): p is Extract<DiffPart, { kind: "hunk" }> => p.kind === "hunk"
  );
  for (const r of hunkDocRanges(value.from, value.parts)) {
    const hunk = hunks.find((h) => h.index === r.index);
    if (!hunk) continue;
    const accepted = value.accepted.has(r.index);
    const current = value.cursorHunk === r.index;
    // Strike the removed span only while the hunk is accepted/pending; when it's
    // rejected we drop the mark so the original reads as kept.
    if (accepted && r.before.to > r.before.from) {
      out.push(Decoration.mark({ class: "mva-inai-del" }).range(r.before.from, r.before.to));
    }
    // Green inserted text — shown when accepted/pending and non-empty.
    if (accepted && hunk.after.length > 0) {
      out.push(Decoration.widget({ widget: new AddWidget(hunk.after), side: 1 }).range(r.at));
    }
    // The ✓/✗ chip is always present (so a rejected hunk can be re-accepted).
    out.push(
      Decoration.widget({
        widget: new HunkCtrlWidget(r.index, accepted, current),
        side: 2,
      }).range(r.at)
    );
  }
  return Decoration.set(out, true);
}

/* ------------------------------- commands ------------------------------- */

/** Commit the current accept set as ONE transaction (a single undo step): the
 *  reconstructed text replaces `[from,to)`, the cursor lands at its end, and the
 *  field clears in the same transaction. Returns false if no diff is active. */
export function commitInlineDiff(view: EditorView): boolean {
  const d = activeDiff(view);
  if (!d) return false;
  const text = applyDiff(d.parts, (i) => d.accepted.has(i));
  view.dispatch({
    changes: { from: d.from, to: d.to, insert: text },
    selection: EditorSelection.cursor(d.from + text.length),
    effects: clearDiff.of(null),
  });
  return true;
}

function moveCursorCmd(view: EditorView, dir: 1 | -1): boolean {
  if (!activeDiff(view)) return false;
  view.dispatch({ effects: moveCursor.of(dir) });
  return true;
}

/** Decide the current hunk (y/n), then advance to the next one for flow. */
function decideCurrent(view: EditorView, value: boolean): boolean {
  const d = activeDiff(view);
  if (!d) return false;
  view.dispatch({ effects: [setHunk.of({ index: d.cursorHunk, value }), moveCursor.of(1)] });
  return true;
}

function clearIfDiff(view: EditorView): boolean {
  if (!activeDiff(view)) return false;
  view.dispatch({ effects: clearDiff.of(null) });
  return true;
}

/** Keys are only claimed while a diff is present (each command returns false
 *  otherwise, so normal typing of "y"/"n"/Tab/etc. falls through). */
const inlineDiffKeymap = Prec.high(
  keymap.of([
    { key: "Tab", run: (v) => moveCursorCmd(v, 1) },
    { key: "Shift-Tab", run: (v) => moveCursorCmd(v, -1) },
    { key: "y", run: (v) => decideCurrent(v, true) },
    { key: "n", run: (v) => decideCurrent(v, false) },
    { key: "Mod-Enter", run: (v) => commitInlineDiff(v) },
    { key: "Escape", run: (v) => clearIfDiff(v) },
  ])
);

/** The bundled extension: the state field (with its derived decorations) plus
 *  the keymap. Registered by the controller alongside its ViewPlugin. */
export function inlineDiffExtension() {
  return [inlineDiffField, inlineDiffKeymap];
}
