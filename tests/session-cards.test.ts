import { describe, it, expect } from "vitest";
import {
  deriveLane,
  projectSessionCards,
  canArchive,
  type SessionSnapshot,
} from "../src/core/session-cards";

/** Minimal factory — an idle husk by default; each test flips only what it pins. */
const snap = (over: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  id: "c1",
  title: "Chat",
  streaming: false,
  pendingPerm: false,
  pendingAsk: false,
  poisoned: false,
  stopped: false,
  hasMessages: true,
  archived: false,
  ...over,
});

describe("deriveLane", () => {
  it("maps a plain streaming convo to running", () => {
    expect(deriveLane(snap({ streaming: true }))).toEqual({ lane: "running" });
  });

  it("maps a turn-ended convo with messages to review", () => {
    expect(deriveLane(snap({ streaming: false, hasMessages: true }))).toEqual({ lane: "review" });
  });

  it("maps an empty husk (no flags, no messages) to idle", () => {
    expect(deriveLane(snap({ hasMessages: false }))).toEqual({ lane: "idle" });
  });

  // The bug the review caught: a convo waiting on a permission prompt is STILL
  // streaming:true, so pending must win — else "waiting for you" reads as Running.
  it("classifies streaming+pendingPerm as needs-input, NOT running", () => {
    expect(deriveLane(snap({ streaming: true, pendingPerm: true }))).toEqual({
      lane: "needs-input",
      reason: "perm",
    });
  });

  it("classifies pendingAsk as needs-input with reason ask", () => {
    expect(deriveLane(snap({ streaming: true, pendingAsk: true }))).toEqual({
      lane: "needs-input",
      reason: "ask",
    });
  });

  it("routes a user-stopped turn to review with a stopped badge", () => {
    expect(deriveLane(snap({ stopped: true }))).toEqual({ lane: "review", badge: "stopped" });
  });

  it("routes a poisoned turn to review with an error badge", () => {
    expect(deriveLane(snap({ poisoned: true }))).toEqual({ lane: "review", badge: "error" });
  });

  // Matches terminalConvoState: a user-stopped turn reads as a stop, not an error.
  it("prefers the stopped badge over error when both flags are set", () => {
    expect(deriveLane(snap({ stopped: true, poisoned: true }))).toEqual({
      lane: "review",
      badge: "stopped",
    });
  });

  it("places an idle chat in its manual boardStatus column (default review)", () => {
    expect(deriveLane(snap({ boardStatus: "done" }))).toEqual({ lane: "done" });
    expect(deriveLane(snap())).toEqual({ lane: "review" });
  });

  // The hybrid rule: an actively running/blocked chat always jumps into view,
  // regardless of where the user parked it.
  it("lets the auto lanes override the manual boardStatus", () => {
    expect(deriveLane(snap({ boardStatus: "done", streaming: true }))).toEqual({ lane: "running" });
    expect(deriveLane(snap({ boardStatus: "backlog", pendingPerm: true }))).toEqual({
      lane: "needs-input",
      reason: "perm",
    });
  });

  it("keeps the stopped/error badge while the card sits in a manual column", () => {
    expect(deriveLane(snap({ boardStatus: "done", stopped: true }))).toEqual({
      lane: "done",
      badge: "stopped",
    });
  });
});

describe("projectSessionCards", () => {
  it("projects non-idle convos into cards in their lanes", () => {
    const cards = projectSessionCards(
      [
        snap({ id: "a", streaming: true }),
        snap({ id: "b", pendingPerm: true }),
        snap({ id: "c", hasMessages: true }),
      ],
      [],
    );
    expect(cards.map((c) => [c.id, c.lane, c.reason])).toEqual([
      ["a", "running", undefined],
      ["b", "needs-input", "perm"],
      ["c", "review", undefined],
    ]);
  });

  // Dedup lynchpin: a convo a task owns must render once (as the task-card), so
  // it is excluded from the session-card projection.
  it("excludes a convo claimed by a task", () => {
    const cards = projectSessionCards([snap({ id: "owned", streaming: true })], [{ convo: "owned" }]);
    expect(cards).toEqual([]);
  });

  it("ignores task rows without a convo pointer when building the claimed set", () => {
    const cards = projectSessionCards([snap({ id: "x", streaming: true })], [{}, { convo: undefined }]);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("x");
  });

  it("excludes archived convos", () => {
    const cards = projectSessionCards([snap({ id: "arch", streaming: true, archived: true })], []);
    expect(cards).toEqual([]);
  });

  it("excludes idle husks", () => {
    const cards = projectSessionCards([snap({ id: "husk", hasMessages: false })], []);
    expect(cards).toEqual([]);
  });

  it("carries the stopped/error badge onto the card", () => {
    const cards = projectSessionCards(
      [snap({ id: "s", stopped: true }), snap({ id: "e", poisoned: true })],
      [],
    );
    expect(cards.map((c) => [c.id, c.badge])).toEqual([
      ["s", "stopped"],
      ["e", "error"],
    ]);
  });

  it("preserves snapshot order", () => {
    const cards = projectSessionCards(
      [snap({ id: "z", streaming: true }), snap({ id: "a", streaming: true })],
      [],
    );
    expect(cards.map((c) => c.id)).toEqual(["z", "a"]);
  });

  it("returns nothing for empty input", () => {
    expect(projectSessionCards([], [])).toEqual([]);
  });
});

describe("canArchive", () => {
  it("allows archiving only from the review lane", () => {
    expect(canArchive("review")).toBe(true);
    expect(canArchive("running")).toBe(false);
    expect(canArchive("done")).toBe(false);
  });
});
