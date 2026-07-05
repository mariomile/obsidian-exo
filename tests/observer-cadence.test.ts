import { describe, it, expect } from "vitest";
import {
  initialCadenceState,
  recordStep,
  pendingDelta,
  advanceWatermark,
  finalWatermark,
  CadenceTracker,
  type CadenceState,
} from "../src/core/observer-cadence";

describe("initialCadenceState", () => {
  it("starts at zero steps and zero watermark", () => {
    expect(initialCadenceState()).toEqual({ stepCount: 0, watermark: 0 });
  });
});

describe("recordStep", () => {
  it("fires at N, 2N, 3N, ... for a given interval", () => {
    let state = initialCadenceState();
    const interval = 3;
    const fires: boolean[] = [];
    for (let i = 1; i <= 9; i++) {
      const r = recordStep(state, interval);
      state = r.state;
      fires.push(r.fired);
    }
    // steps 1..9, interval 3 -> fires at 3, 6, 9
    expect(fires).toEqual([false, false, true, false, false, true, false, false, true]);
    expect(state.stepCount).toBe(9);
  });

  it("does not fire off-interval steps", () => {
    let state = initialCadenceState();
    const r1 = recordStep(state, 5);
    expect(r1.fired).toBe(false);
    state = r1.state;
    const r2 = recordStep(state, 5);
    expect(r2.fired).toBe(false);
  });

  it("fires every step when interval is 1 (edge case N=1)", () => {
    let state = initialCadenceState();
    for (let i = 1; i <= 5; i++) {
      const r = recordStep(state, 1);
      expect(r.fired).toBe(true);
      state = r.state;
    }
    expect(state.stepCount).toBe(5);
  });

  it("never fires for a non-positive or non-finite interval (defensive)", () => {
    let state = initialCadenceState();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = recordStep(state, bad);
      expect(r.fired).toBe(false);
      state = r.state;
    }
  });

  it("never mutates its input state", () => {
    const state: CadenceState = { stepCount: 2, watermark: 1 };
    recordStep(state, 3);
    expect(state).toEqual({ stepCount: 2, watermark: 1 });
  });

  it("keeps the watermark untouched — only stepCount advances", () => {
    const state: CadenceState = { stepCount: 0, watermark: 5 };
    const r = recordStep(state, 1);
    expect(r.state.watermark).toBe(5);
    expect(r.state.stepCount).toBe(1);
  });
});

describe("pendingDelta", () => {
  it("returns the range from the watermark up to a later position", () => {
    const state: CadenceState = { stepCount: 10, watermark: 4 };
    expect(pendingDelta(state, 10)).toEqual({ from: 4, to: 10 });
  });

  it("returns null when there is nothing new (position <= watermark)", () => {
    const state: CadenceState = { stepCount: 10, watermark: 10 };
    expect(pendingDelta(state, 10)).toBeNull();
    expect(pendingDelta(state, 5)).toBeNull();
  });

  it("returns null for a non-finite position (defensive)", () => {
    const state: CadenceState = { stepCount: 10, watermark: 4 };
    expect(pendingDelta(state, Number.NaN)).toBeNull();
  });
});

describe("advanceWatermark", () => {
  it("moves the watermark forward to the given position", () => {
    const state: CadenceState = { stepCount: 10, watermark: 4 };
    expect(advanceWatermark(state, 10)).toEqual({ stepCount: 10, watermark: 10 });
  });

  it("is monotonic — never moves the watermark backwards", () => {
    const state: CadenceState = { stepCount: 10, watermark: 8 };
    expect(advanceWatermark(state, 3)).toEqual({ stepCount: 10, watermark: 8 });
  });

  it("ignores a non-finite position (defensive, returns state unchanged)", () => {
    const state: CadenceState = { stepCount: 10, watermark: 8 };
    expect(advanceWatermark(state, Number.NaN)).toEqual(state);
  });

  it("never mutates its input", () => {
    const state: CadenceState = { stepCount: 10, watermark: 4 };
    advanceWatermark(state, 10);
    expect(state).toEqual({ stepCount: 10, watermark: 4 });
  });
});

describe("finalWatermark", () => {
  it("exposes the watermark the session-end pass needs, after 0 step passes", () => {
    const state = initialCadenceState();
    expect(finalWatermark(state)).toBe(0);
  });

  it("exposes the watermark after exactly 1 step pass", () => {
    const state = advanceWatermark({ stepCount: 5, watermark: 0 }, 5);
    expect(finalWatermark(state)).toBe(5);
  });

  it("exposes the watermark after multiple step passes (latest wins)", () => {
    let state: CadenceState = { stepCount: 0, watermark: 0 };
    state = advanceWatermark(state, 5);
    state = advanceWatermark(state, 12);
    state = advanceWatermark(state, 20);
    expect(finalWatermark(state)).toBe(20);
  });
});

describe("CadenceTracker", () => {
  it("tracks independent state per conversation", () => {
    const tracker = new CadenceTracker();
    // Conversation A gets 3 steps at interval 3 -> fires once.
    expect(tracker.step("convo-a", 3)).toBe(false);
    expect(tracker.step("convo-a", 3)).toBe(false);
    expect(tracker.step("convo-a", 3)).toBe(true);
    // Conversation B is untouched — its own counter starts fresh at 0.
    expect(tracker.step("convo-b", 3)).toBe(false);
    expect(tracker.watermarkOf("convo-a")).toBe(0);
    expect(tracker.watermarkOf("convo-b")).toBe(0);
  });

  it("advances and reads back the watermark per conversation", () => {
    const tracker = new CadenceTracker();
    tracker.step("c1", 2);
    tracker.step("c1", 2); // fires, stepCount=2
    tracker.advance("c1", 2);
    expect(tracker.watermarkOf("c1")).toBe(2);
    expect(tracker.watermarkOf("c2")).toBe(0); // independent, unaffected
  });

  it("computes the pending delta for a conversation", () => {
    const tracker = new CadenceTracker();
    tracker.step("c1", 1); // stepCount=1, fires
    expect(tracker.delta("c1", 1)).toEqual({ from: 0, to: 1 });
    tracker.advance("c1", 1);
    expect(tracker.delta("c1", 1)).toBeNull();
  });

  it("resets a conversation's counter (e.g. a brand new conversation reusing an id)", () => {
    const tracker = new CadenceTracker();
    tracker.step("c1", 2);
    tracker.step("c1", 2);
    tracker.advance("c1", 2);
    tracker.reset("c1");
    expect(tracker.watermarkOf("c1")).toBe(0);
    expect(tracker.step("c1", 2)).toBe(false); // counter restarted, not immediately firing
  });

  it("a brand new (never-seen) conversation id starts at a fresh zero state", () => {
    const tracker = new CadenceTracker();
    expect(tracker.watermarkOf("never-seen")).toBe(0);
    expect(tracker.delta("never-seen", 5)).toEqual({ from: 0, to: 5 });
  });
});
