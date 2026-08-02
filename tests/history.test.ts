import { describe, it, expect } from "vitest";
import { groupByTime, matchesFilters } from "../src/core/history";

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
};

const convo = (id: string, over: Partial<C> = {}): C => ({
  id,
  updatedAt: NOW,
  archived: false,
  openTabIds: new Set(),
  messages: [{}],
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
    expect(groups.map((g) => g.label)).toEqual(["Oggi", "Ieri", "Questa settimana", "Questo mese", "Più vecchie"]);
    expect(groups[0].items.map((c) => c.id)).toEqual(["today"]);
    expect(groups[4].items.map((c) => c.id)).toEqual(["older"]);
  });

  it("omits empty groups entirely — a filtered-down set should not draw blank headers", () => {
    const all = [convo("today", { updatedAt: NOW - 3_600_000 })];
    const groups = groupByTime(all, NOW);
    expect(groups).toEqual([{ label: "Oggi", items: all }]);
  });

  it("treats a missing updatedAt as Older rather than crashing or sorting first", () => {
    const all = [convo("noDate", { updatedAt: undefined })];
    const groups = groupByTime(all, NOW);
    expect(groups.map((g) => g.label)).toEqual(["Più vecchie"]);
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

  it("composes multiple active filters with AND", () => {
    // Retired AND older-than-30: only a convo satisfying BOTH passes.
    const both = convo("both", { retiredAt: NOW - DAY, updatedAt: NOW - 40 * DAY });
    const onlyRetired = convo("onlyRetired", { retiredAt: NOW - DAY, updatedAt: NOW - 1 * DAY });
    expect(matchesFilters(both, ["retired", "olderThan30"], NOW)).toBe(true);
    expect(matchesFilters(onlyRetired, ["retired", "olderThan30"], NOW)).toBe(false);
  });
});
