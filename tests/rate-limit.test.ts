import { describe, it, expect } from "vitest";
import {
  normalizeUtilization,
  normalizeResetEpochMs,
  windowLabel,
  formatClock,
  badgeState,
} from "../src/core/rate-limit";

describe("normalizeUtilization", () => {
  it("treats a 0-1 fraction as a percent (observed shape)", () => {
    expect(normalizeUtilization(0.8)).toBe(80);
    expect(normalizeUtilization(0.755)).toBe(76);
    expect(normalizeUtilization(1)).toBe(100);
    expect(normalizeUtilization(0)).toBe(0);
  });
  it("passes through an already-0-100 value", () => {
    expect(normalizeUtilization(83)).toBe(83);
    expect(normalizeUtilization(100)).toBe(100);
  });
  it("clamps and rounds", () => {
    expect(normalizeUtilization(140)).toBe(100);
    expect(normalizeUtilization(-5)).toBe(0);
  });
  it("returns undefined for absent / NaN", () => {
    expect(normalizeUtilization(undefined)).toBeUndefined();
    expect(normalizeUtilization(NaN)).toBeUndefined();
  });
});

describe("normalizeResetEpochMs", () => {
  it("coerces epoch seconds to ms (observed 10-digit shape)", () => {
    expect(normalizeResetEpochMs(1783191600)).toBe(1783191600000);
  });
  it("passes through epoch ms", () => {
    expect(normalizeResetEpochMs(1783191600000)).toBe(1783191600000);
  });
  it("returns undefined for absent / non-positive", () => {
    expect(normalizeResetEpochMs(undefined)).toBeUndefined();
    expect(normalizeResetEpochMs(0)).toBeUndefined();
    expect(normalizeResetEpochMs(-1)).toBeUndefined();
  });
});

describe("windowLabel", () => {
  it("maps the SDK rateLimitType values", () => {
    expect(windowLabel("five_hour")).toBe("5-hour");
    expect(windowLabel("seven_day")).toBe("weekly");
    expect(windowLabel("seven_day_opus")).toBe("weekly");
    expect(windowLabel("seven_day_sonnet")).toBe("weekly");
    expect(windowLabel("overage")).toBe("overage");
    expect(windowLabel(undefined)).toBe("usage");
    expect(windowLabel("something_new")).toBe("usage");
  });
});

describe("formatClock", () => {
  it("formats local HH:MM, round-tripping a local Date", () => {
    const d = new Date(2026, 0, 1, 14, 30);
    expect(formatClock(d.getTime())).toBe("14:30");
    const e = new Date(2026, 5, 9, 3, 5);
    expect(formatClock(e.getTime())).toBe("03:05");
  });
});

describe("badgeState", () => {
  it("hides while there is headroom (allowed, <80%)", () => {
    expect(badgeState("allowed", 0.5).visible).toBe(false);
    expect(badgeState("allowed", 0.79).visible).toBe(false);
    expect(badgeState("allowed", undefined).visible).toBe(false);
  });
  it("shows caution at >=80% or on allowed_warning", () => {
    const a = badgeState("allowed", 0.8);
    expect(a.visible).toBe(true);
    expect(a.level).toBe("caution");
    expect(a.label).toBe("80%");
    const b = badgeState("allowed_warning", 0.4);
    expect(b.visible).toBe(true);
    expect(b.level).toBe("caution");
  });
  it("shows danger + 'limit' when rejected", () => {
    const r = badgeState("rejected", 1);
    expect(r.visible).toBe(true);
    expect(r.level).toBe("danger");
    expect(r.label).toBe("limit");
  });
});
