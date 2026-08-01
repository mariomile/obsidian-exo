import { describe, it, expect } from "vitest";
import { planRetention } from "../src/core/retention";

type C = { id: string; messages: unknown[]; updatedAt?: number };

const convo = (id: string, msgCount: number, updatedAt?: number): C => ({
  id,
  messages: Array.from({ length: msgCount }, () => ({})),
  updatedAt,
});

/** Every convo weighs 100 bytes — keeps the budget arithmetic readable. */
const flatSize = () => 100;

const opts = (over: Partial<Parameters<typeof planRetention<C>>[1]> = {}) => ({
  activeId: "active",
  pinnedIds: [] as string[],
  budgetBytes: 10_000,
  sizeOf: flatSize,
  ...over,
});

describe("planRetention", () => {
  it("keeps every non-husk conversation even when far over budget", () => {
    // 50 convos x 100 bytes = 5000, budget 1000 → 4000 over.
    const all = Array.from({ length: 50 }, (_, i) => convo(`c${i}`, 2, i));
    const plan = planRetention(all, opts({ budgetBytes: 1000 }));
    // The whole point of this plan: over budget NEVER shrinks `keep`.
    expect(plan.keep.length).toBe(50);
    expect(plan.candidates.length).toBeGreaterThan(0);
  });

  it("proposes the oldest unprotected conversations, oldest first, and stops once under budget", () => {
    // 5 convos x 100 = 500 bytes, budget 300 → 200 over → exactly 2 candidates.
    const all = [
      convo("c1", 1, 500),
      convo("c2", 1, 100), // oldest
      convo("c3", 1, 400),
      convo("c4", 1, 200), // second oldest
      convo("c5", 1, 300),
    ];
    const plan = planRetention(all, opts({ activeId: "c1", budgetBytes: 300 }));
    expect(plan.candidates.map((c) => c.id)).toEqual(["c2", "c4"]);
  });

  it("never proposes the active conversation or a pinned one, even when they are the oldest", () => {
    const all = [
      convo("active", 1, 1), // oldest overall
      convo("pinned", 1, 2), // second oldest
      convo("plain", 1, 900),
    ];
    const plan = planRetention(
      all,
      opts({ activeId: "active", pinnedIds: ["pinned"], budgetBytes: 100 })
    );
    expect(plan.candidates.map((c) => c.id)).toEqual(["plain"]);
  });

  it("ignores open tabs entirely — being a tab no longer protects a conversation", () => {
    // Regression guard for the whole point of this plan: the old planner took
    // openTabIds as `pinned`. This one has no such parameter at all.
    const all = [convo("tab", 1, 1), convo("other", 1, 900)];
    const plan = planRetention(all, opts({ activeId: "other", budgetBytes: 100 }));
    expect(plan.candidates.map((c) => c.id)).toEqual(["tab"]);
  });

  it("drops empty unpinned husks but keeps protected empty ones", () => {
    const all = [
      convo("active", 0), // empty but active
      convo("pinned", 0), // empty but pinned
      convo("husk", 0), // empty, unprotected → dropped
      convo("real", 3, 100),
    ];
    const plan = planRetention(all, opts({ pinnedIds: ["pinned"] }));
    expect(plan.keep.map((c) => c.id)).toEqual(["active", "pinned", "real"]);
  });

  it("preserves original array order in keep", () => {
    // restore() falls back to the LAST element as active, so order is a contract.
    const all = [convo("z", 1, 900), convo("a", 1, 100), convo("m", 1, 500)];
    const plan = planRetention(all, opts({ activeId: "z" }));
    expect(plan.keep.map((c) => c.id)).toEqual(["z", "a", "m"]);
  });

  it("reports totalBytes from sizeOf", () => {
    const all = [convo("a", 1), convo("b", 1)];
    const plan = planRetention(all, opts());
    expect(plan.totalBytes).toBe(200);
  });
});

import { pinnedIdsOf, retentionBudgetBytes } from "../src/core/retention";
import { partitionConvos } from "../src/core/persistence";

describe("pinnedIdsOf", () => {
  it("returns only the ids of conversations flagged pinned", () => {
    const all = [
      { id: "a", pinned: true },
      { id: "b" },
      { id: "c", pinned: false },
      { id: "d", pinned: true },
    ];
    expect(pinnedIdsOf(all)).toEqual(["a", "d"]);
  });

  it("returns an empty array when nothing is pinned", () => {
    expect(pinnedIdsOf([{ id: "a" }, { id: "b", pinned: false }])).toEqual([]);
  });

  it("treats only strict true as pinned", () => {
    // Guard against a truthy legacy value ever silently protecting a convo.
    const all = [{ id: "a", pinned: 1 as unknown as boolean }, { id: "b", pinned: true }];
    expect(pinnedIdsOf(all)).toEqual(["b"]);
  });
});

import { planPersistedConvos } from "../src/core/persistence";

describe("migrazione dal planner vecchio (characterization)", () => {
  it("il vecchio planner cancellava oltre il cap; il nuovo non cancella mai", () => {
    // 40 convos, cap 30 -> il vecchio ne buttava 10 in silenzio.
    const all = Array.from({ length: 40 }, (_, i) => convo(`c${i}`, 2, i));

    const old = planPersistedConvos(all, "c0", [], 30);
    expect(old.length).toBe(30); // comportamento storico: perdita silenziosa

    const now = planRetention(all, opts({ activeId: "c0", budgetBytes: 1000 }));
    expect(now.keep.length).toBe(40); // nessuna perdita
    expect(now.candidates.length).toBeGreaterThan(0); // solo proposte
  });
});

describe("retentionBudgetBytes", () => {
  const FALLBACK = 50;

  it("converts a valid megabyte setting to bytes", () => {
    expect(retentionBudgetBytes(50, FALLBACK)).toBe(50 * 1024 * 1024);
    expect(retentionBudgetBytes(0.5, FALLBACK)).toBe(0.5 * 1024 * 1024);
  });

  it("falls back to the shipped default for values that would propose deleting everything", () => {
    // data.json is hand-editable, so the settings-panel guard is not the only
    // path in. A budget of 0 or a negative makes every unprotected conversation
    // a cleanup candidate — the wrong failure mode for this plan.
    for (const bad of [0, -1, -1000]) {
      expect(retentionBudgetBytes(bad, FALLBACK)).toBe(FALLBACK * 1024 * 1024);
    }
  });

  it("falls back for non-numeric, NaN, Infinity and missing values", () => {
    const expected = FALLBACK * 1024 * 1024;
    for (const bad of [NaN, Infinity, -Infinity, "50", null, undefined, {}]) {
      expect(retentionBudgetBytes(bad, FALLBACK)).toBe(expected);
    }
  });
});

describe("retention model fields", () => {
  it("partitionConvos leaves pinned and retiredAt untouched on both sides", () => {
    // Guard: pinning must not imply archiving, and a retired conversation must
    // stay in the live partition (retired != archived).
    const all = [
      { id: "a", pinned: true, retiredAt: 111 },
      { id: "b", archived: true, pinned: false, retiredAt: 222 },
    ];
    const { live, archived } = partitionConvos(all);
    expect(live).toEqual([{ id: "a", pinned: true, retiredAt: 111 }]);
    expect(archived).toEqual([{ id: "b", archived: true, pinned: false, retiredAt: 222 }]);
  });
});
