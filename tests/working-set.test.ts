import { describe, it, expect } from "vitest";
import { planWorkingSet, deriveTabState } from "../src/core/working-set";

type Cand = Parameters<typeof planWorkingSet>[0][number];

const tab = (id: string, lastActiveAt: number, over: Partial<Cand> = {}): Cand => ({
  id,
  lastActiveAt,
  pinned: false,
  streaming: false,
  needsInput: false,
  hasDraft: false,
  hasQueue: false,
  ...over,
});

describe("planWorkingSet", () => {
  it("keeps everything while at or under the cap", () => {
    const tabs = [tab("a", 1), tab("b", 2), tab("c", 3)];
    const plan = planWorkingSet(tabs, { activeId: "c", cap: 6 });
    expect(plan.retire).toEqual([]);
    expect(plan.visible).toEqual(["a", "b", "c"]);
  });

  it("retires the least-recently-active when the cap is exceeded", () => {
    // 7 non-pinned, cap 6 -> exactly one retires, the oldest lastActiveAt.
    const tabs = [tab("a", 50), tab("b", 10), tab("c", 30), tab("d", 40), tab("e", 20), tab("f", 60), tab("g", 70)];
    const plan = planWorkingSet(tabs, { activeId: "g", cap: 6 });
    expect(plan.retire).toEqual(["b"]);
    expect(plan.visible).toEqual(["a", "c", "d", "e", "f", "g"]);
  });

  it("retires oldest-first when several slots are over", () => {
    const tabs = [tab("a", 30), tab("b", 10), tab("c", 20), tab("d", 40)];
    const plan = planWorkingSet(tabs, { activeId: "d", cap: 2 });
    expect(plan.retire).toEqual(["b", "c"]);
  });

  it("never retires the active tab even when it is the oldest", () => {
    const tabs = [tab("old", 1), tab("x", 50), tab("y", 60)];
    const plan = planWorkingSet(tabs, { activeId: "old", cap: 1 });
    expect(plan.retire).not.toContain("old");
  });

  it("never retires an exempt tab, and lets the strip grow when all are exempt", () => {
    // cap 1, but every tab is exempt for a different reason -> nothing retires.
    const tabs = [
      tab("active", 1),
      tab("streaming", 2, { streaming: true }),
      tab("blocked", 3, { needsInput: true }),
      tab("draft", 4, { hasDraft: true }),
      tab("queued", 5, { hasQueue: true }),
    ];
    const plan = planWorkingSet(tabs, { activeId: "active", cap: 1 });
    expect(plan.retire).toEqual([]);
    expect(plan.visible).toHaveLength(5);
  });

  it("does not count pinned tabs against the cap and never retires them", () => {
    // 3 pinned + 3 non-pinned, cap 3 -> nothing retires: only non-pinned count.
    const tabs = [
      tab("p1", 1, { pinned: true }),
      tab("p2", 2, { pinned: true }),
      tab("p3", 3, { pinned: true }),
      tab("a", 10),
      tab("b", 20),
      tab("c", 30),
    ];
    const plan = planWorkingSet(tabs, { activeId: "c", cap: 3 });
    expect(plan.retire).toEqual([]);
    expect(plan.visible).toHaveLength(6);
  });

  it("preserves the input order in visible", () => {
    // The strip must not reshuffle under the user: retiring removes, never sorts.
    const tabs = [tab("z", 90), tab("a", 10), tab("m", 50), tab("q", 80)];
    const plan = planWorkingSet(tabs, { activeId: "z", cap: 3 });
    expect(plan.retire).toEqual(["a"]);
    expect(plan.visible).toEqual(["z", "m", "q"]);
  });
});

describe("deriveTabState", () => {
  const sig = (over = {}) => ({
    streaming: false,
    pendingPerm: false,
    pendingAsk: false,
    unread: false,
    stopped: false,
    poisoned: false,
    ...over,
  });

  it("is idle with no signals", () => {
    expect(deriveTabState(sig())).toEqual({ state: "idle", needsInput: false });
  });

  it("reports streaming and needsInput on separate channels so they compose", () => {
    // A turn blocked on a permission prompt is STILL streaming (the turn's
    // finally has not run). One enum could not say both; two channels can.
    expect(deriveTabState(sig({ streaming: true, pendingPerm: true }))).toEqual({
      state: "streaming",
      needsInput: true,
      reason: "perm",
    });
  });

  it("distinguishes the two needs-input reasons", () => {
    expect(deriveTabState(sig({ pendingAsk: true })).reason).toBe("ask");
  });

  it("prefers streaming over unread", () => {
    expect(deriveTabState(sig({ streaming: true, unread: true })).state).toBe("streaming");
  });

  it("prefers unread over a terminal badge", () => {
    // "It finished while you were away" is the more actionable fact.
    expect(deriveTabState(sig({ unread: true, stopped: true })).state).toBe("unread");
  });

  it("prefers stopped over error, matching deriveLane", () => {
    expect(deriveTabState(sig({ stopped: true, poisoned: true })).state).toBe("stopped");
  });

  it("reports error when poisoned alone", () => {
    expect(deriveTabState(sig({ poisoned: true })).state).toBe("error");
  });
});
