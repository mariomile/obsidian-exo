import { describe, it, expect } from "vitest";
import {
  dateUTC,
  initialBudgetLedger,
  resetIfNewDay,
  canSpend,
  recordSpend,
  type BudgetLedger,
} from "../src/core/background-budget";

const DAY1 = Date.UTC(2026, 6, 5, 10, 0, 0); // 2026-07-05
const DAY1_LATE = Date.UTC(2026, 6, 5, 23, 59, 0);
const DAY2 = Date.UTC(2026, 6, 6, 0, 1, 0); // 2026-07-06

describe("dateUTC", () => {
  it("formats a timestamp as a UTC YYYY-MM-DD string", () => {
    expect(dateUTC(DAY1)).toBe("2026-07-05");
    expect(dateUTC(DAY2)).toBe("2026-07-06");
  });
});

describe("initialBudgetLedger", () => {
  it("starts empty for the given day", () => {
    expect(initialBudgetLedger(DAY1)).toEqual({ dateUTC: "2026-07-05", tokensUsed: 0 });
  });
});

describe("resetIfNewDay", () => {
  it("keeps the ledger unchanged within the same UTC day", () => {
    const led: BudgetLedger = { dateUTC: "2026-07-05", tokensUsed: 500 };
    expect(resetIfNewDay(led, DAY1_LATE)).toEqual(led);
  });

  it("zeroes the counter and rolls the date at a new UTC day", () => {
    const led: BudgetLedger = { dateUTC: "2026-07-05", tokensUsed: 500 };
    expect(resetIfNewDay(led, DAY2)).toEqual({ dateUTC: "2026-07-06", tokensUsed: 0 });
  });
});

describe("canSpend", () => {
  const led: BudgetLedger = { dateUTC: "2026-07-05", tokensUsed: 190000 };

  it("allows a spend that fits under the daily budget", () => {
    expect(canSpend(led, 5000, { enabled: true, dailyBudget: 200000, now: DAY1 })).toBe(true);
  });

  it("blocks a spend that would exceed the daily budget", () => {
    expect(canSpend(led, 20000, { enabled: true, dailyBudget: 200000, now: DAY1 })).toBe(false);
  });

  it("is false when the master toggle is off, regardless of budget", () => {
    expect(canSpend(led, 1, { enabled: false, dailyBudget: 200000, now: DAY1 })).toBe(false);
  });

  it("uses the fresh (rolled-over) counter at a new day", () => {
    // Yesterday's 190k should not count today.
    expect(canSpend(led, 20000, { enabled: true, dailyBudget: 200000, now: DAY2 })).toBe(true);
  });

  it("treats a non-positive daily budget as unlimited", () => {
    expect(canSpend(led, 10_000_000, { enabled: true, dailyBudget: 0, now: DAY1 })).toBe(true);
  });
});

describe("recordSpend", () => {
  it("adds tokens to the current day's counter", () => {
    const led: BudgetLedger = { dateUTC: "2026-07-05", tokensUsed: 100 };
    expect(recordSpend(led, 250, DAY1)).toEqual({ dateUTC: "2026-07-05", tokensUsed: 350 });
  });

  it("rolls the day over before adding when the day changed", () => {
    const led: BudgetLedger = { dateUTC: "2026-07-05", tokensUsed: 100 };
    expect(recordSpend(led, 250, DAY2)).toEqual({ dateUTC: "2026-07-06", tokensUsed: 250 });
  });

  it("clamps a negative or NaN token count to zero (never subtracts)", () => {
    const led: BudgetLedger = { dateUTC: "2026-07-05", tokensUsed: 100 };
    expect(recordSpend(led, -50, DAY1).tokensUsed).toBe(100);
    expect(recordSpend(led, Number.NaN, DAY1).tokensUsed).toBe(100);
  });

  it("does not mutate its input", () => {
    const led: BudgetLedger = { dateUTC: "2026-07-05", tokensUsed: 100 };
    recordSpend(led, 250, DAY1);
    expect(led.tokensUsed).toBe(100);
  });
});
