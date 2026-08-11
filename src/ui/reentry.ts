/**
 * The re-entry surfaces: the "since you left" line and the resume verbs.
 *
 * Both are painted here rather than in `view.ts` for the usual reason — that
 * file is at its size ceiling — but also because neither is transcript
 * behaviour: they are the frame around a transcript you are returning to.
 * Every decision about WHAT they say lives in `core/reentry.ts`; this file owns
 * the elements, where they are inserted, and what a click goes to.
 *
 * Two rules that are structural, not stylistic:
 *
 *  1. **No width gate.** The Recap Rail is main-area-and-wide only, because it
 *     is a second column and a 300px sidebar has no room for one. The re-entry
 *     line is a single row inside the column that already exists, and the user
 *     who most needs it is precisely the sidebar user — so nothing here reads
 *     a width.
 *  2. **The streaming invariant.** While a turn is streaming exactly one of
 *     {working row, open card, caret} is live. Neither surface paints then:
 *     the band returns early, and the verbs are empty by construction
 *     (`resumeVerbs`).
 */
import { setIcon } from "obsidian";
import { clickable } from "./dom";
import type { Convo } from "./convo-types";
import type { ComposerDraft } from "./composer";
import {
  advanceReadIndex,
  planReveal,
  reentrySlots,
  resumeVerbs,
  type ReentrySlotKey,
  type ResumeVerb,
} from "../core/reentry";

const BAND = "mva-reentry";
const VERBS = "mva-resume-verbs";

/**
 * The read position after a turn ENDS, which is the other half of the
 * lifecycle and the one that is easy to forget: a reveal reads the chat you
 * switch to, and this reads the chat you are already looking at.
 *
 * Without it the position only moves on a tab switch, so the next switch back
 * reports as news the twelve steps and three files you sat and watched land —
 * and prints them above the prompt you typed yourself.
 *
 *  - `active`: this is the conversation the view is showing. Its complement is
 *    the existing unread dot, which is the same question asked of the strip.
 *  - `visible`: the pane itself is on screen. A turn that finished while the
 *    Exo pane was behind another Obsidian tab is exactly the work the band
 *    exists to report, so it must NOT count as read.
 */
export function noteTurnEnd(c: Convo, seen: { active: boolean; visible: boolean }): void {
  if (!seen.active) c.unread = true;
  else if (seen.visible) c.readIndex = advanceReadIndex(c.messages.length);
}

/**
 * Reveal a conversation: paint the "since you left" line at the last-read
 * position, then move the read position to the end.
 *
 * Advancing on reveal is what makes the line dissolve and never come back for
 * the same position — the next reveal computes its work over an empty stretch.
 * A streaming conversation is left completely alone, position included: reading
 * a chat mid-turn must not silently swallow the news of what it did while you
 * were away.
 *
 * `onOpenNote` is the files slot's target. Everything else scrolls inside the
 * transcript, so no other host service is needed. `onRead` fires only when the
 * position actually moved: it is how the caller gets the new number onto disk,
 * and a band that was read in a session that then quit without touching
 * anything else would otherwise come back on the next launch.
 */
export function revealReentry(
  c: Convo,
  onOpenNote: (path: string) => void,
  onRead?: () => void,
): void {
  c.listEl.querySelector(`.${BAND}`)?.remove();
  const decision = planReveal({
    messages: c.messages,
    readIndex: c.readIndex,
    streaming: c.streaming,
  });
  if (decision.readIndex !== null && decision.readIndex !== c.readIndex) {
    c.readIndex = decision.readIndex;
    onRead?.();
  }
  if (!decision.band) return;
  const { work, anchor: anchorIndex } = decision.band;

  const band = createDiv({ cls: `${BAND} mva-type-eyebrow` });
  band.createSpan({ cls: "mva-reentry-lede", text: "since you left" });
  for (const slot of reentrySlots(work)) {
    const el = band.createSpan({ cls: "mva-reentry-slot", text: slot.label });
    el.dataset.slot = slot.key;
    if (!slot.populated) {
      // An empty slot renders nothing (`styles.css` hides it): what is fixed is
      // the ORDER, so the second number you read always means files.
      el.addClass("is-empty");
      el.setText("");
      continue;
    }
    el.addClass("is-populated");
    clickable(el, () => {
      // Navigate FIRST: the targets are found relative to the band's position
      // in the transcript, and a detached band is positioned nowhere.
      goToSlot(c, band, slot.key, work.paths, onOpenNote);
      band.remove(); // acted on — the line has done its job
    });
  }

  // At the last-read position: immediately before the first turn the user has
  // not seen. `.mva-turn` is one element per message, in message order, so the
  // anchor index IS the DOM index.
  const turns = c.listEl.querySelectorAll(".mva-turn");
  const anchor = turns.item(anchorIndex);
  if (anchor) c.listEl.insertBefore(band, anchor);
  else c.listEl.appendChild(band);
}

