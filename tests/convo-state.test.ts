import { describe, it, expect, vi } from "vitest";
import {
  ConvoStateChannel,
  terminalConvoState,
  type ConvoStateEvent,
} from "../src/core/convo-state";

describe("terminalConvoState", () => {
  it("maps a user-stopped turn to stopped/stopped", () => {
    expect(terminalConvoState({ stopped: true, poisoned: false })).toEqual({
      state: "stopped",
      reason: "stopped",
    });
  });

  it("maps an errored (poisoned) turn to needs-input/error", () => {
    expect(terminalConvoState({ stopped: false, poisoned: true })).toEqual({
      state: "needs-input",
      reason: "error",
    });
  });

  it("maps a clean turn to turn-end with no reason", () => {
    expect(terminalConvoState({ stopped: false, poisoned: false })).toEqual({ state: "turn-end" });
  });

  it("stopped wins over poisoned (a stopped-and-poisoned turn reads as stopped)", () => {
    expect(terminalConvoState({ stopped: true, poisoned: true })).toEqual({
      state: "stopped",
      reason: "stopped",
    });
  });
});

describe("ConvoStateChannel", () => {
  it("delivers an emitted event to a subscribed listener", () => {
    const ch = new ConvoStateChannel(() => true);
    const seen: ConvoStateEvent[] = [];
    ch.subscribe((e) => seen.push(e));

    ch.emit("c1", "turn-start");

    expect(seen).toEqual([{ convoId: "c1", state: "turn-start" }]);
  });

  it("passes through the reason detail", () => {
    const ch = new ConvoStateChannel(() => true);
    const seen: ConvoStateEvent[] = [];
    ch.subscribe((e) => seen.push(e));

    ch.emit("c9", "needs-input", { reason: "perm" });

    expect(seen).toEqual([{ convoId: "c9", state: "needs-input", reason: "perm" }]);
  });

  it("is a strict no-op when disabled — no listener runs", () => {
    const enabled = { value: false };
    const ch = new ConvoStateChannel(() => enabled.value);
    const listener = vi.fn();
    ch.subscribe(listener);

    ch.emit("c1", "turn-start");
    ch.emit("c1", "stopped", { reason: "stopped" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("respects the guard dynamically (off → on flips delivery)", () => {
    const enabled = { value: false };
    const ch = new ConvoStateChannel(() => enabled.value);
    const listener = vi.fn();
    ch.subscribe(listener);

    ch.emit("c1", "turn-start");
    expect(listener).not.toHaveBeenCalled();

    enabled.value = true;
    ch.emit("c1", "turn-end");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ convoId: "c1", state: "turn-end" });
  });

  it("a throwing listener is invisible — emit never throws and other listeners still run", () => {
    const ch = new ConvoStateChannel(() => true);
    const good = vi.fn();
    ch.subscribe(() => {
      throw new Error("board UI crashed");
    });
    ch.subscribe(good);

    expect(() => ch.emit("c1", "turn-start")).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("isolates each listener invocation in its own try/catch (first crash doesn't skip later)", () => {
    const ch = new ConvoStateChannel(() => true);
    const calls: string[] = [];
    ch.subscribe(() => {
      calls.push("a");
      throw new Error("a boom");
    });
    ch.subscribe(() => {
      calls.push("b");
      throw new Error("b boom");
    });
    const last = vi.fn(() => calls.push("c"));
    ch.subscribe(last);

    ch.emit("c1", "turn-end");

    expect(calls).toEqual(["a", "b", "c"]);
    expect(last).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops further delivery to that listener", () => {
    const ch = new ConvoStateChannel(() => true);
    const listener = vi.fn();
    const off = ch.subscribe(listener);

    ch.emit("c1", "turn-start");
    off();
    ch.emit("c1", "turn-end");

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("delivers every state variant (turn-start, turn-end, needs-input, stopped, error)", () => {
    const ch = new ConvoStateChannel(() => true);
    const seen: ConvoStateEvent[] = [];
    ch.subscribe((e) => seen.push(e));

    ch.emit("c1", "turn-start");
    ch.emit("c1", "turn-end");
    ch.emit("c1", "needs-input", { reason: "ask" });
    ch.emit("c1", "stopped", { reason: "stopped" });
    ch.emit("c1", "needs-input", { reason: "error" });

    expect(seen.map((e) => e.state)).toEqual([
      "turn-start",
      "turn-end",
      "needs-input",
      "stopped",
      "needs-input",
    ]);
    expect(seen[2].reason).toBe("ask");
    expect(seen[4].reason).toBe("error");
  });
});
