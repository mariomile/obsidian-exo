/**
 * Git auto-commit safety net — pure decision logic.
 *
 * Purpose: before Exo gains autonomous write capability, every agent-driven
 * vault mutation must be recoverable via `git`. This module decides WHEN a
 * commit should run and WHAT its message should say; it never touches the
 * filesystem or spawns a process. The impure shell (main.ts) owns:
 *   - resolving the vault's base path,
 *   - checking whether it's a git repo / the `git` binary exists,
 *   - running `git status --porcelain` to learn `worktreeDirty`,
 *   - running `git add -A` + `git commit -m …` via `child_process.execFile`.
 *
 * No 'obsidian' import here — deliberately, so this is unit-testable with
 * plain injected timestamps and booleans, no mocks required.
 */

/** Debounce/cadence bookkeeping. Immutable — every function below returns a
 *  new state rather than mutating its input. */
export interface AutoCommitState {
  /** Files written since the last commit attempt (tracked turns only; the
   *  periodic cadence sweep can still fire a commit with this at 0 if the
   *  worktree is dirty from an untracked/external change). */
  pendingWriteCount: number;
  /** Timestamp (ms) of the most recent tracked vault write, or null if none
   *  is pending. Each new write pushes this forward, which is what makes the
   *  debounce coalesce a burst of writes into a single quiet-period wait. */
  lastWriteAt: number | null;
  /** Timestamp (ms) of the last commit *check* (whether or not it actually
   *  committed anything), or null if none has ever run. Drives the periodic
   *  cadence fallback. */
  lastCommitAt: number | null;
}

/** Fresh state for a new session (e.g. plugin load). */
export function initialAutoCommitState(): AutoCommitState {
  return { pendingWriteCount: 0, lastWriteAt: null, lastCommitAt: null };
}

/** Record that `fileCount` file(s) were written at `now`. Coalesces into any
 *  already-pending window rather than starting a separate one: the count
 *  accumulates and `lastWriteAt` advances to this write, which is what
 *  restarts the debounce quiet period on every subsequent call. Pure — the
 *  input state is never mutated. */
export function recordVaultWrite(state: AutoCommitState, now: number, fileCount = 1): AutoCommitState {
  return {
    ...state,
    pendingWriteCount: state.pendingWriteCount + Math.max(1, fileCount),
    lastWriteAt: now,
  };
}

/**
 * True once it's time to attempt a commit check, independent of whether
 * there's actually anything to commit (that's `worktreeDirty`, learned by the
 * impure shell right before acting on this). Two independent timers, either
 * one firing is enough:
 *
 *  - **debounce**: `lastWriteAt + debounceMs` — the quiet period after the
 *    most recent tracked write. Coalesces a burst of writes into one commit.
 *  - **cadence**: `lastCommitAt + cadenceMs` — a periodic safety net that
 *    fires even with no tracked write (e.g. the tree went dirty from an
 *    external edit, or the debounce was somehow missed). `lastCommitAt ===
 *    null` (never checked before) counts as immediately due, so the very
 *    first tick after enabling the feature captures a baseline.
 */
export function isCommitDue(state: AutoCommitState, now: number, debounceMs: number, cadenceMs: number): boolean {
  const debounceElapsed = state.lastWriteAt !== null && now - state.lastWriteAt >= debounceMs;
  const cadenceElapsed = state.lastCommitAt === null || now - state.lastCommitAt >= cadenceMs;
  return debounceElapsed || cadenceElapsed;
}

/** Everything the should-commit decision needs. `worktreeDirty` and the git
 *  gates are supplied by the caller (only worth fetching once `isCommitDue`
 *  says it's worth checking — see main.ts). */
export interface ShouldCommitInput {
  /** The `vaultAutoCommit` setting. */
  enabled: boolean;
  /** The vault's base path is inside a git working tree. */
  isGitRepo: boolean;
  /** The `git` binary resolved and ran successfully. */
  gitAvailable: boolean;
  /** `git status --porcelain` returned non-empty output. */
  worktreeDirty: boolean;
  state: AutoCommitState;
  now: number;
  debounceMs: number;
  cadenceMs: number;
}

/** The single should-commit decision — every no-op condition (feature off,
 *  not a repo, git missing, nothing dirty, not due yet) is gated here so
 *  every call site agrees. */
export function shouldCommitNow(input: ShouldCommitInput): boolean {
  if (!input.enabled) return false;
  if (!input.isGitRepo) return false;
  if (!input.gitAvailable) return false;
  if (!input.worktreeDirty) return false;
  return isCommitDue(input.state, input.now, input.debounceMs, input.cadenceMs);
}

/** Reset the debounce/cadence bookkeeping after a commit *check* has run —
 *  whether it actually committed or found the tree clean. Called exactly
 *  once per check so the next cycle starts from a clean slate. */
export function afterCommitCheck(state: AutoCommitState, now: number): AutoCommitState {
  return { pendingWriteCount: 0, lastWriteAt: null, lastCommitAt: now };
}

/** Commit message: `exo: auto-commit — N file(s)`, singular/plural handled.
 *  An unknown or non-positive count (undefined, 0, negative, NaN) falls back
 *  to a generic message rather than printing something like "0 files" or
 *  "NaN files".
 *
 *  An optional `summary` (e.g. the dream pass's "dream — merged 3, superseded 1,
 *  imported 12 from claude-mem") overrides the file-count phrasing entirely,
 *  producing `exo: <summary>`. A blank/whitespace-only summary is ignored and the
 *  file-count path is used, so callers can pass an empty string unconditionally. */
export function formatCommitMessage(fileCount?: number | null, summary?: string): string {
  const trimmed = summary?.trim();
  if (trimmed) return `exo: ${trimmed}`;
  if (fileCount === undefined || fileCount === null || !Number.isFinite(fileCount) || fileCount <= 0) {
    return "exo: auto-commit — vault changes";
  }
  const n = Math.floor(fileCount);
  return `exo: auto-commit — ${n} file${n === 1 ? "" : "s"}`;
}