/** Where a populated slot goes. Steps and questions are places in the
 *  transcript below the line; files are a note, which is not in the transcript
 *  at all. */
function goToSlot(
  c: Convo,
  band: HTMLElement,
  key: ReentrySlotKey,
  paths: readonly string[],
  onOpenNote: (path: string) => void,
): void {
  if (key === "files") {
    if (paths.length) onOpenNote(paths[0]);
    return;
  }
  const selector = key === "steps" ? ".mva-steps" : ".mva-ask, .mva-plan-card";
  const target = findAfter(c.listEl, band, selector);
  if (!target) return;
  // A folded run that you were sent to should be open: the click asked to see
  // the steps, not to see where they are.
  if (key === "steps") target.removeClass("is-collapsed");
  target.scrollIntoView({ block: "center" });
}

/** The first element matching `selector` that sits after `after` in document
 *  order — the unread stretch is below the band, and the same selectors match
 *  plenty of already-read turns above it. */
function findAfter(root: HTMLElement, after: HTMLElement, selector: string): HTMLElement | null {
  const all = Array.from(root.querySelectorAll(selector)) as HTMLElement[];
  return (
    all.find((el) => (after.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) ??
    null
  );
}

/** What the verbs need from the composer: whether it is empty, and how to put
 *  text into it. Structural so this file never imports the composer class. */
export interface ResumeComposer {
  getDraft(): ComposerDraft;
  insertText(text: string): void;
  focusInput(): void;
}

/**
 * Repaint the resume verbs above the composer for the conversation on screen.
 * Idempotent and cheap: the bar is two or three chips, so it is rebuilt rather
 * than reconciled, and it is removed outright whenever the state offers none.
 *
 * `host` is the composer's own parent (`listWrap`); the bar is inserted before
 * the composer so it reads as a lead-in to the empty input rather than as a
 * footer under the transcript.
 */
export function renderResumeVerbs(host: HTMLElement, c: Convo, composer: ResumeComposer): void {
  host.querySelector(`.${VERBS}`)?.remove();
  const verbs = resumeVerbs({
    streaming: c.streaming,
    pendingPerm: c.pendingPerm != null,
    pendingAsk: c.pendingAsk != null,
    stopped: c.stopped,
    poisoned: !!c.resumeRisky,
    hasMessages: c.messages.length > 0,
    draftEmpty: composer.getDraft().text.trim().length === 0,
  });
  if (!verbs.length) return;

  const bar = createDiv({ cls: `${VERBS} mva-type-eyebrow` });
  for (const verb of verbs) {
    const chip = bar.createSpan({ cls: "mva-resume-verb" });
    setIcon(chip.createSpan({ cls: "mva-resume-verb-ico" }), ICONS[verb.key]);
    chip.createSpan({ text: verb.label });
    clickable(chip, () => runVerb(host, c, composer, verb));
  }
  const composerEl = host.querySelector(".mva-composer");
  if (composerEl) host.insertBefore(bar, composerEl);
  else host.appendChild(bar);

  // The verbs are a fast path INTO an empty composer, so they stand down the
  // moment the user starts writing one of their own. Listening on the textarea
  // rather than repainting from the view keeps a keystroke off the view's
  // repaint path entirely — this is one class toggle, not a rebuild.
  const input = host.querySelector(".mva-input") as HTMLTextAreaElement | null;
  if (!input) return;
  syncVerbVisibility(host, input);
  // Bound ONCE per textarea, and it looks the bar up on every keystroke rather
  // than closing over the one that existed when it was bound. This function
  // runs on every state transition; a listener per call would accumulate one
  // per repaint, each holding a bar that was thrown away turns ago.
  if (input.dataset.exoResumeVerbs === "1") return;
  input.dataset.exoResumeVerbs = "1";
  input.addEventListener("input", () => syncVerbVisibility(host, input));
}

function syncVerbVisibility(host: HTMLElement, input: HTMLTextAreaElement): void {
  const bar = host.querySelector(`.${VERBS}`);
  bar?.toggleClass("is-hidden", input.value.trim().length > 0);
}

const ICONS: Record<ResumeVerb["key"], string> = {
  resume: "play",
  "course-correct": "corner-up-right",
  approve: "check",
};

/** Approve settles the open permission where it stands; the message verbs seed
 *  the composer and hand the user the cursor — the verb is a starting point,
 *  not a turn nobody asked for. */
function runVerb(host: HTMLElement, c: Convo, composer: ResumeComposer, verb: ResumeVerb): void {
  if (verb.key === "approve") {
    c.pendingDecision?.allow();
    host.querySelector(`.${VERBS}`)?.remove();
    return;
  }
  if (verb.prompt) composer.insertText(verb.prompt);
  composer.focusInput();
  host.querySelector(`.${VERBS}`)?.remove();
}
