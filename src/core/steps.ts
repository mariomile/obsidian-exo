/**
 * Steps-timeline membership (pure). Generic work (tool calls + thinking) folds
 * into the chronological "N steps" timeline. Note-touching calls (filePath
 * non-null) join the timeline too — their live row dissolves into the
 * touched-notes footer at turn end WITHOUT breaking the run, so a stretch of
 * work like Skill → read_note → search_vault folds as one run, not three.
 * Surfaces with their own live meaning stay flat and break the run:
 *   - background Bash + BashOutput/KillShell — their badge is live status
 * Interactive cards (permission/ask/plan/todos) never reach this decision;
 * their render paths close the run directly.
 */

export type StepPlacement = "timeline" | "flat";

export function stepPlacement(name: string, input: unknown): StepPlacement {
  if (name === "BashOutput" || name === "KillShell") return "flat";
  if (name === "Bash") {
    const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    if (i.run_in_background === true) return "flat";
  }
  return "timeline";
}

/** Fold-header label: "1 step" / "N steps" (no minimum threshold — 1 folds too). */
export function stepsLabel(n: number): string {
  return n === 1 ? "1 step" : `${n} steps`;
}
