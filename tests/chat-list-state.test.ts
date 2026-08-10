import { describe, it, expect } from "vitest";
import {
  chatDot,
  isSectionCollapsed,
  toggleSectionCollapsed,
} from "../src/core/chat-list-state";

describe("chatDot", () => {
  it("says nothing for a row at rest — the gutter stays empty", () => {
    expect(chatDot({ unseen: false })).toBeNull();
  });

  it("marks a running turn", () => {
    expect(chatDot({ lane: "running", unseen: false })).toBe("running");
  });

  it("marks a blocked turn as needing you", () => {
    expect(chatDot({ lane: "needs-input", unseen: false })).toBe("needs-you");
  });

  it("marks an unseen reply when nothing is live", () => {
    expect(chatDot({ unseen: true })).toBe("unseen");
  });

  it("ranks needs-you above running", () => {
    // deriveLane's own precedence: a conversation blocked on a permission
    // prompt is still streaming, so reading `running` first would label
    // "waiting for you" as "working" — the exact bug the lane ordering exists
    // to prevent, reproduced one layer up in the dot.
    expect(chatDot({ lane: "needs-input", unseen: true })).toBe("needs-you");
  });

  it("ranks both live states above unseen", () => {
    // An unseen reply is older news than a turn that is running right now.
    expect(chatDot({ lane: "running", unseen: true })).toBe("running");
  });
});

describe("section collapse", () => {
  it("treats absent state as expanded", () => {
    // The no-migration guarantee: an install that never toggled anything opens
    // exactly as it did before the feature landed.
    expect(isSectionCollapsed(undefined, "needsYou")).toBe(false);
    expect(isSectionCollapsed([], "needsYou")).toBe(false);
  });

  it("reads a collapsed key back", () => {
    expect(isSectionCollapsed(["settled"], "settled")).toBe(true);
    expect(isSectionCollapsed(["settled"], "open")).toBe(false);
  });

  it("collapses by appending and expands by removing", () => {
    expect(toggleSectionCollapsed([], "settled")).toEqual(["settled"]);
    expect(toggleSectionCollapsed(["settled"], "settled")).toEqual([]);
    expect(toggleSectionCollapsed(undefined, "open")).toEqual(["open"]);
  });

  it("leaves the other sections alone", () => {
    expect(toggleSectionCollapsed(["open", "settled"], "open")).toEqual(["settled"]);
    expect(toggleSectionCollapsed(["open"], "settled")).toEqual(["open", "settled"]);
  });

  it("round-trips a day-mode key", () => {
    // `day:` keys are template-literal members of ChatSectionKey, not a
    // separate space — collapsing "This week" must persist the same way.
    const once = toggleSectionCollapsed([], "day:This week");
    expect(isSectionCollapsed(once, "day:This week")).toBe(true);
    expect(toggleSectionCollapsed(once, "day:This week")).toEqual([]);
  });

  it("never mutates the list it was given", () => {
    // The caller persists the RESULT; mutating in place would leave memory
    // ahead of disk the moment a save fails.
    const before: string[] = ["settled"];
    toggleSectionCollapsed(before, "open");
    toggleSectionCollapsed(before, "settled");
    expect(before).toEqual(["settled"]);
  });
});
