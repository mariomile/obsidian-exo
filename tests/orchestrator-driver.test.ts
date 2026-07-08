import { describe, it, expect, vi } from "vitest";
import { OrchestratorDriver, type DriverDeps } from "../src/obsidian/orchestrator-driver";
import type { ConvoStateEvent, ConvoStateListener, Unsubscribe } from "../src/core/convo-state";
import type { TaskEntry, TaskStatus, TaskPatch } from "../src/core/tasks";
import type { ConvoSnapshot } from "../src/core/orchestrator";

/** Build a task entry with sensible defaults. */
function task(over: Partial<TaskEntry> & { id: string }): TaskEntry {
  return {
    title: "T",
    status: "backlog",
    created: "2026-07-08T00:00:00.000Z",
    updated: "2026-07-08T00:00:00.000Z",
    prompt: "do the thing",
    ...over,
  };
}

/**
 * In-memory fake of the B3 TaskStore's driver-facing surface: an authoritative
 * list of tasks that load() returns and update/move/archive mutate. Records
 * every mutation so tests can assert what was persisted.
 */
function fakeStore(initial: TaskEntry[] = []) {
  let tasks = initial.map((t) => ({ ...t }));
  const moves: Array<{ id: string; status: TaskStatus; order: number }> = [];
  const patches: Array<{ id: string; patch: TaskPatch }> = [];
  const store = {
    load: vi.fn(async () => ({ tasks: tasks.map((t) => ({ ...t })), warnings: [] as string[] })),
    update: vi.fn(async (id: string, patch: TaskPatch) => {
      tasks = tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));
      patches.push({ id, patch });
      return tasks.find((t) => t.id === id)!;
    }),
    move: vi.fn(async (id: string, status: TaskStatus, order: number) => {
      tasks = tasks.map((t) => (t.id === id ? { ...t, status, order } : t));
      moves.push({ id, status, order });
      return tasks.find((t) => t.id === id)!;
    }),
    archive: vi.fn(async (id: string) => {
      tasks = tasks.map((t) => (t.id === id ? { ...t, status: "archived" as TaskStatus } : t));
      return tasks.find((t) => t.id === id)!;
    }),
  };
  return {
    store,
    moves,
    patches,
    get tasks() {
      return tasks;
    },
    set(next: TaskEntry[]) {
      tasks = next.map((t) => ({ ...t }));
    },
  };
}

