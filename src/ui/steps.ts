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
import { stepsLabel, summarizeSteps, milestoneLine, fileEditKey, isCommandTool } from "../core/steps";

export class StepsRun {
  private rootEl: HTMLElement;
  private headEl: HTMLElement;
  private statusEl: HTMLElement;
  private labelEl: HTMLElement;
  private elapsedEl: HTMLElement;
  private bodyEl: HTMLElement;
  private thinkEl: HTMLElement | null = null;
  private thinkLabelEl: HTMLElement | null = null;
  private thinkBodyEl: HTMLElement | null = null;
  private thinkRaw = "";
  private steps = 0;
  private toolCount = 0;
  private fileEdits = new Set<string>();
  private commands = 0;
  private startedAt = Date.now();
  /** The turn's duration formatter, captured from the first `tick`. A run that
   *  never ticked (a transcript rebuilt from disk) has no honest elapsed time,
   *  so its milestone simply omits the clause. */
  private fmt: ((ms: number) => string) | null = null;
  /** The elapsed label frozen at fold time, so the milestone keeps saying how
   *  long the work took long after the clock stopped. */
  private frozenElapsed = "";
  closed = false;

  constructor(parent: HTMLElement) {
    this.rootEl = parent.createDiv({ cls: "mva-steps" });
    this.headEl = this.rootEl.createDiv({ cls: "mva-steps-head mva-type-body" });
    setIcon(this.headEl.createSpan({ cls: "mva-reason-chevron" }), "chevron-right");
    this.statusEl = this.headEl.createSpan({ cls: "mva-steps-status" });
    this.labelEl = this.headEl.createSpan({ cls: "mva-steps-label", text: "" });
    this.elapsedEl = this.headEl.createSpan({ cls: "mva-steps-elapsed", text: "" });
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

  /** Header text. Three registers, one per state of the run:
   *   - SETTLED with real work → the milestone line ("Edited 3 files, ran 2
   *     commands · 41s"): the turn is over, so the header answers what came of
   *     it rather than inventorying it.
   *   - OPEN with real work → the live inventory ("18 tools · 5 files edited").
   *   - no tool ever ran → the old "N steps" (a thinking-only burst never
   *     calls noteToolAdded), carrying the frozen duration once folded: the
   *     fold empties the elapsed span, so without this a thinking-only run
   *     would lose its "41s" on the way down. */
  private refreshLabel(): void {
    if (this.toolCount === 0) {
      this.labelEl.setText(stepsLabel(this.steps, this.closed ? this.frozenElapsed : ""));
      return;
    }
    const stats = { tools: this.toolCount, files: this.fileEdits.size, commands: this.commands };
    this.labelEl.setText(
      this.closed
        ? milestoneLine(stats, this.frozenElapsed)
        : summarizeSteps(stats.tools, stats.files, stats.commands)
    );
  }

  /** Open (or reuse) the live thinking step: expanded body, shimmer label. */
  startThinking(): void {
    if (this.thinkEl) return;
    this.thinkRaw = "";
    const step = this.bodyEl.createDiv({ cls: "mva-step-think is-active" });
    const head = step.createDiv({ cls: "mva-step-think-head mva-type-body" });
    setIcon(head.createSpan({ cls: "mva-reason-chevron" }), "chevron-right");
    this.thinkLabelEl = head.createSpan({ cls: "mva-step-think-label", text: "Thinking…" });
    clickable(head, () => step.toggleClass("is-collapsed", !step.hasClass("is-collapsed")));
    this.thinkBodyEl = step.createDiv({ cls: "mva-step-think-body" });
    this.thinkEl = step;
    this.steps++;
    this.refreshLabel();
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

  /** A tool card was appended into `body`: count it (structural + stats),
   *  settle any open thinking, refresh the header label. `name`/`input` drive
   *  the stats (file-edit dedup, command tally) — they're the same values the
   *  caller already has from the tool-call event. */
  noteToolAdded(name: string, input: unknown): void {
    this.settleThinking();
    this.steps++;
    this.toolCount++;
    const key = fileEditKey(name, input);
    if (key) this.fileEdits.add(key);
    if (isCommandTool(name)) this.commands++;
    this.refreshLabel();
  }

  /** Called once a second by the turn's ticker while this run is open; no-op
   *  once folded so an older block's elapsed time freezes rather than counting
   *  time it wasn't actually running. */
  tick(fmt: (ms: number) => string): void {
    if (this.closed) return;
    this.fmt = fmt;
    this.elapsedEl.setText(fmt(Date.now() - this.startedAt));
  }

  /** Remove a card from this run (note-touching rows dissolve into the
   *  touched-notes footer at turn end). Works on closed runs too: the folded
   *  label re-counts, and a run left empty removes itself. */
  dissolve(card: HTMLElement): void {
    if (card.parentElement !== this.bodyEl) return;
    card.remove();
    this.steps = Math.max(0, this.steps - 1);
    if (!this.closed) return;
    if (this.bodyEl.childElementCount === 0) {
      this.rootEl.remove();
      return;
    }
    this.refreshLabel();
  }

  /** Fold the run to its milestone line, body hidden, live states neutralized.
   *  Empty runs remove themselves. Sets a status glyph on the header — a
   *  check on a clean finish, an x when `interrupted` (stopped/errored).
   *  `scroller` (the conversation list element) gets its scrollTop compensated
   *  when the fold collapses content above the current reading position.
   *  Idempotent. */
  close(scroller?: HTMLElement, interrupted = false): void {
    if (this.closed) return;
    this.closed = true;
    this.settleThinking();
    if (this.steps === 0 || this.bodyEl.childElementCount === 0) {
      this.rootEl.remove();
      return;
    }
    // `is-settled` freezes the running text-shimmer inside a folded run. (A tool
    // still 'running' when the turn aborts is force-settled by runTurn's finally,
    // so its icon-pulse/elapsed stop too — this class only covers the name shimmer.)
    this.rootEl.addClass("is-settled");
    setIcon(this.statusEl, interrupted ? "x" : "check");
    this.statusEl.addClass(interrupted ? "is-error" : "is-ok");
    const before = this.rootEl.offsetHeight;
    // The duration moves INTO the milestone line and out of its own span: one
    // line is the whole point of the fold, and a header that says "41s" twice
    // in two places is two lines wearing a trench coat.
    this.frozenElapsed = this.fmt ? this.fmt(Date.now() - this.startedAt) : "";
    this.elapsedEl.setText("");
    this.refreshLabel();
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
