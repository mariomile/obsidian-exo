/**
 * Single source of truth for which feedback affordance is on screen during a
 * turn. Extracted as a pure function so the no-freeze invariant is unit-testable
 * without the Obsidian DOM.
 *
 * Replaces the removed `TurnWatchdog`: Codex/Claude Code never kill a turn on a
 * client timer — they keep an always-visible, interruptible working state and
 * let the user press Esc. The invariant this enforces is exactly that: while a
 * turn is streaming, one of {working row, open card, streaming caret} is ALWAYS
 * visible, so the turn can never look dead ("incantato").
 */
export type WorkingState = {
  /** The conversation's turn is in flight. */
  streaming: boolean;
  /** Interactive cards awaiting the user (permission / ask_user / plan). */
  openCards: number;
  /** A text segment is actively streaming (the caret is the live feedback). */
  textStreaming: boolean;
};

export type Affordance = "working" | "card" | "caret" | "none";

/**
 * Decide the single affordance to show. Precedence while streaming:
 *   card > caret > working. The `working` fallback is what guarantees a silent
 *   turn (model went quiet after thinking) still shows an interruptible row.
 */
export function workingAffordance(s: WorkingState): Affordance {
  if (!s.streaming) return "none";
  if (s.openCards > 0) return "card";
  if (s.textStreaming) return "caret";
  return "working";
}
