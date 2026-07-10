import { describe, it, expect } from "vitest";
import { workingAffordance, type WorkingState } from "../src/core/working-visibility";

/** Base: a streaming turn with nothing else on screen. */
const base: WorkingState = { streaming: true, openCards: 0, textStreaming: false };

describe("workingAffordance", () => {
  it("shows nothing once the turn is no longer streaming", () => {
    expect(workingAffordance({ ...base, streaming: false })).toBe("none");
  });

  it("shows the working row when streaming with no card and no text (anti-freeze)", () => {
    // The 'incantato' case: model went silent after thinking. The working row
    // (with 'esc to stop') MUST stay visible so the turn never looks dead.
    expect(workingAffordance(base)).toBe("working");
  });

  it("shows the caret while text is actively streaming", () => {
    expect(workingAffordance({ ...base, textStreaming: true })).toBe("caret");
  });

  it("shows the card while an interactive card is open", () => {
    expect(workingAffordance({ ...base, openCards: 1 })).toBe("card");
  });

  it("prioritizes an open card over streaming text", () => {
    expect(workingAffordance({ ...base, openCards: 1, textStreaming: true })).toBe("card");
  });

  it("NEVER returns 'none' while streaming — the core no-freeze invariant", () => {
    // Whatever the combination of card/text flags, a streaming turn always has a
    // visible, interruptible affordance. This is the property that kills the
    // silent limbo: there is no reachable streaming state with nothing on screen.
    for (const openCards of [0, 1, 2]) {
      for (const textStreaming of [false, true]) {
        const a = workingAffordance({ streaming: true, openCards, textStreaming });
        expect(a).not.toBe("none");
        expect(["working", "card", "caret"]).toContain(a);
      }
    }
  });
});
