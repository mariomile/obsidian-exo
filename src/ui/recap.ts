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
   *  placeholder so the rail is never a blank void.
   *
   *  `current` is a view-supplied, in-flight activity descriptor: while a turn is
   *  streaming, `view.ts` passes the running tool as a human phrase so a live
   *  "Working…" row sits above the accumulated sections. When it's null/absent the
   *  panel renders exactly the post-hoc recap (idle state). */
  render(container: HTMLElement, recap: Recap, current?: { phrase: string } | null): void {
    container.empty();
    const total = recap.web.length + recap.read.length + recap.written.length + recap.skills.length;
    const titleRow = container.createDiv({ cls: "mva-recap-title" });
    titleRow.createSpan({ cls: "mva-recap-title-text", text: "Context" });
    if (current) this.nowRow(container, current.phrase);
    if (total === 0) {
      // A live current-activity row is enough on its own — the placeholder only
      // shows when the panel is truly empty (idle, nothing done yet).
      if (!current) {
        container.createDiv({
          cls: "mva-recap-empty",
          text: "Builds as the agent works — web sources, notes read, files created.",
        });
      }
      return;
    }

    // Knowledge — what the agent consulted. Web sources are their own group (with
    // per-kind icons: WebSearch = query, WebFetch = fetched URL) and come first,
    // then the vault notes read — a subtle sub-label separates the two when both
    // are present so web reads as its own cluster, not mixed into notes.
    if (recap.web.length || recap.read.length) {
      const body = this.section(container, "Knowledge", recap.web.length || undefined);
      const bothKinds = recap.web.length > 0 && recap.read.length > 0;
      if (recap.web.length) {
        if (bothKinds) body.createDiv({ cls: "mva-recap-sublabel", text: "Web" });
        this.cappedList(body, recap.web, (parent, w) => this.webRow(parent, w));
      }
      if (recap.read.length) {
        if (bothKinds) body.createDiv({ cls: "mva-recap-sublabel", text: "Notes" });
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

  /** Live current-activity row: a subtle pulse dot + the in-flight tool phrase,
   *  under a quiet "Working…" treatment. Reuses the working-star pulse grammar. */
  private nowRow(container: HTMLElement, phrase: string): void {
    const row = container.createDiv({ cls: "mva-recap-now" });
    row.createSpan({ cls: "mva-recap-now-dot" });
    row.createSpan({ cls: "mva-recap-now-label", text: phrase });
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
    // WebFetch carries a URL (a fetched page) → globe; WebSearch is a query → search.
    setIcon(row.createSpan({ cls: "mva-recap-ico" }), w.url ? "globe" : "search");
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
