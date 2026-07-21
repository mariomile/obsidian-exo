/**
 * Exo memory-layer paths — one source of truth, all derived from a single
 * configurable root (`settings.memoryRoot`).
 *
 * Historically Exo's memory paths were ~127 hardcoded `_system/…` string
 * literals scattered across 34 files, which forced Mario's personal vault
 * structure onto every install. Centralizing them here makes the root a
 * one-line change and lets a fresh vault use a neutral, tool-owned folder
 * (`_exo/`) — or none at all — while an existing `_system/` vault keeps its
 * layout via boot-time auto-detect (see `detectMemoryRoot` + loadSettings).
 *
 * Pure module (no Obsidian imports) so it stays unit-testable, mirroring
 * `vault-setup.ts`.
 */

/** Default root for a fresh install: visible (indexed by Obsidian's TFile API,
 *  unlike a dotfolder), underscore-prefixed so it sorts to the top and reads as
 *  tool-owned, and human-readable so the user can inspect what Exo remembers. */
export const DEFAULT_MEMORY_ROOT = "_exo";

/** The legacy/marioverse root. A vault that already has this folder keeps it,
 *  so existing installs never migrate. */
export const LEGACY_MEMORY_ROOT = "_system";

/** Every vault-relative path Exo's memory features read or write, split into
 *  MECHANISM (the tool's own operational data — needed by any vault that uses
 *  memory features) and CONTENT (the marioverse knowledge-OS — scaffolded only
 *  by the opt-in "Full" template). */
export interface ExoPaths {
  root: string;
  // ── mechanism ────────────────────────────────────────────────────────────
  memory: string;
  store: string;
  orchestration: string;
  tasks: string;
  queue: string;
  reports: string;
  review: string;
  mentions: string;
  openLoops: string;
  knownFalse: string;
  sessionLog: string;
  workflowSignals: string;
  claudememSync: string;
  // ── content (marioverse "Full" template only) ────────────────────────────
  agentDir: string;
  vaultContext: string;
  preferences: string;
  mentalModel: string;
  rules: string;
  decisions: string;
  learnings: string;
}

/** Build the full path set from a root. Falls back to the default root when
 *  given an empty string, and trims any trailing slashes so callers can pass a
 *  user-entered value safely. */
export function exoPaths(root: string): ExoPaths {
  const r = (root || DEFAULT_MEMORY_ROOT).replace(/\/+$/, "");
  const memory = `${r}/memory`;
  return {
    root: r,
    memory,
    store: `${memory}/store`,
    orchestration: `${r}/orchestration`,
    tasks: `${r}/orchestration/tasks.md`,
    queue: `${r}/exo-queue`,
    reports: `${r}/reports`,
    review: `${r}/review.md`,
    mentions: `${r}/mentions`,
    openLoops: `${memory}/open-loops.md`,
    knownFalse: `${memory}/known-false.md`,
    sessionLog: `${memory}/session-log.md`,
    workflowSignals: `${memory}/workflow-signals.json`,
    claudememSync: `${memory}/claudemem-sync-state.json`,
    agentDir: `${r}/agent`,
    vaultContext: `${r}/vault-context.md`,
    preferences: `${memory}/preferences/preferences.md`,
    mentalModel: `${memory}/mental-model.md`,
    rules: `${memory}/rules`,
    decisions: `${memory}/decisions`,
    learnings: `${memory}/learnings`,
  };
}

/** Resolve the root for an install whose `memoryRoot` isn't set yet: a vault
 *  that already has a `_system/` layer keeps it (existing installs never
 *  migrate); everything else adopts the neutral `_exo/` default. The caller
 *  passes the precomputed existence check so this stays pure/testable. */
export function detectMemoryRoot(legacyExists: boolean): string {
  return legacyExists ? LEGACY_MEMORY_ROOT : DEFAULT_MEMORY_ROOT;
}
