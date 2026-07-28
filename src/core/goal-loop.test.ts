import { describe, it, expect } from "vitest";
import {
  setGoal,
  clearGoal,
  resumeGoal,
  detectMet,
  advance,
  buildContinuationPrompt,
  GOAL_MET_SENTINEL,
} from "./goal-loop";

describe("goal-loop", () => {
  it("setGoal starts active at zero", () => {
    const g = setGoal("all tests pass", 10, 1000);
    expect(g).toEqual({
      condition: "all tests pass",
      iterations: 0,
      windowRuns: 0,
      maxIterations: 10,
      setAt: 1000,
      status: "active",
    });
  });

  it("detectMet matches the sentinel on its own line, ignores incidental mentions", () => {
    expect(detectMet(`done\n${GOAL_MET_SENTINEL}`)).toBe(true);
    expect(detectMet(`${GOAL_MET_SENTINEL}\n`)).toBe(true);
    expect(detectMet("I will write <<<GOAL_MET>>> when finished")).toBe(false);
    expect(detectMet("still working on it")).toBe(false);
  });

  it("advance → continue when not met and under cap, bumping counters", () => {
    const g = setGoal("green", 10, 0);
    const { next, action } = advance(g, "still red");
    expect(action).toBe("continue");
    expect(next.iterations).toBe(1);
    expect(next.windowRuns).toBe(1);
    expect(next.status).toBe("active");
  });

  it("advance → met when the sentinel is present", () => {
    const g = setGoal("green", 10, 0);
    const { next, action } = advance(g, `fixed it\n${GOAL_MET_SENTINEL}`);
    expect(action).toBe("met");
    expect(next.status).toBe("met");
    expect(next.iterations).toBe(1);
  });

  it("advance → ask-confirm when the window cap is reached", () => {
    let g = setGoal("green", 2, 0);
    g = advance(g, "red").next; // windowRuns 1
    const { next, action } = advance(g, "red"); // windowRuns 2 == cap
    expect(action).toBe("ask-confirm");
    expect(next.status).toBe("paused");
    expect(next.windowRuns).toBe(2);
  });

  it("resumeGoal reopens a paused goal, resetting the window but keeping the total", () => {
    let g = setGoal("green", 2, 0);
    g = advance(g, "red").next;
    g = advance(g, "red").next; // paused, iterations 2, windowRuns 2
    const r = resumeGoal(g);
    expect(r.status).toBe("active");
    expect(r.windowRuns).toBe(0);
    expect(r.iterations).toBe(2);
  });

  it("clearGoal goes idle", () => {
    const g = setGoal("green", 10, 0);
    expect(clearGoal(g).status).toBe("idle");
  });

  it("advance is a no-op on idle or met goals", () => {
    const idle = clearGoal(setGoal("x", 10, 0));
    expect(advance(idle, "anything").action).toBe("idle");
    const met = advance(setGoal("x", 10, 0), `done\n${GOAL_MET_SENTINEL}`).next;
    expect(advance(met, "anything").action).toBe("idle");
  });

  it("detectMet tolerates surrounding whitespace and CRLF", () => {
    expect(detectMet(`  ${GOAL_MET_SENTINEL}  `)).toBe(true);
    expect(detectMet(`done\r\n${GOAL_MET_SENTINEL}\r\n`)).toBe(true);
  });

  it("buildContinuationPrompt names the condition and the sentinel", () => {
    const p = buildContinuationPrompt("all tests pass");
    expect(p).toContain("all tests pass");
    expect(p).toContain(GOAL_MET_SENTINEL);
  });
});
