import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OrchestrationRuntime,
  HOST_RETRY_MS,
  type OrchestrationDeps,
} from "../src/obsidian/orchestration";
import type { ConvoStateListener, Unsubscribe } from "../src/core/convo-state";
import type { TaskEntry, TaskStatus, TaskPatch } from "../src/core/tasks";
import type { ChildReport } from "../src/core/child-reports";

/**
 * The runtime that made orchestration independent of the Orchestration Board
 * tab. Everything Obsidian-shaped is injected, so the whole lifecycle — start,
 * stop, hot-toggle, ledger reload, host retry — runs here with fakes.
 */

function task(over: Partial<TaskEntry> & { id: string }): TaskEntry {
  return {
    title: "T",
    status: "backlog",
    created: "2026-08-10T00:00:00.000Z",
    updated: "2026-08-10T00:00:00.000Z",
    prompt: "do the thing",
    ...over,
  };
}

/** An in-memory ledger with the runtime's store surface. */
function fakeStore(initial: TaskEntry[] = []) {
  let tasks = initial.map((t) => ({ ...t }));
  return {
    load: vi.fn(async () => ({ tasks: tasks.map((t) => ({ ...t })), warnings: [] as string[] })),
    update: vi.fn(async (id: string, patch: TaskPatch) => {
      tasks = tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));
      return tasks.find((t) => t.id === id)!;
    }),
    move: vi.fn(async (id: string, status: TaskStatus, order: number) => {
      tasks = tasks.map((t) => (t.id === id ? { ...t, status, order } : t));
      return tasks.find((t) => t.id === id)!;
    }),
    archive: vi.fn(async (id: string) => {
      tasks = tasks.map((t) => (t.id === id ? { ...t, status: "archived" as TaskStatus } : t));
      return tasks.find((t) => t.id === id)!;
    }),
    set(next: TaskEntry[]) {
      tasks = next.map((t) => ({ ...t }));
    },
    get tasks() {
      return tasks;
    },
  };
}

