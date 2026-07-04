/**
 * Pure helpers for the plan-approval card (Trust Pack). The CLI's ExitPlanMode
 * tool arrives through Exo's `permission-request` event; its input shape was
 * verified live against the SDK (spike): `{ plan: string (markdown),
 * planFilePath: string (absolute path to a saved copy) }`. `view.ts` renders
 * whatever `planInputParts` extracts; if the markdown is inline (the observed
 * case) no file read is needed, otherwise the caller reads `filePath`.
 */

export interface PlanInputParts {
  /** Inline plan markdown from `input.plan`, when present. */
  md: string | null;
  /** Absolute path to a saved plan file from `input.planFilePath`, when present. */
  filePath: string | null;
}

/** Extract the plan markdown + optional file path from an ExitPlanMode input,
 *  tolerating a few plausible field names in case the SDK shape shifts. */
export function planInputParts(input: unknown): PlanInputParts {
  const rec = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const md =
    typeof rec.plan === "string" && rec.plan.trim()
      ? rec.plan
      : typeof rec.markdown === "string" && rec.markdown.trim()
        ? (rec.markdown as string)
        : null;
  const filePath =
    typeof rec.planFilePath === "string" && rec.planFilePath.trim()
      ? rec.planFilePath
      : typeof rec.planPath === "string" && rec.planPath.trim()
        ? (rec.planPath as string)
        : null;
  return { md, filePath };
}

/** One-line recap summary for a persisted plan segment (used by buildRecap). */
export function planRecapLabel(approved: boolean | null): string {
  if (approved === true) return "[plan: approved]";
  if (approved === false) return "[plan: revised]";
  return "[plan: pending]";
}

/** Settled state line shown on a resolved plan card. `building` adds the live
 *  "— building" nuance right after approval; restored cards pass it false. */
export function planStateText(approved: boolean | null, building = false): string {
  if (approved === true) return building ? "Plan approved — building" : "Plan approved";
  if (approved === false) return "Revision requested";
  return "Plan proposed";
}
