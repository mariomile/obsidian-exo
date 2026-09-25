import { setIcon } from "obsidian";
import { clickable } from "./dom";
import type { TurnRecall } from "../obsidian/turn-recall";

/**
 * Quiet, expandable "Recalled N" row under a user turn: the trust surface for
 * per-turn recall, so an injection is never invisible. Collapsed by default;
 * a click lists what rode along (note paths open on click, past chats show
 * title and date). No fill at rest (design laws 2 & 4).
 */
export function renderRecallRow(turnEl: HTMLElement, recall: TurnRecall, openPath: (path: string) => void): void {
  const n = recall.notes.length + recall.chats.length;
  const wrap = turnEl.createDiv({ cls: "mva-recall" });
  const header = wrap.createDiv({ cls: "mva-recall-header", attr: { role: "button", tabindex: "0" } });
  setIcon(header.createSpan({ cls: "mva-recall-icon" }), "brain");
  header.createSpan({ cls: "mva-recall-label", text: `Recalled ${n} ${n === 1 ? "item" : "items"}` });
  setIcon(header.createSpan({ cls: "mva-recall-caret" }), "chevron-right");

  const list = wrap.createDiv({ cls: "mva-recall-list" });
  for (const note of recall.notes) {
    const item = list.createDiv({ cls: "mva-recall-item" });
    item.createSpan({ cls: "mva-recall-meta", text: "note" });
    const link = item.createEl("a", { cls: "mva-recall-text", text: note.path, href: "#" });
    clickable(link, (e) => {
      e.preventDefault();
      openPath(note.path);
    });
  }
  for (const chat of recall.chats) {
    const item = list.createDiv({ cls: "mva-recall-item" });
    item.createSpan({ cls: "mva-recall-meta", text: `chat · ${chat.date}` });
    item.createSpan({ cls: "mva-recall-text", text: chat.title });
  }

  const toggle = (): void => {
    const open = wrap.hasClass("is-open");
    wrap.toggleClass("is-open", !open);
    header.setAttr("aria-expanded", String(!open));
  };
  header.setAttr("aria-expanded", "false");
  clickable(header, toggle);
}