/** A one-slot channel: subscribe/emit plus a live listener count. */
function channel<T extends (...args: never[]) => void>() {
  const listeners = new Set<T>();
  return {
    subscribe(fn: T): Unsubscribe {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    fire(...args: Parameters<T>) {
      for (const l of [...listeners]) l(...args);
    },
    get size() {
      return listeners.size;
    },
  };
}

function makeDeps(initial: TaskEntry[] = []) {
  const store = fakeStore(initial);
  const convo = channel<ConvoStateListener>();
  const hostSignal = channel<() => void>();
  const ledger = channel<() => void>();
  const spawned: Array<{ prompt: string; parent?: string }> = [];
  const reports: ChildReport[] = [];
  const state = { enabled: true, host: true, maxConcurrent: 2 };
  let n = 0;
  const deps: OrchestrationDeps = {
    enabled: () => state.enabled,
    store,
    subscribe: (l) => convo.subscribe(l),
    spawn: vi.fn(async (prompt: string, opts?: { model?: string; parent?: string }) => {
      spawned.push({ prompt, ...(opts?.parent ? { parent: opts.parent } : {}) });
      return `convo-${++n}`;
    }),
    liveness: () => ({ exists: false, streaming: false, pendingRequest: false }),
    config: () => ({ maxConcurrent: state.maxConcurrent }),
    notify: vi.fn(),
    lastAssistantText: () => "",
    onChildReport: (r) => reports.push(r),
    canSpawn: () => state.host,
    onHostSignal: (cb) => hostSignal.subscribe(cb),
    watchLedger: (cb) => ledger.subscribe(cb),
  };
  return { deps, store, convo, hostSignal, ledger, spawned, reports, state };
}

/** Drain the driver's async dispatch chain (store awaits + spawn awaits). */
const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve().then(() => undefined);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

describe("OrchestrationRuntime — runs without a board", () => {
  it("promotes and spawns a queued task with no board ever opened", async () => {
    const { deps, spawned } = makeDeps([
      task({ id: "task-1", status: "queued", order: 0, parent: "convo-parent" }),
    ]);
    const runtime = new OrchestrationRuntime(deps);

    await runtime.start();
    await flush();

    expect(spawned).toEqual([{ prompt: "do the thing", parent: "convo-parent" }]);
    expect(runtime.snapshot().find((t) => t.id === "task-1")!.status).toBe("running");
  });

  it("does not start when the orchestration flag is off", async () => {
    const { deps, spawned, state } = makeDeps([task({ id: "task-1", status: "queued", order: 0 })]);
    state.enabled = false;
    const runtime = new OrchestrationRuntime(deps);

    await runtime.start();
    await flush();

    expect(runtime.isRunning()).toBe(false);
    expect(spawned).toHaveLength(0);
  });

  it("sync() starts on a hot-enable and stops on a hot-disable, with no reload", async () => {
    const { deps, convo, state } = makeDeps([task({ id: "task-1", status: "queued", order: 0 })]);
    const runtime = new OrchestrationRuntime(deps);
    state.enabled = false;

    runtime.sync();
    await flush();
    expect(runtime.isRunning()).toBe(false);

    state.enabled = true;
    runtime.sync();
    await flush();
    expect(runtime.isRunning()).toBe(true);
    expect(convo.size).toBe(1);

    state.enabled = false;
    runtime.sync();
    expect(runtime.isRunning()).toBe(false);
    expect(convo.size).toBe(0);
  });

  it("start() twice does not double-start or double-subscribe", async () => {
    const { deps, convo, store, spawned } = makeDeps([
      task({ id: "task-1", status: "queued", order: 0 }),
    ]);
    const runtime = new OrchestrationRuntime(deps);

    // Concurrent (the plugin's layout-ready sync and a board opening in the same
    // tick) AND sequential (a second board opening later).
    await Promise.all([runtime.start(), runtime.start()]);
    await runtime.start();
    await flush();

    expect(convo.size).toBe(1);
    expect(spawned).toHaveLength(1);
    // Two loads per boot at most (warnings + driver), never four.
    expect(store.load.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("stop() unsubscribes convo-state, the ledger listener and leaves no timer behind", async () => {
    vi.useFakeTimers();
    try {
      const { deps, convo, ledger, state } = makeDeps([
        task({ id: "task-1", status: "queued", order: 0 }),
      ]);
      state.host = false; // force the host watch to arm, so stop() has a timer to clear
      const runtime = new OrchestrationRuntime(deps);
      await runtime.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(convo.size).toBe(1);
      expect(ledger.size).toBe(1);

      runtime.stop();

      expect(convo.size).toBe(0);
      expect(ledger.size).toBe(0);
      expect(runtime.isRunning()).toBe(false);
      // A leaked host-retry interval would keep firing forever after unload.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OrchestrationRuntime — renderers attach and detach", () => {
  it("a renderer detaching does not stop orchestration (closing the board)", async () => {
    const { deps, convo, spawned } = makeDeps([task({ id: "task-1", status: "queued", order: 0 })]);
    const runtime = new OrchestrationRuntime(deps);
    await runtime.start();
    await flush();

    const painted: TaskEntry[][] = [];
    const detach = runtime.onTasks((tasks) => painted.push(tasks));
    detach();

    expect(runtime.isRunning()).toBe(true);
    expect(convo.size).toBe(1);
    expect(spawned).toHaveLength(1);
  });

  it("attaching twice (open, close, open) does not double-subscribe the driver", async () => {
    const { deps, convo, store } = makeDeps([task({ id: "task-1", status: "queued", order: 0 })]);
    const runtime = new OrchestrationRuntime(deps);

    for (let i = 0; i < 3; i++) {
      const detach = runtime.onTasks(() => undefined);
      await runtime.start(); // what BoardView.onOpen does
      await flush();
      detach(); // what BoardView.onClose does
    }

    expect(convo.size).toBe(1);
    expect(store.load.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("feeds every attached renderer the fresh task list", async () => {
    const { deps } = makeDeps([task({ id: "task-1", status: "backlog", order: 0 })]);
    const runtime = new OrchestrationRuntime(deps);
    await runtime.start();
    await flush();

    const seen: string[] = [];
    runtime.onTasks((tasks) => seen.push(tasks.find((t) => t.id === "task-1")!.status));
    await runtime.run("task-1");
    await flush();

    expect(seen).toContain("running");
  });

  it("a throwing renderer cannot break orchestration", async () => {
    const { deps, spawned } = makeDeps([task({ id: "task-1", status: "queued", order: 0 })]);
    const runtime = new OrchestrationRuntime(deps);
    runtime.onTasks(() => {
      throw new Error("render blew up");
    });

    await runtime.start();
    await flush();

    expect(spawned).toHaveLength(1);
  });
});

describe("OrchestrationRuntime — no conversation host yet", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("leaves the task queued: no spawn, no badge, no notice, no child report", async () => {
    const { deps, state, spawned, reports } = makeDeps([
      task({ id: "task-1", status: "queued", order: 0, parent: "convo-parent" }),
    ]);
    state.host = false;
    const runtime = new OrchestrationRuntime(deps);

    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);

    const t = runtime.snapshot().find((x) => x.id === "task-1")!;
    expect(t.status).toBe("queued");
    expect(t.inputReason).toBeUndefined();
    expect(spawned).toHaveLength(0);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(reports).toEqual([]);
  });

  it("starts the task when a host appears, on the workspace signal", async () => {
    const { deps, state, spawned, hostSignal } = makeDeps([
      task({ id: "task-1", status: "queued", order: 0 }),
    ]);
    state.host = false;
    const runtime = new OrchestrationRuntime(deps);
    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(spawned).toHaveLength(0);

    state.host = true;
    hostSignal.fire();
    await vi.advanceTimersByTimeAsync(0);

    expect(spawned).toHaveLength(1);
    expect(runtime.snapshot().find((t) => t.id === "task-1")!.status).toBe("running");
  });

  it("a signal that did NOT produce a host keeps waiting instead of spawning", async () => {
    const { deps, state, spawned, hostSignal } = makeDeps([
      task({ id: "task-1", status: "queued", order: 0 }),
    ]);
    state.host = false;
    const runtime = new OrchestrationRuntime(deps);
    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);

    hostSignal.fire();
    await vi.advanceTimersByTimeAsync(0);

    expect(spawned).toHaveLength(0);
    expect(runtime.snapshot().find((t) => t.id === "task-1")!.status).toBe("queued");
  });

  it("the timer backstop catches a host that arrives with no signal, then stands down", async () => {
    // The case that needs it: a ChatView leaf restored from the saved layout but
    // still deferred. It materialises on `loadIfDeferred()`, not on a gesture, so
    // there is no workspace event to hang off.
    const { deps, state, spawned, hostSignal } = makeDeps([
      task({ id: "task-1", status: "queued", order: 0 }),
    ]);
    state.host = false;
    const runtime = new OrchestrationRuntime(deps);
    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);

    state.host = true;
    await vi.advanceTimersByTimeAsync(HOST_RETRY_MS);

    expect(spawned).toHaveLength(1);
    // Armed only while something is waiting: the poll and the workspace
    // subscription both stand down the moment a host is found.
    expect(vi.getTimerCount()).toBe(0);
    expect(hostSignal.size).toBe(0);
  });

  it("consumes no slot while withheld — the full cap is available once a host exists", async () => {
    const { deps, state, spawned, hostSignal } = makeDeps([
      task({ id: "task-1", status: "queued", order: 0 }),
      task({ id: "task-2", status: "queued", order: 1 }),
      task({ id: "task-3", status: "queued", order: 2 }),
    ]);
    state.host = false;
    const runtime = new OrchestrationRuntime(deps);
    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);

    state.host = true;
    hostSignal.fire();
    await vi.advanceTimersByTimeAsync(0);

    expect(spawned).toHaveLength(2); // cap 2, not 1 and not 3
    expect(runtime.snapshot().filter((t) => t.status === "running")).toHaveLength(2);
  });

  it("a genuine spawn failure still parks the task and tells its parent", async () => {
    const { deps, reports } = makeDeps([
      task({ id: "task-1", status: "queued", order: 0, parent: "convo-parent" }),
    ]);
    deps.spawn = vi.fn(async () => {
      throw new Error("CLI down");
    });
    const runtime = new OrchestrationRuntime(deps);

    await runtime.start();
    await vi.advanceTimersByTimeAsync(5000); // past the report debounce

    const t = runtime.snapshot().find((x) => x.id === "task-1")!;
    expect(t.status).toBe("needs-input");
    expect(t.inputReason).toBe("error");
    expect(deps.notify).toHaveBeenCalled();
    expect(reports.map((r) => r.outcome)).toEqual(["error"]);
  });
});

describe("OrchestrationRuntime — ledger changes made by somebody else", () => {
  it("reloads and runs a task appended to the ledger while it was running", async () => {
    vi.useFakeTimers();
    try {
      const { deps, store, ledger, spawned } = makeDeps([]);
      const runtime = new OrchestrationRuntime(deps);
      await runtime.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(spawned).toHaveLength(0);

      // What `spawn_task` does: append a queued row straight into tasks.md.
      store.set([task({ id: "task-1", status: "queued", order: 0, parent: "convo-parent" })]);
      ledger.fire();
      // Debounce (400ms) + the self-write grace window (1000ms).
      await vi.advanceTimersByTimeAsync(2000);

      expect(spawned).toEqual([{ prompt: "do the thing", parent: "convo-parent" }]);
      expect(runtime.snapshot().find((t) => t.id === "task-1")!.status).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reload when the ledger event carries no real change", async () => {
    vi.useFakeTimers();
    try {
      const { deps, store, ledger } = makeDeps([task({ id: "task-1", status: "backlog" })]);
      const runtime = new OrchestrationRuntime(deps);
      await runtime.start();
      await vi.advanceTimersByTimeAsync(0);
      const loadsAfterBoot = store.load.mock.calls.length;

      ledger.fire();
      await vi.advanceTimersByTimeAsync(2000);

      // Exactly one extra load: the comparison read. No rebuild behind it.
      expect(store.load.mock.calls.length).toBe(loadsAfterBoot + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OrchestrationRuntime — teardown during boot", () => {
  it("abandons a driver whose runtime was stopped mid-load (no orphan subscription)", async () => {
    const { deps, convo } = makeDeps([task({ id: "task-1", status: "queued", order: 0 })]);
    // Hold the boot inside `store.load()`, exactly where an unload or a
    // hot-disable can land.
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    deps.store.load = vi.fn(async () => {
      await held;
      return { tasks: [task({ id: "task-1", status: "queued", order: 0 })], warnings: [] };
    });
    const runtime = new OrchestrationRuntime(deps);

    const starting = runtime.start();
    runtime.stop();
    release();
    await starting;
    await flush();

    expect(runtime.isRunning()).toBe(false);
    // The abandoned driver must not be left listening to convo-state.
    expect(convo.size).toBe(0);
  });
});
