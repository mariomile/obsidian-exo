/**
 * One steps-timeline run: a contiguous stretch of work (thinking + generic
 * tool calls) rendered as a chronological rail (dot + connector), folding into
 * a "N steps ⌄" accordion when the run closes (reply text resumes, an excluded
 * card appears, or the turn ends). Notion's interaction model, Craft skin —
 * geometry and states only, no decorative surfaces. Tool cards keep their
 * existing `.mva-tool` DOM/handlers and are simply parented inside the run;
 * this class owns only the container, the thinking steps, and the fold.
 */

import { setIcon } from "obsidian";
import { clickable } from "./dom";
import { stepsLabel } from "../core/steps";

export class StepsRun {
  private rootEl: HTMLElement;
  private headEl: HTMLElement;
  private labelEl: HTMLElement;
  private bodyEl: HTMLElement;
  private thinkEl: HTMLElement | null = null;
  private thinkLabelEl: HTMLElement | null = null;
  private thinkBodyEl: HTMLElement | null = null;
  private thinkRaw = "";
  private steps = 0;
  closed = false;

  constructor(parent: HTMLElement) {
    this.rootEl = parent.createDiv({ cls: "mva-steps" });
    this.headEl = this.rootEl.createDiv({ cls: "mva-steps-head" });
    setIcon(this.headEl.createSpan({ cls: "mva-reason-chevron" }), "chevron-right");
    this.labelEl = this.headEl.createSpan({ cls: "mva-steps-label", text: "" });
    clickable(this.headEl, () =>
      this.rootEl.toggleClass("is-collapsed", !this.rootEl.hasClass("is-collapsed"))
    );
    this.bodyEl = this.rootEl.createDiv({ cls: "mva-steps-body" });
  }

  get body(): HTMLElement {
    return this.bodyEl;
  }

  get count(): number {
    return this.steps;
  }

  /** Open (or reuse) the live thinking step: expanded body, shimmer label. */
  startThinking(): void {
    if (this.thinkEl) return;
    this.thinkRaw = "";
    const step = this.bodyEl.createDiv({ cls: "mva-step-think is-active" });
    const head = step.createDiv({ cls: "mva-step-think-head" });
    setIcon(head.createSpan({ cls: "mva-reason-chevron" }), "chevron-right");
    this.thinkLabelEl = head.createSpan({ cls: "mva-step-think-label", text: "Thinking…" });
    clickable(head, () => step.toggleClass("is-collapsed", !step.hasClass("is-collapsed")));
    this.thinkBodyEl = step.createDiv({ cls: "mva-step-think-body" });
    this.thinkEl = step;
    this.steps++;
  }

  appendThinking(text: string): void {
    this.startThinking();
    this.thinkRaw += text;
    this.thinkBodyEl?.setText(this.thinkRaw);
  }

  /** The burst ended (next tool / run close): "Thinking…" → collapsed "Thought ›".
   *  The body text survives inside the collapsed step. Idempotent. */
  settleThinking(): void {
    if (!this.thinkEl) return;
    this.thinkEl.removeClass("is-active");
    this.thinkEl.addClass("is-collapsed");
    this.thinkLabelEl?.setText("Thought");
    this.thinkEl = null;
    this.thinkLabelEl = null;
    this.thinkBodyEl = null;
  }

  /** A tool card was appended into `body`: count it and settle any open thinking. */
  noteToolAdded(): void {
    this.settleThinking();
    this.steps++;
  }

  /** Fold the run: "N steps ⌄" header, body hidden, live states neutralized.
   *  Empty runs remove themselves. `scroller` (the conversation list element)
   *  gets its scrollTop compensated when the fold collapses content above the
   *  current reading position. Idempotent. */
  close(scroller?: HTMLElement): void {
    if (this.closed) return;
    this.closed = true;
    this.settleThinking();
    if (this.steps === 0) {
      this.rootEl.remove();
      return;
    }
    // Interrupted turns: a never-resolved tool would keep its shimmer inside
    // the folded run — freeze it (keeps its last icon, loses the animation).
    this.rootEl.addClass("is-settled");
    const before = this.rootEl.offsetHeight;
    this.labelEl.setText(stepsLabel(this.steps));
    this.rootEl.addClass("is-collapsed");
    if (scroller) {
      const delta = before - this.rootEl.offsetHeight;
      // Only compensate when the fold happened above the viewport's top edge.
      if (delta > 0 && this.rootEl.offsetTop < scroller.scrollTop) {
        scroller.scrollTop -= delta;
      }
    }
  }
}
