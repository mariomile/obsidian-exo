import { describe, it, expect } from "vitest";
import type { TaskEntry, TaskStatus } from "../src/core/tasks";
import {
  reduce,
  reconcile,
  DEFAULT_ORCHESTRATOR_CONFIG,
  type OrchestratorEvent,
  type OrchestratorConfig,
  type OrchestratorResult,
  type ConvoSnapshot,
} from "../src/core/orchestrator";

const T = Date.UTC(2024, 6, 3, 12, 0, 0);

function task(over: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id: `task-${T}`,
    title: "Do a thing",
    status: "backlog",
    created: new Date(T).toISOString(),
    updated: new Date(T).toISOString(),
    prompt: "Please do the thing.",
    ...over,
  };
}

const cfg: OrchestratorConfig = { maxConcurrent: 2 };

/** Convenience: find the updated task with a given id in a result. */
function updated(res: OrchestratorResult, id: string): TaskEntry | undefined {
  return res.tasks.find((t) => t.id === id);
}

/** Convenience: statuses of all tasks in a result, keyed by id. */
function statuses(res: OrchestratorResult): Record<string, TaskStatus> {
  const out: Record<string, TaskStatus> = {};
  for (const t of res.tasks) out[t.id] = t.status;
  return out;
}

// ---------------------------------------------------------------------------
// Transition table — positive cases
// ---------------------------------------------------------------------------

describe("transition table — user actions", () => {
  it("Backlog -> Queued on enqueue when the cap is already full (stays queued)", () => {
    // Two tasks already running under cap 2 → no free slot → the enqueued task
    // parks in `queued` rather than auto-promoting.
    const running = [
      task({ id: "r1", status: "running", convo: "c1" }),
      task({ id: "r2", status: "running", convo: "c2" }),
    ];
    const t = task({ id: "task-1", status: "backlog" });
    const res = reduce([...running, t], { type: "enqueue", taskId: "task-1" }, cfg);
    expect(updated(res, "task-1")!.status).toBe("queued");
    expect(res.effects).toHaveLength(0);
  });

  it("Queued -> Running when a free slot exists, emits spawn-chat effect", () => {
    const t = task({ id: "task-1", status: "queued" });
    const res = reduce([t], { type: "enqueue", taskId: "task-1-noop" }, cfg);
    // enqueue on an unknown id is a no-op for that id; but the scheduler still
    // has to promote queued tasks. Use an explicit slot-freed tick instead.
    const res2 = reduce([t], { type: "slot-freed" }, cfg);
    expect(updated(res2, "task-1")!.status).toBe("running");
    expect(res2.effects).toContainEqual(
      expect.objectContaining({ type: "spawn-chat", taskId: "task-1" })
    );
    void res;
  });

  it("enqueue promotes to running immediately when a slot is free", () => {
    const t = task({ id: "task-1", status: "backlog" });
    const res = reduce([t], { type: "enqueue", taskId: "task-1" }, cfg);
    expect(updated(res, "task-1")!.status).toBe("running");
    expect(res.effects).toContainEqual(
      expect.objectContaining({ type: "spawn-chat", taskId: "task-1" })
    );
  });

  it("Review -> Done ONLY on explicit mark-done user event", () => {
    const t = task({ id: "task-1", status: "review", convo: "c1" });
    const res = reduce([t], { type: "mark-done", taskId: "task-1" }, cfg);
    expect(updated(res, "task-1")!.status).toBe("done");
  });

  it("Done -> Archived on archive user action", () => {
    const t = task({ id: "task-1", status: "done" });
    const res = reduce([t], { type: "archive", taskId: "task-1" }, cfg);
    expect(updated(res, "task-1")!.status).toBe("archived");
  });

  it("Review -> Running on user follow-up in that task's chat", () => {
    const t = task({ id: "task-1", status: "review", convo: "c1" });
    const res = reduce([t], { type: "follow-up", taskId: "task-1" }, cfg);
    expect(updated(res, "task-1")!.status).toBe("running");
  });

  it("Needs Input -> Running on user follow-up (input answered)", () => {
    const t = task({ id: "task-1", status: "needs-input", convo: "c1", inputReason: "needs-input" });
    const res = reduce([t], { type: "follow-up", taskId: "task-1" }, cfg);
    const u = updated(res, "task-1")!;
    expect(u.status).toBe("running");
    expect(u.inputReason).toBeUndefined();
  });

  it("drag/move to any column moves the task and sets order", () => {
    const t = task({ id: "task-1", status: "running", convo: "c1" });
    const res = reduce(
      [t],
      { type: "move", taskId: "task-1", target: "backlog", order: 3 },
      cfg
    );
    const u = updated(res, "task-1")!;
    expect(u.status).toBe("backlog");
    expect(u.order).toBe(3);
  });

  it("drag/move supports any backward move (review -> queued)", () => {
    // Keep the cap full so the moved-to-queued task doesn't auto-promote,
    // isolating the move semantics from the scheduler.
    const running = [
      task({ id: "r1", status: "running", convo: "cA" }),
      task({ id: "r2", status: "running", convo: "cB" }),
    ];
    const t = task({ id: "task-1", status: "review", convo: "c1" });
    const res = reduce(
      [...running, t],
      { type: "move", taskId: "task-1", target: "queued", order: 0 },
      cfg
    );
    expect(updated(res, "task-1")!.status).toBe("queued");
  });
});

