/**
 * Pure mapping from the active permission (Claude) or sandbox (Codex) mode to a
 * three-level risk class for the toolbar's always-visible permission dot. Kept
 * DOM-free so the color mapping is unit-testable. The classes reuse the existing
 * risk palette (`is-caution` amber, `is-danger` red); `is-ok` is the neutral/soft
 * resting state.
 */
import type { ProviderId } from "../providers/types";

export type DotRisk = "is-ok" | "is-caution" | "is-danger";

/**
 * Claude: bypass → danger; acceptEdits/auto → caution; default/ask/plan → ok.
 * Codex:  full-access → danger; workspace-write → caution; read-only → ok.
 */
export function permDotRisk(provider: ProviderId, mode: string): DotRisk {
  if (provider === "codex") {
    if (mode === "danger-full-access") return "is-danger";
    if (mode === "workspace-write") return "is-caution";
    return "is-ok";
  }
  if (mode === "bypassPermissions") return "is-danger";
  if (mode === "acceptEdits" || mode === "auto") return "is-caution";
  return "is-ok";
}
