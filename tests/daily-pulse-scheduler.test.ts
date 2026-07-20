import { describe, expect, it, vi } from "vitest";
import type { AutomationConfig } from "../src/core/automations";
import {
  DAILY_PULSE_AUTOMATION_NAME,
  DailyPulseSlotRunner,
  createDailyPulseAutomation,
  dailyPulseReviewAfterRun,
  dailyPulseNeedsReview,
  initialDailyPulseReviewState,
  runDailyPulseSlot,
  seedDailyPulseAutomation,
} from "../src/core/daily-pulse";

const at = (y: number, month: number, day: number, hour = 0, minute = 0) =>
  new Date(y, month - 1, day, hour, minute).getTime();

describe("Daily Pulse automation seed", () => {
  it("seeds exactly one disabled daily 08:00 local config", () => {
    const seeded = seedDailyPulseAutomation([], false);

    expect(seeded.changed).toBe(true);
    expect(seeded.seeded).toBe(true);
    expect(seeded.automations).toEqual([createDailyPulseAutomation()]);
    expect(seeded.automations[0]).toEqual({
      name: DAILY_PULSE_AUTOMATION_NAME,
      system: "daily-pulse",
      cadence: { kind: "daily", hour: 8 },
      enabled: false,
      write: true,
    });
  });

  it("preserves a same-name playbook and removes only duplicate system entries", () => {
    const edited: AutomationConfig = {
      name: "daily pulse",
      cadence: { kind: "weekly", day: 1, hour: 10 },
      enabled: true,
      write: true,
    };
    const other: AutomationConfig = {
      name: "Weekly review",
      cadence: { kind: "weekly", day: 5, hour: 17 },
      enabled: true,
      write: false,
    };
    const seeded = seedDailyPulseAutomation([
      edited,
      other,
      createDailyPulseAutomation(),
    ], false);

    expect(seeded.automations).toEqual([edited, other, createDailyPulseAutomation()]);
    expect(seeded.seeded).toBe(true);
    expect(seeded.changed).toBe(true);
  });

  it("never restores a deleted or edited config after the persisted seed flag", () => {
    const deleted = seedDailyPulseAutomation([], true);
    expect(deleted).toEqual({ automations: [], seeded: true, changed: false });

    const edited = [{
      ...createDailyPulseAutomation(),
      cadence: { kind: "daily", hour: 11 } as const,
      enabled: true,
    }];
    expect(seedDailyPulseAutomation(edited, true)).toEqual({
      automations: edited,
      seeded: true,
      changed: false,
    });
  });
});

