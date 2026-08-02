import { describe, it, expect } from "vitest";
import { chooseDensity } from "../src/core/strip-density";

const at = (over = {}) => ({
  availableWidth: 356,
  tabCount: 6,
  activeTabWidth: 170,
  current: "wide" as const,
  ...over,
});

describe("chooseDensity", () => {
  it("goes dense when a wide render would starve each tab", () => {
    // The real measured case: (356-170)/5 = 37px per tab.
    expect(chooseDensity(at())).toBe("dense");
  });

  it("stays wide when there is room, even in a narrow pane", () => {
    // Two tabs in the same 356px: (356-170)/1 = 186px each. Width alone is not
    // the signal — the ratio is.
    expect(chooseDensity(at({ tabCount: 2 }))).toBe("wide");
  });

  it("stays wide in a full-page pane with many tabs", () => {
    expect(chooseDensity(at({ availableWidth: 1200 }))).toBe("wide");
  });

  it("does not flip back to wide until well past the dense threshold", () => {
    // Hysteresis: 95px is above the 90 entry point but below the 110 exit
    // point -- the dead zone. One threshold here would oscillate on a dragged
    // splitter, so both directions must hold their current density inside it.
    const perTab95 = { availableWidth: 170 + 95 * 5, tabCount: 6, activeTabWidth: 170 };
    expect(chooseDensity({ ...perTab95, current: "dense" })).toBe("dense");
    expect(chooseDensity({ ...perTab95, current: "wide" })).toBe("wide");
  });

  // The two comparisons are strict (`< 90`, `> 110`), and the thresholds
  // themselves are the only inputs that tell a strict comparison from a loose
  // one. Without these, relaxing either to `<=` / `>=` — one character —
  // changes the behaviour at the exact width where it is defined and every
  // other case above still passes.
  it("holds wide AT the entry threshold, not one pixel before it", () => {
    const perTab90 = { availableWidth: 170 + 90 * 5, tabCount: 6, activeTabWidth: 170 };
    expect(chooseDensity({ ...perTab90, current: "wide" })).toBe("wide");
    // And one pixel below it, the flip is real.
    expect(chooseDensity({ ...perTab90, availableWidth: 170 + 90 * 5 - 5, current: "wide" })).toBe("dense");
  });

  it("holds dense AT the exit threshold, not one pixel before it", () => {
    const perTab110 = { availableWidth: 170 + 110 * 5, tabCount: 6, activeTabWidth: 170 };
    expect(chooseDensity({ ...perTab110, current: "dense" })).toBe("dense");
    // And one pixel above it, the flip is real.
    expect(chooseDensity({ ...perTab110, availableWidth: 170 + 110 * 5 + 5, current: "dense" })).toBe("wide");
  });

  it("returns to wide above the exit threshold", () => {
    const perTab120 = { availableWidth: 170 + 120 * 5, tabCount: 6, activeTabWidth: 170 };
    expect(chooseDensity({ ...perTab120, current: "dense" })).toBe("wide");
  });

  it("keeps the current density when the width is not known yet", () => {
    // First layout can report 0. Flipping and flipping back is a visible flash.
    expect(chooseDensity(at({ availableWidth: 0, current: "wide" }))).toBe("wide");
    expect(chooseDensity(at({ availableWidth: 0, current: "dense" }))).toBe("dense");
    expect(chooseDensity(at({ availableWidth: -1, current: "dense" }))).toBe("dense");
  });

  it("stays wide with a single tab, whatever the width", () => {
    // The strip hides at one tab anyway; this must not divide by zero.
    expect(chooseDensity(at({ tabCount: 1, availableWidth: 50 }))).toBe("wide");
  });
});
