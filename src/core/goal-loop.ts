/**
 * Pure state machine behind the `/goal` command. Zero Obsidian — it only
 * decides what should happen after each turn; `view.ts` executes the effects
 * (send the re-prompt, render the pill). Mirrors the native `/goal`, which
 * keeps working across turns until a condition is met (implemented in the CLI
 * as a Stop hook; here as an Exo-orchestrated re-prompt loop).
 */

export type GoalStatus = "active" | "paused" | "met" | "idle";
export type GoalAction = "continue" | "ask-confirm" | "met" | "idle";

export interface GoalState {
  condition: string;
  /** Total re-prompts across all windows (survives a resume). */
  iterations: number;
  /** Re-prompts in the current window; resets to 0 on resume. */
  windowRuns: number;
  /** Per-window cap; at this many windowRuns we pause and ask to continue. */
  maxIterations: number;
  setAt: number;
  status: GoalStatus;
}

/** Distinctive so an incidental mention in prose can't false-positive. */
export const GOAL_MET_SENTINEL = "<<<GOAL_MET>>>";

export function setGoal(condition: string, maxIterations: number, now: number): GoalState {
  return {
    condition,
    iterations: 0,
    windowRuns: 0,
    maxIterations,
    setAt: now,
    status: "active",
  };
}

export function clearGoal(state: GoalState): GoalState {
  return { ...state, status: "idle" };
}

/** Reopen a paused goal for another window; keep the running total. */
export function resumeGoal(state: GoalState): GoalState {
  return { ...state, status: "active", windowRuns: 0 };
}

/** True only when the sentinel stands alone on a line. */
export function detectMet(assistantText: string): boolean {
  return assistantText
    .split("\n")
    .some((line) => line.trim() === GOAL_MET_SENTINEL);
}

/**
 * Record the just-finished turn and decide the next action. Returns the new
 * state and what the caller should do. Never mutates the input.
 */
export function advance(
  state: GoalState,
  assistantText: string
): { next: GoalState; action: GoalAction } {
  if (state.status === "idle" || state.status === "met") {
    return { next: state, action: "idle" };
  }
  const bumped: GoalState = {
    ...state,
    iterations: state.iterations + 1,
    windowRuns: state.windowRuns + 1,
  };
  if (detectMet(assistantText)) {
    return { next: { ...bumped, status: "met" }, action: "met" };
  }
  if (bumped.windowRuns >= bumped.maxIterations) {
    return { next: { ...bumped, status: "paused" }, action: "ask-confirm" };
  }
  return { next: { ...bumped, status: "active" }, action: "continue" };
}

export function buildContinuationPrompt(condition: string): string {
  return (
    `Goal still active: "${condition}".\n` +
    `If it is fully satisfied, reply with ${GOAL_MET_SENTINEL} on its own line ` +
    `and nothing else. Otherwise, keep working toward it now.`
  );
}