/** A controllable fake of the plugin-level convo-state emitter. */
function fakeEmitter() {
  const listeners = new Set<ConvoStateListener>();
  return {
    subscribe(fn: ConvoStateListener): Unsubscribe {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(event: ConvoStateEvent) {
      for (const l of listeners) l(event);
    },
    get size() {
      return listeners.size;
    },
  };
}

/** A deps bundle wired to controllable fakes. `spawn` hands out sequential
 *  convo ids and records what it was asked to spawn. */
function makeDeps(initial: TaskEntry[] = []) {
  const emitter = fakeEmitter();
  const backing = fakeStore(initial);
  const spawned: Array<{ prompt: string; model?: string }> = [];
  let n = 0;
  const liveness = new Map<string, ConvoSnapshot>();
  const deps: DriverDeps = {
    store: backing.store,
    subscribe: (fn) => emitter.subscribe(fn),
    spawn: vi.fn(async (prompt: string, opts?: { model?: string }) => {
      spawned.push({ prompt, ...(opts?.model ? { model: opts.model } : {}) });
      return `convo-${++n}`;
    }),
    liveness: (convoId: string) => liveness.get(convoId) ?? { exists: false, streaming: false, pendingRequest: false },
    config: () => ({ maxConcurrent: 2 }),
    notify: vi.fn(),
    onChange: vi.fn(),
  };
  return { deps, emitter, backing, spawned, liveness };
}

/** Let the driver's async chain (store awaits + spawn awaits) fully settle.
 *  A macrotask tick drains every pending microtask the dispatch chain queued. */
const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

describe("OrchestratorDriver — lifecycle", () => {
  it("subscribes to the emitter on start and unsubscribes on stop", async () => {
    const { deps, emitter } = makeDeps();
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    expect(emitter.size).toBe(1);
    driver.stop();
    expect(emitter.size).toBe(0);
  });

  it("loads tasks from the store on start", async () => {
    const { deps, backing } = makeDeps([task({ id: "task-1" })]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    expect(backing.store.load).toHaveBeenCalled();
    expect(driver.snapshot().map((t) => t.id)).toEqual(["task-1"]);
  });
});

describe("OrchestratorDriver — enqueue + spawn", () => {
  it("enqueuing a backlog task spawns a conversation and records its id", async () => {
    const { deps, backing, spawned } = makeDeps([task({ id: "task-1", prompt: "write the post" })]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();

    await driver.enqueue("task-1");

    expect(spawned).toEqual([{ prompt: "write the post" }]);
    const t = driver.snapshot().find((x) => x.id === "task-1")!;
    expect(t.status).toBe("running");
    expect(t.convo).toBe("convo-1");
    // The recorded convo id must be persisted through the store.
    expect(backing.patches.some((p) => p.id === "task-1" && p.patch.convo === "convo-1")).toBe(true);
  });

  it("passes the task's pinned model to spawn", async () => {
    const { deps, spawned } = makeDeps([task({ id: "task-1", model: "claude-opus-4-8" })]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await driver.enqueue("task-1");
    expect(spawned[0]).toEqual({ prompt: "do the thing", model: "claude-opus-4-8" });
  });
});

describe("OrchestratorDriver — concurrency cap", () => {
  it("with cap 2 and 3 queued tasks, only 2 conversations spawn", async () => {
    const { deps, spawned } = makeDeps([
      task({ id: "task-1", order: 0 }),
      task({ id: "task-2", order: 1 }),
      task({ id: "task-3", order: 2 }),
    ]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();

    await driver.enqueue("task-1");
    await driver.enqueue("task-2");
    await driver.enqueue("task-3");

    expect(spawned).toHaveLength(2);
    const running = driver.snapshot().filter((t) => t.status === "running");
    expect(running).toHaveLength(2);
    const queued = driver.snapshot().filter((t) => t.status === "queued");
    expect(queued.map((t) => t.id)).toEqual(["task-3"]);
  });

  it("the third task starts when a running slot frees (turn-end on one running task)", async () => {
    const { deps, emitter, spawned } = makeDeps([
      task({ id: "task-1", order: 0 }),
      task({ id: "task-2", order: 1 }),
      task({ id: "task-3", order: 2 }),
    ]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await driver.enqueue("task-1");
    await driver.enqueue("task-2");
    await driver.enqueue("task-3");
    expect(spawned).toHaveLength(2);

    // task-1 got convo-1; its turn ends → Review, freeing a slot.
    const t1 = driver.snapshot().find((t) => t.id === "task-1")!;
    emitter.emit({ convoId: t1.convo!, state: "turn-end" });
    await flush();

    // Third task should now have spawned.
    expect(spawned).toHaveLength(3);
    const t3 = driver.snapshot().find((t) => t.id === "task-3")!;
    expect(t3.status).toBe("running");
    expect(t3.convo).toBe("convo-3");
  });
});

describe("OrchestratorDriver — convo-state → column moves", () => {
  it("turn-start keeps the task running; turn-end moves it to review", async () => {
    const { deps, emitter } = makeDeps([task({ id: "task-1", order: 0 })]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await driver.enqueue("task-1");
    const convo = driver.snapshot().find((t) => t.id === "task-1")!.convo!;

    emitter.emit({ convoId: convo, state: "turn-start" });
    await flush();
    expect(driver.snapshot().find((t) => t.id === "task-1")!.status).toBe("running");

    emitter.emit({ convoId: convo, state: "turn-end" });
    await flush();
    expect(driver.snapshot().find((t) => t.id === "task-1")!.status).toBe("review");
  });

  it("needs-input / error / stopped park the task in needs-input with a reason badge", async () => {
    const cases: Array<{ state: "needs-input" | "error" | "stopped"; reason: "ask" | "error" | "stopped" }> = [
      { state: "needs-input", reason: "ask" },
      { state: "error", reason: "error" },
      { state: "stopped", reason: "stopped" },
    ];
    for (const c of cases) {
      const { deps, emitter } = makeDeps([task({ id: "task-1", order: 0 })]);
      const driver = new OrchestratorDriver(deps);
      await driver.start();
      await driver.enqueue("task-1");
      const convo = driver.snapshot().find((t) => t.id === "task-1")!.convo!;
      emitter.emit({ convoId: convo, state: c.state, reason: c.reason });
      await flush();
      const t = driver.snapshot().find((x) => x.id === "task-1")!;
      expect(t.status).toBe("needs-input");
      expect(t.inputReason).toBeDefined();
    }
  });

  it("turn-end NEVER completes a task (Done is user-action-only)", async () => {
    const { deps, emitter } = makeDeps([task({ id: "task-1", order: 0 })]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await driver.enqueue("task-1");
    const convo = driver.snapshot().find((t) => t.id === "task-1")!.convo!;
    emitter.emit({ convoId: convo, state: "turn-end" });
    await flush();
    expect(driver.snapshot().find((t) => t.id === "task-1")!.status).toBe("review");
    // No convo event may move it to done.
    expect(driver.snapshot().find((t) => t.id === "task-1")!.status).not.toBe("done");
  });

  it("markDone only completes a review task (explicit user action)", async () => {
    const { deps, emitter } = makeDeps([task({ id: "task-1", order: 0 })]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await driver.enqueue("task-1");
    const convo = driver.snapshot().find((t) => t.id === "task-1")!.convo!;
    emitter.emit({ convoId: convo, state: "turn-end" });
    await flush();
    await driver.markDone("task-1");
    expect(driver.snapshot().find((t) => t.id === "task-1")!.status).toBe("done");
  });
});

describe("OrchestratorDriver — archive", () => {
  it("archives a card from any column (not just done), hiding it but keeping the block", async () => {
    const { deps, backing } = makeDeps([task({ id: "task-1", status: "review", order: 0 })]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await driver.archive("task-1");
    // In-memory: archived (hidden by the board's column filter).
    expect(driver.snapshot().find((t) => t.id === "task-1")!.status).toBe("archived");
    // Persisted via store.archive (block kept, status archived).
    expect(backing.store.archive).toHaveBeenCalledWith("task-1");
    expect(backing.tasks.find((t) => t.id === "task-1")!.status).toBe("archived");
  });
});

describe("OrchestratorDriver — spawn failure", () => {
  it("spawn rejection parks the task in needs-input and notifies", async () => {
    const { deps } = makeDeps([task({ id: "task-1", order: 0 })]);
    deps.spawn = vi.fn(async () => {
      throw new Error("CLI down");
    });
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    await driver.enqueue("task-1");
    await flush();
    const t = driver.snapshot().find((x) => x.id === "task-1")!;
    expect(t.status).toBe("needs-input");
    expect(deps.notify).toHaveBeenCalled();
  });
});

describe("OrchestratorDriver — reconciliation on boot", () => {
  it("flags chatMissing for a running task whose convo is gone", async () => {
    const { deps } = makeDeps([task({ id: "task-1", status: "running", convo: "convo-old", order: 0 })]);
    // liveness returns exists:false for convo-old (default).
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    const t = driver.snapshot().find((x) => x.id === "task-1")!;
    expect(t.chatMissing).toBe(true);
  });

  it("corrects a running task to review when its convo is idle", async () => {
    const { deps, liveness } = makeDeps([
      task({ id: "task-1", status: "running", convo: "convo-live", order: 0 }),
    ]);
    liveness.set("convo-live", { exists: true, streaming: false, pendingRequest: false });
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    expect(driver.snapshot().find((x) => x.id === "task-1")!.status).toBe("review");
  });

  it("re-running a chat-missing task spawns a fresh convo and records the new id", async () => {
    const { deps, spawned } = makeDeps([task({ id: "task-1", status: "running", convo: "convo-old", order: 0 })]);
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    expect(driver.snapshot().find((x) => x.id === "task-1")!.chatMissing).toBe(true);

    await driver.run("task-1");
    await flush();
    expect(spawned).toHaveLength(1);
    const t = driver.snapshot().find((x) => x.id === "task-1")!;
    expect(t.status).toBe("running");
    expect(t.convo).toBe("convo-1");
    expect(t.chatMissing).toBeFalsy();
  });
});