describe("runDailyPulseSlot", () => {
  const enabled = { ...createDailyPulseAutomation(), enabled: true };

  it("does not write while disabled", async () => {
    const execute = vi.fn(async () => ({ warningCount: 0 }));
    const result = await runDailyPulseSlot({
      config: createDailyPulseAutomation(),
      lastRun: 0,
      now: at(2026, 7, 20, 9),
      execute,
    });

    expect(result).toEqual({ status: "disabled" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not run before 08:00 when yesterday's slot already succeeded", async () => {
    const execute = vi.fn(async () => ({ warningCount: 0 }));
    const result = await runDailyPulseSlot({
      config: enabled,
      lastRun: at(2026, 7, 19, 8, 5),
      now: at(2026, 7, 20, 7, 59),
      execute,
    });

    expect(result).toEqual({ status: "current" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("runs once after 08:00 and is idempotent for the same local slot", async () => {
    const execute = vi.fn(async () => ({ warningCount: 0 }));
    const now = at(2026, 7, 20, 8, 1);
    const first = await runDailyPulseSlot({ config: enabled, lastRun: 0, now, execute });
    expect(first).toEqual({ status: "succeeded", completedAt: now, warningCount: 0 });

    const second = await runDailyPulseSlot({
      config: enabled,
      lastRun: first.status === "succeeded" ? first.completedAt : 0,
      now: at(2026, 7, 20, 18),
      execute,
    });
    expect(second).toEqual({ status: "current" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent scheduler polls into one write flight", async () => {
    let release: (() => void) | undefined;
    const execute = vi.fn(() => new Promise<{ warningCount: number }>((resolve) => {
      release = () => resolve({ warningCount: 0 });
    }));
    const runner = new DailyPulseSlotRunner();
    const options = {
      config: enabled,
      lastRun: 0,
      now: at(2026, 7, 20, 8, 1),
      execute,
    };

    const first = runner.run(options);
    const second = runner.run(options);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "succeeded", completedAt: options.now, warningCount: 0 },
      { status: "succeeded", completedAt: options.now, warningCount: 0 },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("catches up exactly once after a restart later than the slot", async () => {
    const execute = vi.fn(async () => ({ warningCount: 1 }));
    const now = at(2026, 7, 22, 14);
    const caughtUp = await runDailyPulseSlot({
      config: enabled,
      lastRun: at(2026, 7, 20, 8, 1),
      now,
      execute,
    });

    expect(caughtUp).toEqual({ status: "succeeded", completedAt: now, warningCount: 1 });
    await expect(runDailyPulseSlot({
      config: enabled,
      lastRun: now,
      now: at(2026, 7, 22, 14, 30),
      execute,
    })).resolves.toEqual({ status: "current" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps the prior last-run on write failure so the slot remains retryable", async () => {
    const execute = vi.fn(async () => { throw new Error("disk unavailable"); });
    const result = await runDailyPulseSlot({
      config: enabled,
      lastRun: at(2026, 7, 19, 8),
      now: at(2026, 7, 20, 9),
      execute,
    });

    expect(result).toEqual({
      status: "failed",
      error: "disk unavailable",
      retryable: true,
    });
    expect(execute).toHaveBeenCalledTimes(1);

    const prior = {
      ...initialDailyPulseReviewState(),
      status: "ready" as const,
      lastSuccessAt: at(2026, 7, 19, 8),
      itemCount: 3,
    };
    expect(result.status === "failed"
      ? dailyPulseReviewAfterRun(prior, result, at(2026, 7, 20, 9))
      : null).toEqual({
      ...prior,
      status: "error",
      lastAttemptAt: at(2026, 7, 20, 9),
      warnings: [],
      lastError: "disk unavailable",
      retryable: true,
    });
  });

  it("produces a quiet persisted success/warning review state", () => {
    const completedAt = at(2026, 7, 20, 8, 1);
    expect(dailyPulseReviewAfterRun(
      initialDailyPulseReviewState(),
      { status: "succeeded", completedAt, warningCount: 1 },
      completedAt,
      [{ source: "loops", message: "temporarily unavailable" }],
      4
    )).toEqual({
      status: "warning",
      lastAttemptAt: completedAt,
      lastSuccessAt: completedAt,
      lastReviewedAt: 0,
      warnings: [{ source: "loops", message: "temporarily unavailable" }],
      itemCount: 4,
      lastError: "",
      retryable: false,
    });
  });

  it("surfaces items only until the generated pulse is reviewed", () => {
    const state = {
      ...initialDailyPulseReviewState(),
      lastSuccessAt: 20,
      itemCount: 2,
    };
    expect(dailyPulseNeedsReview(state)).toBe(true);
    expect(dailyPulseNeedsReview({ ...state, lastReviewedAt: 20 })).toBe(false);
    expect(dailyPulseNeedsReview({ ...state, itemCount: 0 })).toBe(false);
  });

  it("uses local calendar slots across the spring DST boundary", async () => {
    const execute = vi.fn(async () => ({ warningCount: 0 }));
    const beforeDst = at(2026, 3, 28, 8, 5);
    const afterDst = at(2026, 3, 29, 8, 1);

    const result = await runDailyPulseSlot({
      config: enabled,
      lastRun: beforeDst,
      now: afterDst,
      execute,
    });

    expect(result.status).toBe("succeeded");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
