import { describe, it, expect } from "vitest";
import {
  compactCount,
  formatBudget,
  formatAge,
  memoryStats,
  memoryActions,
  systemStatuses,
} from "../src/core/actions-hub";
import type { MemoryEntry } from "../src/core/memory-store";
import type { LoopEntry } from "../src/core/open-loops";
import type { BudgetLedger } from "../src/core/background-budget";

const NOW = Date.UTC(2026, 6, 6, 12, 0, 0); // 2026-07-06 12:00 UTC

function entry(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: `mem-${over.id ?? "1"}`,
    kind: "fact",
    at: NOW,
    session: "s1",
    tags: [],
    source: "user",
    text: "x",
    ...over,
  };
}

function loop(over: Partial<LoopEntry> = {}): LoopEntry {
  return {
    id: `loop-${over.id ?? "1"}`,
    title: "t",
    note: "n",
    openedAt: NOW,
    status: "open",
    ...over,
  };
}

describe("compactCount", () => {
  it("passes through small counts", () => {
    expect(compactCount(0)).toBe("0");
    expect(compactCount(500)).toBe("500");
    expect(compactCount(999)).toBe("999");
  });
  it("compacts thousands and millions", () => {
    expect(compactCount(1000)).toBe("1k");
    expect(compactCount(12000)).toBe("12k");
    expect(compactCount(200000)).toBe("200k");
    expect(compactCount(12345)).toBe("12.3k");
    expect(compactCount(1_500_000)).toBe("1.5M");
  });
  it("guards non-finite / negative", () => {
    expect(compactCount(NaN)).toBe("0");
    expect(compactCount(-5)).toBe("0");
    expect(compactCount(Infinity)).toBe("0");
  });
});

describe("formatBudget", () => {
  const led: BudgetLedger = { dateUTC: "2026-07-06", tokensUsed: 12000 };
  it("shows used/budget compacted", () => {
    expect(formatBudget(led, 200000, NOW)).toBe("12k/200k");
  });
  it("rolls a stale day's counter to zero", () => {
    const stale: BudgetLedger = { dateUTC: "2026-07-01", tokensUsed: 99999 };
    expect(formatBudget(stale, 200000, NOW)).toBe("0/200k");
  });
  it("renders a non-positive budget as unlimited", () => {
    expect(formatBudget(led, 0, NOW)).toBe("12k/∞");
    expect(formatBudget(led, -1, NOW)).toBe("12k/∞");
  });
});

describe("formatAge", () => {
  it("returns the fallback for null / non-positive / non-finite", () => {
    expect(formatAge(null, NOW, "never")).toBe("never");
    expect(formatAge(0, NOW, "—")).toBe("—");
    expect(formatAge(NaN, NOW, "—")).toBe("—");
    expect(formatAge(undefined, NOW, "never")).toBe("never");
  });
  it("buckets recent ages", () => {
    expect(formatAge(NOW - 10_000, NOW, "—")).toBe("just now");
    expect(formatAge(NOW - 5 * 60_000, NOW, "—")).toBe("5m ago");
    expect(formatAge(NOW - 3 * 3_600_000, NOW, "—")).toBe("3h ago");
    expect(formatAge(NOW - 2 * 86_400_000, NOW, "—")).toBe("2d ago");
  });
  it("falls back to an absolute date past 30 days", () => {
    const then = Date.UTC(2026, 0, 15, 12, 0, 0);
    expect(formatAge(then, NOW, "—")).toMatch(/^2026-01-15$/);
  });
  it("treats a future timestamp as just now (clock skew)", () => {
    expect(formatAge(NOW + 60_000, NOW, "—")).toBe("just now");
  });
});

