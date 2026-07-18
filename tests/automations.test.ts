import { describe, it, expect } from "vitest";
import {
  currentSlotStart,
  isDue,
  nextDueAt,
  nextAutomation,
  cadenceLabel,
  migrateScheduledRuns,
  pruneRuns,
  type AutomationConfig,
  type AutomationRunRecord,
} from "../src/core/automations";

/** Local-time epoch for readable fixtures. Wed 2026-07-15 is a Wednesday (day 3). */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe("currentSlotStart", () => {
  it("hourly → top of the current hour", () => {
    expect(currentSlotStart({ kind: "hourly" }, at(2026, 7, 15, 14, 37))).toBe(at(2026, 7, 15, 14));
  });
  it("daily before the hour → yesterday's slot", () => {
    expect(currentSlotStart({ kind: "daily", hour: 9 }, at(2026, 7, 15, 8, 59))).toBe(at(2026, 7, 14, 9));
  });
  it("daily after the hour → today's slot", () => {
    expect(currentSlotStart({ kind: "daily", hour: 9 }, at(2026, 7, 15, 9, 0))).toBe(at(2026, 7, 15, 9));
  });
  it("weekly → most recent day+hour occurrence, same-day boundary both sides", () => {
    const wedNine = { kind: "weekly", day: 3, hour: 9 } as const;
    expect(currentSlotStart(wedNine, at(2026, 7, 15, 10))).toBe(at(2026, 7, 15, 9)); // Wed after 9
    expect(currentSlotStart(wedNine, at(2026, 7, 15, 8))).toBe(at(2026, 7, 8, 9)); // Wed before 9 → last Wed
    expect(currentSlotStart(wedNine, at(2026, 7, 17, 12))).toBe(at(2026, 7, 15, 9)); // Fri → this Wed
  });
});

describe("isDue / nextDueAt", () => {
  const daily9 = { kind: "daily", hour: 9 } as const;
  it("never ran → due", () => {
    expect(isDue(daily9, 0, at(2026, 7, 15, 10))).toBe(true);
    expect(nextDueAt(daily9, 0, at(2026, 7, 15, 10))).toBe(at(2026, 7, 15, 10)); // now
  });
  it("ran in the current slot → not due, next = tomorrow's slot", () => {
    const now = at(2026, 7, 15, 10);
    expect(isDue(daily9, at(2026, 7, 15, 9, 5), now)).toBe(false);
    expect(nextDueAt(daily9, at(2026, 7, 15, 9, 5), now)).toBe(at(2026, 7, 16, 9));
  });
  it("ran yesterday → due again once today's slot opens, not before", () => {
    expect(isDue(daily9, at(2026, 7, 14, 9, 10), at(2026, 7, 15, 8, 30))).toBe(false);
    expect(isDue(daily9, at(2026, 7, 14, 9, 10), at(2026, 7, 15, 9, 1))).toBe(true);
  });
  it("hourly fires once per clock hour", () => {
    const h = { kind: "hourly" } as const;
    expect(isDue(h, at(2026, 7, 15, 14, 2), at(2026, 7, 15, 14, 40))).toBe(false);
    expect(isDue(h, at(2026, 7, 15, 14, 2), at(2026, 7, 15, 15, 0))).toBe(true);
    expect(nextDueAt(h, at(2026, 7, 15, 14, 2), at(2026, 7, 15, 14, 40))).toBe(at(2026, 7, 15, 15));
  });
});

describe("nextAutomation", () => {
  const autos: AutomationConfig[] = [
    { name: "A", cadence: { kind: "daily", hour: 9 }, enabled: true, write: false },
    { name: "B", cadence: { kind: "hourly" }, enabled: true, write: true },
    { name: "C", cadence: { kind: "daily", hour: 6 }, enabled: false, write: false },
  ];
  it("returns the soonest enabled automation, skipping disabled", () => {
    const now = at(2026, 7, 15, 10, 30);
    const last = { A: at(2026, 7, 15, 9, 5), B: at(2026, 7, 15, 10, 2), C: 0 };
    expect(nextAutomation(autos, last, now)).toEqual({ name: "B", dueAt: at(2026, 7, 15, 11) });
  });
  it("due-now wins immediately", () => {
    const now = at(2026, 7, 15, 10, 30);
    expect(nextAutomation(autos, {}, now)?.dueAt).toBe(now);
  });
  it("empty/all-disabled → null", () => {
    expect(nextAutomation([], {}, 0)).toBeNull();
    expect(nextAutomation([autos[2]], {}, at(2026, 7, 15))).toBeNull();
  });
});

describe("cadenceLabel", () => {
  it("formats the three kinds", () => {
    expect(cadenceLabel({ kind: "hourly" })).toBe("hourly");
    expect(cadenceLabel({ kind: "daily", hour: 7 })).toBe("daily 07:00");
    expect(cadenceLabel({ kind: "weekly", day: 1, hour: 18 })).toBe("weekly Mon 18:00");
  });
});

describe("migrateScheduledRuns", () => {
  it("converts legacy lines, defaults 07:00 / Monday, write off", () => {
    expect(migrateScheduledRuns("Morning brief | daily\nWeekly review | weekly\n\nbad line\nX | monthly")).toEqual([
      { name: "Morning brief", cadence: { kind: "daily", hour: 7 }, enabled: true, write: false },
      { name: "Weekly review", cadence: { kind: "weekly", day: 1, hour: 7 }, enabled: true, write: false },
    ]);
  });
  it("empty input → empty list", () => {
    expect(migrateScheduledRuns("")).toEqual([]);
  });
});

describe("pruneRuns", () => {
  const rec = (id: string, startedAt: number): AutomationRunRecord => ({
    id,
    name: "A",
    startedAt,
    ok: true,
    reportPath: "",
    writes: [],
    checkpoint: [],
  });
  it("keeps the newest N, newest first", () => {
    const pruned = pruneRuns([rec("a", 1), rec("b", 3), rec("c", 2)], 2);
    expect(pruned.map((r) => r.id)).toEqual(["b", "c"]);
  });
});
