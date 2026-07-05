/**
 * Model → tuning-capability map: which effort tiers each model supports.
 * The composer's Effort control derives from the chosen model (it hides for
 * models with no effort support, and offers only that model's tiers).
 *
 * Source of truth: the claude-api reference (checked 2026-07-05):
 * - `xhigh` exists on Opus 4.7+, Opus 4.8, Fable 5, Sonnet 5.
 * - `max` exists on Opus 4.6 and later, Sonnet 4.6 and later.
 * - Haiku 4.5 (and earlier Sonnets) reject `effort` outright.
 * - Codex `model_reasoning_effort` accepts low..xhigh — no `max`.
 * Unknown/custom Claude ids get the full ladder: a wrong tier degrades to a
 * CLI warning, while hiding the control would block valid new models.
 */
export type EffortOption = [value: string, label: string];

const LADDER: EffortOption[] = [
  ["default", "Default"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Max"],
];

const pick = (...values: string[]): EffortOption[] =>
  LADDER.filter(([v]) => v === "default" || values.includes(v));

/** Effort tiers for a model, or `null` when the model has no effort support
 *  (the caller hides the control). */
export function effortOptionsFor(
  provider: "claude" | "codex",
  modelId: string
): EffortOption[] | null {
  const id = (modelId || "").toLowerCase();
  if (provider === "codex") return pick("low", "medium", "high", "xhigh");
  if (id.includes("haiku")) return null;
  if (id.includes("opus-4-6") || id.includes("sonnet-4-6")) return pick("low", "medium", "high", "max");
  return pick("low", "medium", "high", "xhigh", "max");
}

/** Keep the current effort only when the model offers it; otherwise fall back
 *  to "default" (the CLI's own choice) so an invalid tier never reaches the
 *  provider (Codex rejects `model_reasoning_effort="max"`, Claude warns). */
export function clampEffort(effort: string, options: EffortOption[] | null): string {
  if (!options) return "default";
  return options.some(([v]) => v === effort) ? effort : "default";
}