describe("memoryStats", () => {
  const ledger: BudgetLedger = { dateUTC: "2026-07-06", tokensUsed: 12000 };
  it("counts store totals, @generated, loops, dream age and budget", () => {
    const stats = memoryStats({
      storeEntries: [entry({ id: "1" }), entry({ id: "2", source: "generated" }), entry({ id: "3", source: "generated" })],
      loops: [
        loop({ id: "1" }), // open, no resurface → due
        loop({ id: "2", resurface: "2026-07-10" }), // open, future → not due
        loop({ id: "3", status: "closed", closedAt: NOW }), // closed
      ],
      ledger,
      dailyBudget: 200000,
      lastDreamPass: NOW - 3 * 3_600_000,
      now: NOW,
    });
    expect(stats).toEqual([
      { label: "Store", value: "3 · 2 gen" },
      { label: "Loops", value: "2 open · 1 due" },
      { label: "Dream", value: "3h ago" },
      { label: "Budget", value: "12k/200k" },
    ]);
  });
  it("shows never for a zero lastDreamPass and empty stores", () => {
    const stats = memoryStats({
      storeEntries: [],
      loops: [],
      ledger: { dateUTC: "", tokensUsed: 0 },
      dailyBudget: 200000,
      lastDreamPass: 0,
      now: NOW,
    });
    expect(stats[0]).toEqual({ label: "Store", value: "0 · 0 gen" });
    expect(stats[1]).toEqual({ label: "Loops", value: "0 open · 0 due" });
    expect(stats[2]).toEqual({ label: "Dream", value: "never" });
    expect(stats[3]).toEqual({ label: "Budget", value: "0/200k" });
  });
});

describe("memoryActions", () => {
  it("emits the base four rows with dream-undo disabled and no review", () => {
    const rows = memoryActions({ snapshotPresent: false, reviewExists: false, loops: [], now: NOW, dreamLlmEnabled: true });
    expect(rows.map((r) => r.id)).toEqual(["dream-run", "dream-undo", "open-store", "open-loops"]);
    expect(rows.find((r) => r.id === "dream-undo")!.enabled).toBe(false);
    expect(rows.find((r) => r.id === "open-loops")!.badge).toBeUndefined();
  });
  it("enables undo with a snapshot and appends the review row when it exists", () => {
    const rows = memoryActions({ snapshotPresent: true, reviewExists: true, loops: [], now: NOW, dreamLlmEnabled: true });
    expect(rows.find((r) => r.id === "dream-undo")!.enabled).toBe(true);
    expect(rows.map((r) => r.id)).toContain("open-review");
  });
  it("badges open-loops with the due count", () => {
    const rows = memoryActions({
      snapshotPresent: false,
      reviewExists: false,
      loops: [loop({ id: "1" }), loop({ id: "2" })],
      now: NOW,
      dreamLlmEnabled: true,
    });
    expect(rows.find((r) => r.id === "open-loops")!.badge).toBe("2 due");
  });
  it("hints dream-run as LLM-stage-off without disabling it", () => {
    const rows = memoryActions({ snapshotPresent: false, reviewExists: false, loops: [], now: NOW, dreamLlmEnabled: false });
    const dreamRun = rows.find((r) => r.id === "dream-run")!;
    expect(dreamRun.enabled).toBe(true);
    expect(dreamRun.hint).toBe("LLM stage off");
  });
  it("carries no hint on dream-run once the LLM stage is on", () => {
    const rows = memoryActions({ snapshotPresent: false, reviewExists: false, loops: [], now: NOW, dreamLlmEnabled: true });
    expect(rows.find((r) => r.id === "dream-run")!.hint).toBeUndefined();
  });
});

describe("systemStatuses", () => {
  it("reflects auto-commit on with a last-commit age", () => {
    const [ac, obs] = systemStatuses({
      vaultAutoCommit: true,
      lastAutoCommitEpoch: NOW - 2 * 3_600_000,
      selfWritingMemory: true,
      observerCadence: "session-end",
      observerStepInterval: 25,
      now: NOW,
    });
    expect(ac).toEqual({ id: "autocommit", label: "Auto-commit", value: "on · 2h ago", enabled: true });
    expect(obs).toEqual({ id: "observer", label: "Observer", value: "on · session-end", enabled: true });
  });
  it("shows a dash placeholder while the git fetch is pending", () => {
    const [ac] = systemStatuses({
      vaultAutoCommit: true,
      lastAutoCommitEpoch: null,
      selfWritingMemory: false,
      observerCadence: "session-end",
      observerStepInterval: 25,
      now: NOW,
    });
    expect(ac.value).toBe("on · —");
  });
  it("renders off states and the every-n-steps cadence", () => {
    const [ac, obs] = systemStatuses({
      vaultAutoCommit: false,
      lastAutoCommitEpoch: null,
      selfWritingMemory: true,
      observerCadence: "every-n-steps",
      observerStepInterval: 10,
      now: NOW,
    });
    expect(ac).toEqual({ id: "autocommit", label: "Auto-commit", value: "off", enabled: false });
    expect(obs.value).toBe("on · every 10 steps");
  });
});
