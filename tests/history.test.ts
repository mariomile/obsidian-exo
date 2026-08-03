import { describe, it, expect } from "vitest";
import { groupByTime, matchesFilters, startOfDay, DAY_MS } from "../src/core/history";

// groupByTime buckets "today"/"yesterday" by the host's local calendar day
// (correct for the shipped plugin — Obsidian/Electron reads the OS timezone,
// and this env var has no effect there). Pinning it here only makes this
// Node test process deterministic across machines/CI regardless of the
// developer's own timezone; it does not change what ships.
process.env.TZ = "UTC";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000; // fixed anchor, no Date.now() in tests

type C = {
  id: string;
  updatedAt?: number;
  retiredAt?: number;
  archived?: boolean;
  openTabIds: Set<string>;
  messages: unknown[];
  restarts: boolean;
};

const convo = (id: string, over: Partial<C> = {}): C => ({
  id,
  updatedAt: NOW,
  archived: false,
  openTabIds: new Set(),
  messages: [{}],
  restarts: false,
  ...over,
});

describe("groupByTime", () => {
  it("buckets into Today/Yesterday/This week/This month/Older by updatedAt", () => {
    const all = [
      convo("today", { updatedAt: NOW - 2 * 3_600_000 }),
      convo("yesterday", { updatedAt: NOW - 1 * DAY - 3_600_000 }),
      convo("thisWeek", { updatedAt: NOW - 4 * DAY }),
      convo("thisMonth", { updatedAt: NOW - 20 * DAY }),
      convo("older", { updatedAt: NOW - 90 * DAY }),
    ];
    const groups = groupByTime(all, NOW);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "This week", "This month", "Older"]);
    expect(groups[0].items.map((c) => c.id)).toEqual(["today"]);
    expect(groups[4].items.map((c) => c.id)).toEqual(["older"]);
  });

  it("omits empty groups entirely — a filtered-down set should not draw blank headers", () => {
    const all = [convo("today", { updatedAt: NOW - 3_600_000 })];
    const groups = groupByTime(all, NOW);
    expect(groups).toEqual([{ label: "Today", items: all }]);
  });

  it("treats a missing updatedAt as Older rather than crashing or sorting first", () => {
    const all = [convo("noDate", { updatedAt: undefined })];
    const groups = groupByTime(all, NOW);
    expect(groups.map((g) => g.label)).toEqual(["Older"]);
  });

  it("preserves the caller's ordering within a bucket", () => {
    // groupByTime buckets; it does not re-sort. The caller (already sorted by
    // recency) controls order — bucketing must not silently reorder it.
    const all = [
      convo("b", { updatedAt: NOW - 1000 }),
      convo("a", { updatedAt: NOW - 500 }),
    ];
    const groups = groupByTime(all, NOW);
    expect(groups[0].items.map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("matchesFilters", () => {
  it("passes everything when no filter is active", () => {
    expect(matchesFilters(convo("a"), [], NOW)).toBe(true);
  });

  it("open: true only when the id is in openTabIds", () => {
    const c = convo("a", { openTabIds: new Set(["a"]) });
    expect(matchesFilters(c, ["open"], NOW)).toBe(true);
    expect(matchesFilters(convo("b"), ["open"], NOW)).toBe(false);
  });

  it("retired: true only when retiredAt is set and the convo is not archived and not open", () => {
    const retired = convo("a", { retiredAt: NOW - DAY });
    expect(matchesFilters(retired, ["retired"], NOW)).toBe(true);
    const archived = convo("b", { retiredAt: NOW - DAY, archived: true });
    expect(matchesFilters(archived, ["retired"], NOW)).toBe(false);
  });

  it("retired: false for a zero-message husk, mirroring retiredFromStrip's own exclusion", () => {
    // retiredFromStrip (working-set.ts, Piano 2) never surfaces a card for a
    // convo with no messages — this filter must not disagree and match one.
    const husk = convo("husk", { retiredAt: NOW - DAY, messages: [] });
    expect(matchesFilters(husk, ["retired"], NOW)).toBe(false);
  });

  it("archived: mirrors the archived flag directly", () => {
    expect(matchesFilters(convo("a", { archived: true }), ["archived"], NOW)).toBe(true);
    expect(matchesFilters(convo("b", { archived: false }), ["archived"], NOW)).toBe(false);
  });

  it("olderThan30: true when updatedAt is more than 30 days before `now`", () => {
    expect(matchesFilters(convo("a", { updatedAt: NOW - 31 * DAY }), ["olderThan30"], NOW)).toBe(true);
    expect(matchesFilters(convo("b", { updatedAt: NOW - 29 * DAY }), ["olderThan30"], NOW)).toBe(false);
  });

  it("shortConvo: true when there are fewer than 3 messages", () => {
    expect(matchesFilters(convo("a", { messages: [{}, {}] }), ["shortConvo"], NOW)).toBe(true);
    expect(matchesFilters(convo("b", { messages: [{}, {}, {}] }), ["shortConvo"], NOW)).toBe(false);
  });

  it("restarts: reads the precomputed fact, it does not re-derive it", () => {
    // The filesystem answer belongs to the view; this module only forwards it.
    // A convo the view could not classify arrives as false and is NOT selected —
    // the chip must never sweep up conversations whose status is unknown.
    expect(matchesFilters(convo("a", { restarts: true }), ["restarts"], NOW)).toBe(true);
    expect(matchesFilters(convo("b", { restarts: false }), ["restarts"], NOW)).toBe(false);
  });

  it("composes multiple active filters with AND", () => {
    // Retired AND older-than-30: only a convo satisfying BOTH passes.
    const both = convo("both", { retiredAt: NOW - DAY, updatedAt: NOW - 40 * DAY });
    const onlyRetired = convo("onlyRetired", { retiredAt: NOW - DAY, updatedAt: NOW - 1 * DAY });
    expect(matchesFilters(both, ["retired", "olderThan30"], NOW)).toBe(true);
    expect(matchesFilters(onlyRetired, ["retired", "olderThan30"], NOW)).toBe(false);
  });
});

// startOfDay is public API because the view's relative-time label ("ritirata
// ieri") has to count the SAME days groupByTime buckets by. The property that
// matters there is the one asserted below: 90 seconds apart is one calendar day
// apart when midnight falls between them — a raw 24h floor would say zero.
describe("startOfDay", () => {
  it("floors any time of day to that calendar day's midnight", () => {
    const late = new Date(2026, 6, 14, 23, 59, 30).getTime();
    const early = new Date(2026, 6, 15, 0, 0, 1).getTime();
    expect(startOfDay(late)).toBe(new Date(2026, 6, 14, 0, 0, 0, 0).getTime());
    expect(startOfDay(early)).toBe(new Date(2026, 6, 15, 0, 0, 0, 0).getTime());
    expect(Math.round((startOfDay(early) - startOfDay(late)) / DAY_MS)).toBe(1);
  });

  it("is idempotent — flooring an already-floored timestamp is a no-op", () => {
    const floored = startOfDay(new Date(2026, 6, 14, 17, 5).getTime());
    expect(startOfDay(floored)).toBe(floored);
  });
});
