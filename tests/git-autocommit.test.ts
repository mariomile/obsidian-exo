import { describe, it, expect } from "vitest";
import {
  initialAutoCommitState,
  recordVaultWrite,
  isCommitDue,
  shouldCommitNow,
  afterCommitCheck,
  formatCommitMessage,
  type AutoCommitState,
} from "../src/core/git-autocommit";

const DEBOUNCE_MS = 2 * 60 * 1000; // 2 minutes
const CADENCE_MS = 15 * 60 * 1000; // 15 minutes

describe("initialAutoCommitState", () => {
  it("starts with no pending writes and no history", () => {
    expect(initialAutoCommitState()).toEqual({
      pendingWriteCount: 0,
      lastWriteAt: null,
      lastCommitAt: null,
    });
  });
});

describe("recordVaultWrite", () => {
  it("defaults to 1 file when fileCount is omitted", () => {
    const s = recordVaultWrite(initialAutoCommitState(), 100);
    expect(s.pendingWriteCount).toBe(1);
    expect(s.lastWriteAt).toBe(100);
  });

  it("coalesces multiple writes: sums the count and advances lastWriteAt to the latest turn", () => {
    const s1 = recordVaultWrite(initialAutoCommitState(), 100, 2);
    const s2 = recordVaultWrite(s1, 150, 3);
    expect(s2.pendingWriteCount).toBe(5);
    expect(s2.lastWriteAt).toBe(150);
  });

  it("does not mutate the input state (pure)", () => {
    const s0 = initialAutoCommitState();
    const s1 = recordVaultWrite(s0, 100, 2);
    expect(s0).toEqual({ pendingWriteCount: 0, lastWriteAt: null, lastCommitAt: null });
    expect(s1).not.toBe(s0);
  });

  it("leaves lastCommitAt untouched", () => {
    const withHistory: AutoCommitState = { pendingWriteCount: 0, lastWriteAt: null, lastCommitAt: 50 };
    const s = recordVaultWrite(withHistory, 100);
    expect(s.lastCommitAt).toBe(50);
  });
});

describe("isCommitDue", () => {
  it("is due once the debounce quiet period has elapsed since the last write", () => {
    const state: AutoCommitState = { pendingWriteCount: 1, lastWriteAt: 1000, lastCommitAt: 1000 };
    expect(isCommitDue(state, 1000 + DEBOUNCE_MS - 1, DEBOUNCE_MS, CADENCE_MS)).toBe(false);
    expect(isCommitDue(state, 1000 + DEBOUNCE_MS, DEBOUNCE_MS, CADENCE_MS)).toBe(true);
  });

  it("is NOT due while writes keep landing inside the quiet period (coalescing)", () => {
    // A write lands, then another lands just before the debounce would have fired —
    // recordVaultWrite pushes lastWriteAt out, so the original deadline is no longer due.
    let state = recordVaultWrite(initialAutoCommitState(), 0, 1);
    state = { ...state, lastCommitAt: 0 };
    state = recordVaultWrite(state, DEBOUNCE_MS - 1, 1);
    // At the time the FIRST write's debounce would have fired, it's been reset.
    expect(isCommitDue(state, DEBOUNCE_MS, DEBOUNCE_MS, CADENCE_MS)).toBe(false);
    // But once the quiet period elapses after the SECOND (latest) write, it's due.
    expect(isCommitDue(state, DEBOUNCE_MS - 1 + DEBOUNCE_MS, DEBOUNCE_MS, CADENCE_MS)).toBe(true);
  });

  it("falls back to the periodic cadence even with no tracked write (external dirty tree)", () => {
    const state: AutoCommitState = { pendingWriteCount: 0, lastWriteAt: null, lastCommitAt: 1000 };
    expect(isCommitDue(state, 1000 + CADENCE_MS - 1, DEBOUNCE_MS, CADENCE_MS)).toBe(false);
    expect(isCommitDue(state, 1000 + CADENCE_MS, DEBOUNCE_MS, CADENCE_MS)).toBe(true);
  });

  it("is due on the very first-ever check (no commit history yet) — captures a baseline", () => {
    expect(isCommitDue(initialAutoCommitState(), 0, DEBOUNCE_MS, CADENCE_MS)).toBe(true);
  });

  it("is not due when neither the debounce nor the cadence window has elapsed", () => {
    const state: AutoCommitState = { pendingWriteCount: 1, lastWriteAt: 900, lastCommitAt: 900 };
    expect(isCommitDue(state, 950, DEBOUNCE_MS, CADENCE_MS)).toBe(false);
  });
});