describe("transition table — convo events", () => {
  it("Running -> Needs Input on needs-input, records reason badge", () => {
    const t = task({ id: "task-1", status: "running", convo: "c1" });
    const res = reduce([t], { type: "needs-input", convoId: "c1" }, cfg);
    const u = updated(res, "task-1")!;
    expect(u.status).toBe("needs-input");
    expect(u.inputReason).toBe("needs-input");
  });

  it("Running -> Needs Input on error, badge = error", () => {
    const t = task({ id: "task-1", status: "running", convo: "c1" });
    const res = reduce([t], { type: "error", convoId: "c1" }, cfg);
    const u = updated(res, "task-1")!;
    expect(u.status).toBe("needs-input");
    expect(u.inputReason).toBe("error");
  });

  it("Running -> Needs Input on stopped, badge = stopped", () => {
    const t = task({ id: "task-1", status: "running", convo: "c1" });
    const res = reduce([t], { type: "stopped", convoId: "c1" }, cfg);
    const u = updated(res, "task-1")!;
    expect(u.status).toBe("needs-input");
    expect(u.inputReason).toBe("stopped");
  });

  it("Running -> Review on turn-end with no pending requests", () => {
    const t = task({ id: "task-1", status: "running", convo: "c1" });
    const res = reduce([t], { type: "turn-end", convoId: "c1" }, cfg);
    expect(updated(res, "task-1")!.status).toBe("review");
  });

  it("turn-start on a running task keeps it running (no status change)", () => {
    const t = task({ id: "task-1", status: "running", convo: "c1" });
    const res = reduce([t], { type: "turn-start", convoId: "c1" }, cfg);
    expect(updated(res, "task-1")!.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// Invalid / agent-driven transitions must NOT occur
// ---------------------------------------------------------------------------

describe("Review -> Done is user-action-only", () => {
  it.each([
    { type: "turn-end", convoId: "c1" } as OrchestratorEvent,
    { type: "turn-start", convoId: "c1" } as OrchestratorEvent,
    { type: "needs-input", convoId: "c1" } as OrchestratorEvent,
    { type: "stopped", convoId: "c1" } as OrchestratorEvent,
    { type: "error", convoId: "c1" } as OrchestratorEvent,
    { type: "slot-freed" } as OrchestratorEvent,
  ])("convo/scheduler event %o never completes a Review task", (ev) => {
    const t = task({ id: "task-1", status: "review", convo: "c1" });
    const res = reduce([t], ev, cfg);
    expect(updated(res, "task-1")!.status).not.toBe("done");
  });

  it("no convo event on a running task can reach Done", () => {
    for (const type of ["turn-end", "needs-input", "stopped", "error"] as const) {
      const t = task({ id: "task-1", status: "running", convo: "c1" });
      const res = reduce([t], { type, convoId: "c1" } as OrchestratorEvent, cfg);
      expect(updated(res, "task-1")!.status).not.toBe("done");
    }
  });
});

describe("agent events cannot enqueue/spawn or move backlog forward", () => {
  it("turn-end on a backlog task is inert (no status change, no effects)", () => {
    const t = task({ id: "task-1", status: "backlog" });
    const res = reduce([t], { type: "turn-end", convoId: "c1" }, cfg);
    // backlog task has no convo id c1, so this is an unknown-convo no-op
    expect(updated(res, "task-1")!.status).toBe("backlog");
    expect(res.effects).toHaveLength(0);
  });

  it("mark-done on a non-review task does not complete it", () => {
    const t = task({ id: "task-1", status: "running", convo: "c1" });
    const res = reduce([t], { type: "mark-done", taskId: "task-1" }, cfg);
    expect(updated(res, "task-1")!.status).not.toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Unknown-convoId events are no-ops
// ---------------------------------------------------------------------------

describe("unknown-convoId events are no-ops", () => {
  it.each(["turn-start", "turn-end", "needs-input", "stopped", "error"] as const)(
    "%s with an unknown convoId leaves state unchanged and emits no effects",
    (type) => {
      const tasks = [
        task({ id: "task-1", status: "running", convo: "c1" }),
        task({ id: "task-2", status: "queued" }),
      ];
      const res = reduce(tasks, { type, convoId: "unknown" } as OrchestratorEvent, cfg);
      expect(statuses(res)).toEqual({ "task-1": "running", "task-2": "queued" });
      expect(res.effects).toHaveLength(0);
    }
  );

  it("user event with an unknown taskId leaves state unchanged, no effects", () => {
    const t = task({ id: "task-1", status: "backlog" });
    const res = reduce([t], { type: "enqueue", taskId: "nope" }, cfg);
    expect(updated(res, "task-1")!.status).toBe("backlog");
    expect(res.effects).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrency cap
// ---------------------------------------------------------------------------

describe("concurrency cap", () => {
  it("with cap 2 and 4 queued tasks, exactly 2 spawn, 2 stay queued", () => {
    const tasks = [
      task({ id: "task-1", status: "queued", order: 0 }),
      task({ id: "task-2", status: "queued", order: 1 }),
      task({ id: "task-3", status: "queued", order: 2 }),
      task({ id: "task-4", status: "queued", order: 3 }),
    ];
    const res = reduce(tasks, { type: "slot-freed" }, cfg);
    const s = statuses(res);
    const running = Object.values(s).filter((x) => x === "running").length;
    expect(running).toBe(2);
    expect(res.effects.filter((e) => e.type === "spawn-chat")).toHaveLength(2);
    // Lowest order starts first.
    expect(s["task-1"]).toBe("running");
    expect(s["task-2"]).toBe("running");
    expect(s["task-3"]).toBe("queued");
    expect(s["task-4"]).toBe("queued");
  });

  it("never exceeds cap when some tasks already running", () => {
    const tasks = [
      task({ id: "task-1", status: "running", convo: "c1" }),
      task({ id: "task-2", status: "queued", order: 0 }),
      task({ id: "task-3", status: "queued", order: 1 }),
    ];
    const res = reduce(tasks, { type: "slot-freed" }, cfg);
    const running = Object.values(statuses(res)).filter((x) => x === "running").length;
    expect(running).toBe(2);
    expect(res.effects.filter((e) => e.type === "spawn-chat")).toHaveLength(1);
  });

  it("queued tasks start in order as slots free (turn-end frees a slot)", () => {
    const tasks = [
      task({ id: "task-1", status: "running", convo: "c1" }),
      task({ id: "task-2", status: "running", convo: "c2" }),
      task({ id: "task-3", status: "queued", order: 0 }),
      task({ id: "task-4", status: "queued", order: 1 }),
    ];
    // task-1 finishes its turn -> review, freeing a slot; task-3 should start.
    const res = reduce(tasks, { type: "turn-end", convoId: "c1" }, cfg);
    const s = statuses(res);
    expect(s["task-1"]).toBe("review");
    expect(s["task-3"]).toBe("running");
    expect(s["task-4"]).toBe("queued");
    expect(res.effects).toContainEqual(
      expect.objectContaining({ type: "spawn-chat", taskId: "task-3" })
    );
    // never more than N running
    expect(Object.values(s).filter((x) => x === "running").length).toBe(2);
  });

  it("progressive draining: repeated slot-freed ticks start queued tasks one cap-worth at a time", () => {
    let tasks: TaskEntry[] = [
      task({ id: "task-1", status: "queued", order: 0 }),
      task({ id: "task-2", status: "queued", order: 1 }),
      task({ id: "task-3", status: "queued", order: 2 }),
    ];
    const cap1: OrchestratorConfig = { maxConcurrent: 1 };
    let res = reduce(tasks, { type: "slot-freed" }, cap1);
    expect(statuses(res)["task-1"]).toBe("running");
    expect(Object.values(statuses(res)).filter((x) => x === "running").length).toBe(1);

    // task-1 ends its turn -> review frees the slot, task-2 starts.
    tasks = res.tasks;
    res = reduce(tasks, { type: "turn-end", convoId: res.tasks.find((t) => t.id === "task-1")!.convo! }, cap1);
    expect(statuses(res)["task-1"]).toBe("review");
    expect(statuses(res)["task-2"]).toBe("running");
    expect(statuses(res)["task-3"]).toBe("queued");
  });
});

// ---------------------------------------------------------------------------
// spawn-chat effect carries enough for the driver to record convo id
// ---------------------------------------------------------------------------

describe("spawn-chat effect payload", () => {
  it("carries the task id and prompt/model so the driver can spawn + record a convo id", () => {
    const t = task({ id: "task-1", status: "queued", prompt: "hello world", model: "opus" });
    const res = reduce([t], { type: "slot-freed" }, cfg);
    const spawn = res.effects.find((e) => e.type === "spawn-chat");
    expect(spawn).toBeDefined();
    expect(spawn).toMatchObject({ type: "spawn-chat", taskId: "task-1", prompt: "hello world", model: "opus" });
  });
});

describe("default config", () => {
  it("exposes maxConcurrent 2", () => {
    expect(DEFAULT_ORCHESTRATOR_CONFIG.maxConcurrent).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Boot reconciliation — full matrix
// ---------------------------------------------------------------------------

describe("boot reconciliation matrix", () => {
  const snap = (over: Partial<ConvoSnapshot> = {}): ConvoSnapshot => ({
    exists: true,
    streaming: false,
    pendingRequest: false,
    ...over,
  });

  // convo liveness variants
  const missing = undefined;
  const streaming = snap({ streaming: true });
  const idle = snap({ streaming: false, pendingRequest: false });
  const pending = snap({ pendingRequest: true });

  function run(status: TaskStatus, live: ConvoSnapshot | undefined) {
    const t = task({ id: "task-1", status, convo: live ? "c1" : "c1" });
    const convos = new Map<string, ConvoSnapshot>();
    if (live) convos.set("c1", live);
    const res = reconcile([t], convos, cfg);
    return updated(res, "task-1")!;
  }

  describe("convo missing -> chat-missing badge", () => {
    it.each(["running", "needs-input", "review"] as TaskStatus[])(
      "%s with a missing convo gets chatMissing flag",
      (status) => {
        const u = run(status, missing);
        expect(u.chatMissing).toBe(true);
      }
    );

    it("backlog/queued tasks with no live convo are NOT flagged chat-missing", () => {
      for (const status of ["backlog", "queued", "done", "archived"] as TaskStatus[]) {
        const t = task({ id: "task-1", status });
        // no convo id at all for these
        delete (t as Partial<TaskEntry>).convo;
        const res = reconcile([t], new Map(), cfg);
        expect(updated(res, "task-1")!.chatMissing).toBeFalsy();
      }
    });
  });

  describe("convo exists — streaming", () => {
    it.each(["running", "needs-input", "review"] as TaskStatus[])(
      "%s with a streaming convo is corrected to running",
      (status) => {
        const u = run(status, streaming);
        expect(u.status).toBe("running");
        expect(u.chatMissing).toBeFalsy();
      }
    );
  });

  describe("convo exists — pending input", () => {
    it.each(["running", "review"] as TaskStatus[])(
      "%s with a pending-input convo is corrected to needs-input",
      (status) => {
        const u = run(status, pending);
        expect(u.status).toBe("needs-input");
        expect(u.chatMissing).toBeFalsy();
      }
    );
  });

  describe("pre-run statuses (queued) are inert to reconciliation", () => {
    // A queued task has no live convo yet, so reconciliation must leave it in
    // queued regardless of any stray convo state and must not flag it.
    it.each([undefined, streaming, idle, pending])(
      "queued stays queued for convo snapshot %#",
      (live) => {
        const u = run("queued", live);
        expect(u.status).toBe("queued");
        expect(u.chatMissing).toBeFalsy();
      }
    );
  });

  describe("convo exists — idle (not streaming, no pending)", () => {
    it("running with an idle convo is corrected to review", () => {
      expect(run("running", idle).status).toBe("review");
    });
    it("needs-input with an idle convo is corrected to review", () => {
      expect(run("needs-input", idle).status).toBe("review");
    });
    it("review with an idle convo stays review", () => {
      expect(run("review", idle).status).toBe("review");
    });
  });

  describe("terminal statuses are never disturbed by reconciliation", () => {
    it.each(["done", "archived", "backlog"] as TaskStatus[])(
      "%s stays put regardless of a live streaming convo",
      (status) => {
        expect(run(status, streaming).status).toBe(status);
      }
    );
  });

  it("a re-run after chat-missing can record a fresh convo id via move->queued then slot-freed", () => {
    // task flagged chat-missing, user re-queues it, scheduler spawns a fresh chat.
    const t = task({ id: "task-1", status: "queued", chatMissing: true });
    const res = reduce([t], { type: "slot-freed" }, cfg);
    const u = updated(res, "task-1")!;
    expect(u.status).toBe("running");
    // spawn effect present so the driver can create + record a NEW convo id
    expect(res.effects).toContainEqual(
      expect.objectContaining({ type: "spawn-chat", taskId: "task-1" })
    );
  });
});
