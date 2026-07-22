/**
 * Click popover for an underlined outgoing mention — Link · Link all · Ignore.
 * DOM shell (not unit-tested); the mutation text comes from the pure
 * `linkText`, and mutations go through the live CM view as ONE undoable
 * transaction (never a vault.modify, so the editor buffer and undo stack stay
 * coherent).
 *
 * Dismissal uses the `justOpened` guard proven in AIditor: the very mousedown
 * that opens the popover also reaches `document`, and being outside the popover
 * would close it in the same gesture — so the opening tick is ignored.
 */

import { App } from "obsidian";
import { EditorView } from "@codemirror/view";
import { fold } from "./tokenizer";
import { linkText, type MentionRange } from "./mentions-core";
import { ignoreMention } from "./ignore-store";

export interface MentionPopoverCtx {
  app: App;
  view: EditorView;
  sourcePath: string;
  targetBasename: string;
  /** The clicked occurrence. */
  range: MentionRange;
  /** Every occurrence of this target in the doc (for "Link all"). */
  allRanges: MentionRange[];
  anchor: { x: number; y: number };
  /** Recompute + repaint after an action changes the mention set. */
  onChange: () => void;
  /** Configured mentions dir (`paths.mentions`) for the ignore-list store. */
  mentionsDir: string;
}

let current: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

export function closeMentionPopover(): void {
  current?.remove();
  current = null;
  cleanup?.();
  cleanup = null;
}

/** Replace the given ranges with wikilinks to `targetBasename` in one undoable
 *  CM transaction. Shared by the popover and the bottom-block buttons. */
export function applyRangesToView(view: EditorView, targetBasename: string, ranges: MentionRange[]): void {
  const doc = view.state.doc;
  const changes = [...ranges]
    .sort((a, b) => a.start - b.start)
    .map((r) => ({ from: r.start, to: r.end, insert: linkText(doc.sliceString(r.start, r.end), targetBasename) }));
  if (changes.length) view.dispatch({ changes });
}

function button(parent: HTMLElement, label: string, onClick: () => void): void {
  const b = parent.createEl("button", { cls: "exo-mention-btn", text: label });
  b.addEventListener("click", (e) => {
    e.preventDefault();
    onClick();
  });
}

export function openMentionPopover(ctx: MentionPopoverCtx): void {
  closeMentionPopover();

  const el = document.createElement("div");
  el.className = "exo-mention-popover";
  el.style.position = "fixed";
  el.style.left = `${ctx.anchor.x}px`;
  el.style.top = `${ctx.anchor.y}px`;
  el.createDiv({ cls: "exo-mention-popover-title", text: `↳ ${ctx.targetBasename}` });

  button(el, "Link", () => {
    applyRangesToView(ctx.view, ctx.targetBasename, [ctx.range]);
    closeMentionPopover();
    ctx.onChange();
  });
  if (ctx.allRanges.length > 1) {
    button(el, `Link all (${ctx.allRanges.length})`, () => {
      applyRangesToView(ctx.view, ctx.targetBasename, ctx.allRanges);
      closeMentionPopover();
      ctx.onChange();
    });
  }
  button(el, "Ignore", () => {
    void ignoreMention(ctx.app, fold(ctx.targetBasename), ctx.sourcePath, Date.now(), ctx.mentionsDir).then(() => {
      closeMentionPopover();
      ctx.onChange();
    });
  });

  document.body.appendChild(el);
  current = el;

  // Keep the popover on-screen (right/bottom clamp).
  const rect = el.getBoundingClientRect();
  if (rect.right > window.innerWidth) el.style.left = `${window.innerWidth - rect.width - 8}px`;
  if (rect.bottom > window.innerHeight) el.style.top = `${ctx.anchor.y - rect.height - 8}px`;

  let justOpened = true;
  requestAnimationFrame(() => {
    justOpened = false;
  });
  const onDown = (e: MouseEvent): void => {
    if (justOpened) return;
    if (el.contains(e.target as Node)) return;
    closeMentionPopover();
  };
  document.addEventListener("mousedown", onDown, true);
  cleanup = () => document.removeEventListener("mousedown", onDown, true);
}