describe("shouldCommitNow", () => {
  const dueState: AutoCommitState = { pendingWriteCount: 2, lastWriteAt: 0, lastCommitAt: 0 };
  const base = {
    enabled: true,
    isGitRepo: true,
    gitAvailable: true,
    worktreeDirty: true,
    state: dueState,
    now: DEBOUNCE_MS,
    debounceMs: DEBOUNCE_MS,
    cadenceMs: CADENCE_MS,
  };

  it("commits when every gate is open and the debounce/cadence window is due", () => {
    expect(shouldCommitNow(base)).toBe(true);
  });

  it("is a no-op when the feature is disabled", () => {
    expect(shouldCommitNow({ ...base, enabled: false })).toBe(false);
  });

  it("is a no-op when the vault is not a git repo", () => {
    expect(shouldCommitNow({ ...base, isGitRepo: false })).toBe(false);
  });

  it("is a no-op when the git binary is unavailable", () => {
    expect(shouldCommitNow({ ...base, gitAvailable: false })).toBe(false);
  });

  it("is a no-op when the worktree is clean (nothing to commit)", () => {
    expect(shouldCommitNow({ ...base, worktreeDirty: false })).toBe(false);
  });

  it("is a no-op when nothing is due yet, even if everything else is green", () => {
    const notDueState: AutoCommitState = { pendingWriteCount: 1, lastWriteAt: 900, lastCommitAt: 900 };
    expect(shouldCommitNow({ ...base, state: notDueState, now: 950 })).toBe(false);
  });
});

describe("afterCommitCheck", () => {
  it("resets pending writes and stamps lastCommitAt, whether or not a commit actually ran", () => {
    const state: AutoCommitState = { pendingWriteCount: 4, lastWriteAt: 500, lastCommitAt: 100 };
    expect(afterCommitCheck(state, 999)).toEqual({
      pendingWriteCount: 0,
      lastWriteAt: null,
      lastCommitAt: 999,
    });
  });
});

describe("formatCommitMessage", () => {
  it("uses singular phrasing for exactly one file", () => {
    expect(formatCommitMessage(1)).toBe("exo: auto-commit — 1 file");
  });

  it("uses plural phrasing for multiple files", () => {
    expect(formatCommitMessage(3)).toBe("exo: auto-commit — 3 files");
  });

  it("falls back to a generic message when the count is unknown (undefined)", () => {
    expect(formatCommitMessage(undefined)).toBe("exo: auto-commit — vault changes");
  });

  it("falls back to a generic message when the count is 0 or invalid", () => {
    expect(formatCommitMessage(0)).toBe("exo: auto-commit — vault changes");
    expect(formatCommitMessage(-1)).toBe("exo: auto-commit — vault changes");
    expect(formatCommitMessage(Number.NaN)).toBe("exo: auto-commit — vault changes");
  });

  it("uses the descriptive summary when one is given (overrides the file count)", () => {
    expect(formatCommitMessage(7, "dream — merged 3, superseded 1, imported 12 from claude-mem")).toBe(
      "exo: dream — merged 3, superseded 1, imported 12 from claude-mem"
    );
  });

  it("uses the summary even when the file count is unknown", () => {
    expect(formatCommitMessage(undefined, "dream — imported 4 from claude-mem")).toBe(
      "exo: dream — imported 4 from claude-mem"
    );
  });

  it("ignores a blank/whitespace summary and falls back to the file count", () => {
    expect(formatCommitMessage(2, "   ")).toBe("exo: auto-commit — 2 files");
    expect(formatCommitMessage(2, "")).toBe("exo: auto-commit — 2 files");
  });
});
