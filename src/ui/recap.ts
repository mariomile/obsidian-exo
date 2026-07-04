/**
 * Recap Rail — a quiet right-hand panel (Notion-AI style) summarizing the WHOLE
 * conversation: web sources consulted, vault notes read, files created/edited,
 * and skills used. Shown only in the full-page main area when wide; never in the
 * sidebar. Pure presentation over a `Recap` (built by `core/recap.ts`); updated
 * at turn end, never per token.
 *
 * Modelled on `ui/capabilities.ts`: theme vars only, `--mva-card-*` rhythm,
 * `setIcon`/`setTooltip`, and `clickable()` for keyboard-operable rows.
 */
import { App, setIcon, setTooltip } from "obsidian";
import type { Recap, RecapWeb, RecapWrite } from "../core/recap";
import { basename as noteBasename } from "../obsidian/graph";
import { clickable } from "./dom";

/** Per-section soft cap; the rest reveal behind a "+N more" affordance. */
const SECTION_CAP = 8;

export class RecapPanel {
  constructor(
    private app: App,
    private onOpenNote: (path: string) => void
  ) {}

  /** Render the recap into `container`, replacing any previous content. Sections
   *  with no content are omitted entirely; a wholly empty recap shows a quiet
   *  placeholder so the rail is never a blank void. */
  render(container: HTMLElement, recap: Recap): void {
    container.empty();
    const total = recap.web.length + recap.read.length + recap.written.length + recap.skills.length;
    container.createDiv({ cls: "mva-recap-title", text: "Recap" });
    if (total === 0) {
      container.createDiv({
        cls: "mva-recap-empty",
        text: "Builds as the agent works — web sources, notes read, files created.",
      });
      return;
    }

    // Knowledge — what the agent consulted: web sources + vault notes read.
    if (recap.web.length || recap.read.length) {
      const body = this.section(container, "Knowledge", recap.web.length || undefined);
      if (recap.web.length) this.cappedList(body, recap.web, (parent, w) => this.webRow(parent, w));
      if (recap.read.length) {
        this.cappedList(body, recap.read, (parent, path) =>
          this.fileRow(parent, "file-text", path)
        );
      }
    }

    // Created — what the agent produced: written notes + artifacts (with ×N).
    if (recap.written.length) {
      const body = this.section(container, "Created");
      this.cappedList(body, recap.written, (parent, w) => this.writeRow(parent, w));
    }

    // Skills — capability invocations, as quiet chips.
    if (recap.skills.length) {
      const body = this.section(container, "Skills");
      const chips = body.createDiv({ cls: "mva-recap-chips" });
      for (const s of recap.skills) chips.createSpan({ cls: "mva-recap-chip", text: s });
    }
  }

  private section(container: HTMLElement, title: string, badge?: number): HTMLElement {
    const sec = container.createDiv({ cls: "mva-recap-section" });
    const head = sec.createDiv({ cls: "mva-recap-head" });
    head.createSpan({ text: title });
    if (badge) head.createSpan({ cls: "mva-recap-badge", text: String(badge) });
    return sec.createDiv({ cls: "mva-recap-body" });
  }

  /** Render up to SECTION_CAP items now; the overflow reveals on a "+N more" click. */
  private cappedList<T>(body: HTMLElement, items: T[], renderItem: (parent: HTMLElement, item: T) => void): void {
    for (const it of items.slice(0, SECTION_CAP)) renderItem(body, it);
    const rest = items.slice(SECTION_CAP);
    if (rest.length) {
      const more = body.createDiv({ cls: "mva-recap-more", text: `+${rest.length} more` });
      more.setAttribute("aria-label", `Show ${rest.length} more`);
      clickable(more, () => {
        more.remove();
        for (const it of rest) renderItem(body, it);
      });
    }
  }

  private webRow(parent: HTMLElement, w: RecapWeb): void {
    const row = parent.createDiv({ cls: "mva-recap-row" });
    setIcon(row.createSpan({ cls: "mva-recap-ico" }), "globe");
    row.createSpan({ cls: "mva-recap-label", text: w.label });
    if (w.url) {
      row.addClass("is-clickable");
      setTooltip(row, w.url);
      const url = w.url;
      clickable(row, () => window.open(url, "_blank"));
    }
  }

  private fileRow(parent: HTMLElement, icon: string, path: string): void {
    const row = parent.createDiv({ cls: "mva-recap-row is-clickable" });
    setIcon(row.createSpan({ cls: "mva-recap-ico" }), icon);
    row.createSpan({ cls: "mva-recap-label", text: noteBasename(path) });
    setTooltip(row, path);
    clickable(row, () => this.onOpenNote(path));
  }

  private writeRow(parent: HTMLElement, w: RecapWrite): void {
    const row = parent.createDiv({ cls: "mva-recap-row is-clickable" });
    setIcon(row.createSpan({ cls: "mva-recap-ico" }), "file-pen");
    row.createSpan({ cls: "mva-recap-label", text: noteBasename(w.path) });
    if (w.count && w.count > 1) row.createSpan({ cls: "mva-recap-count", text: `×${w.count}` });
    setTooltip(row, w.path);
    clickable(row, () => this.onOpenNote(w.path));
  }
}
