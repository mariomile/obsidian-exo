import { describe, it, expect } from "vitest";
import { planTurnEndTerminals, planLiveTaskSweep } from "../src/core/live-task-lifecycle";
import type { LiveTask, LiveTaskKind, LiveTaskStatus } from "../src/core/live-tasks";

const task = (
  id: string,
  kind: LiveTaskKind,
  status: LiveTaskStatus = "running",
  over: Partial<LiveTask> = {},
): LiveTask => ({ id, kind, label: id, status, startedAt: 0, ...over });

const ids = (...v: string[]) => new Set(v);

describe("planTurnEndTerminals — a turn only settles what it can speak for", () => {
  it("a clean finish orphans subagents: they can never report back", () => {
    // A Task/Agent subagent resolves inside its own turn by definition. If the
    // turn ended with it still running, its result is never coming.
    const out = planTurnEndTerminals([task("a", "subagent")], ids("a"), "completed");
    expect(out).toEqual([{ id: "a", status: "error" }]);
  });

  it("a clean finish DETACHES background bash — Exo cannot poll it, so it must not claim 'running'", () => {
    // The turn's stream is closed; nothing will ever report this task's outcome
    // again. `detached` says only what's true: started, outcome unknown. See
    // live-task-detached.test.ts for the full rationale.
    expect(planTurnEndTerminals([task("b", "bash")], ids("b"), "completed")).toEqual([
      { id: "b", status: "detached" },
    ]);
  });

  it("a clean finish DETACHES a workflow too — same reasoning, it outlives the turn by design", () => {
    expect(planTurnEndTerminals([task("w", "workflow")], ids("w"), "completed")).toEqual([
      { id: "w", status: "detached" },
    ]);
  });

  it("an interrupt settles every kind: the session that owned them is gone", () => {
    const out = planTurnEndTerminals(
      [task("a", "subagent"), task("b", "bash"), task("w", "workflow")],
      ids("a", "b", "w"),
      "interrupted",
    );
    expect(out).toEqual([
      { id: "a", status: "stopped" },
      { id: "b", status: "stopped" },
      { id: "w", status: "stopped" },
    ]);
  });

  it("a disposed session settles every kind too", () => {
    const out = planTurnEndTerminals([task("w", "workflow")], ids("w"), "disposed");
    expect(out).toEqual([{ id: "w", status: "stopped" }]);
  });

  it("never touches a task this turn did not register (keep-alive from an earlier turn)", () => {
    // The whole point of keep-alive L1: work started by a PREVIOUS turn is still
    // live and must survive this turn ending, however this turn ended.
    const tasks = [task("old", "bash"), task("mine", "subagent")];
    expect(planTurnEndTerminals(tasks, ids("mine"), "interrupted")).toEqual([
      { id: "mine", status: "stopped" },
    ]);
  });

  it("never re-settles a task that is already terminal", () => {
    const tasks = [task("a", "subagent", "done"), task("b", "bash", "error")];
    expect(planTurnEndTerminals(tasks, ids("a", "b"), "interrupted")).toEqual([]);
  });

  it("is empty for an empty turn", () => {
    expect(planTurnEndTerminals([], ids(), "completed")).toEqual([]);
    expect(planTurnEndTerminals([task("a", "subagent")], ids(), "completed")).toEqual([]);
  });
});

describe("planLiveTaskSweep — eviction policy", () => {
  it("evicts a terminal task once its fade window has elapsed", () => {
    const t = task("a", "subagent", "done", { doneAt: 1000 });
    expect(planLiveTaskSweep([t], ids(), 3000, 2000)).toEqual(["a"]);
  });

  it("keeps a terminal task still inside its fade window", () => {
    const t = task("a", "subagent", "done", { doneAt: 1000 });
    expect(planLiveTaskSweep([t], ids(), 2500, 2000)).toEqual([]);
  });

  it("keeps a running task no matter how old", () => {
    expect(planLiveTaskSweep([task("a", "bash")], ids(), 999_999, 2000)).toEqual([]);
  });

  it("evicts anything whose card is gone from the transcript, running or not", () => {
    // This is the ONLY orphan signal. It must be supplied by the caller, which
    // owns the DOM: a card being detached because its TAB is in the background
    // is not an orphan, and using `isConnected` conflated the two.
    const tasks = [task("a", "bash"), task("b", "workflow", "done", { doneAt: 0 })];
    expect(planLiveTaskSweep(tasks, ids("a"), 0, 2000)).toEqual(["a"]);
  });

  it("keeps a terminal task that never got a doneAt stamp", () => {
    // Belt-and-braces: `liveUpsert` now always stamps, so an unstamped terminal
    // row means something upstream is wrong. Evicting it on a guessed age would
    // hide that; keeping it makes it visible.
    const t = task("a", "subagent", "done");
    expect(planLiveTaskSweep([t], ids(), 999_999, 2000)).toEqual([]);
  });

  it("reports an orphaned, faded task exactly once", () => {
    const t = task("a", "subagent", "done", { doneAt: 0 });
    expect(planLiveTaskSweep([t], ids("a"), 999_999, 2000)).toEqual(["a"]);
  });

  it("is empty when there is nothing to sweep", () => {
    expect(planLiveTaskSweep([], ids(), 0, 2000)).toEqual([]);
  });
});
