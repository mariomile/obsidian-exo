import { describe, it, expect, vi } from "vitest";
import { createBacklogTask, createChildTask, ChildTaskRefused, TaskStore, type TaskVaultAdapter } from "../src/obsidian/task-store";
import { parseTasksFile, TASKS_PATH, type TaskEntry } from "../src/core/tasks";
import { WriteQueue } from "../src/core/write-queue";

/** A minimal in-memory fake of the slice of the Obsidian vault API the task
 *  store needs — enough to prove read-modify-write semantics without pulling
 *  in the real `obsidian` module (aliased to a sparse stub under vitest). */
function fakeVault(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const folders = new Set<string>();
  const adapter: TaskVaultAdapter = {
    getFile: (path: string) => (files.has(path) ? { path } : null),
    read: async (path: string) => {
      const v = files.get(path);
      if (v === undefined) throw new Error(`no such file: ${path}`);
      return v;
    },
    create: async (path: string, content: string) => {
      if (files.has(path)) throw new Error(`already exists: ${path}`);
      files.set(path, content);
    },
    modify: async (path: string, content: string) => {
      if (!files.has(path)) throw new Error(`no such file: ${path}`);
      files.set(path, content);
    },
    // Mirrors the real `adaptAppToTaskVault` contract: callers pass the FILE
    // path and this derives/creates the parent folder, not the file's own path.
    ensureFolder: async (path: string) => {
      const slash = path.lastIndexOf("/");
      if (slash <= 0) return;
      folders.add(path.slice(0, slash));
    },
  };
  return { adapter, files, folders };
}

describe("createBacklogTask", () => {
  it("creates the tasks.md file when it doesn't exist yet, with a backlog entry", async () => {
    const { adapter, files } = fakeVault();
    const queue = new WriteQueue();
    const entry = await createBacklogTask(adapter, queue, { title: "Ship the thing", prompt: "Do it" });

    expect(entry.status).toBe("backlog");
    expect(entry.title).toBe("Ship the thing");
    expect(files.has(TASKS_PATH)).toBe(true);
    const parsed = parseTasksFile(files.get(TASKS_PATH)!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].status).toBe("backlog");
    expect(parsed[0].title).toBe("Ship the thing");
    expect(parsed[0].prompt).toBe("Do it");
  });

  it("appends to an existing tasks.md without clobbering prior tasks", async () => {
    const existingBlock = [
      "## task-1",
      "- title: Old task",
      "- status: review",
      "- created: 2026-07-08T09:00:00.000Z",
      "- updated: 2026-07-08T09:00:00.000Z",
      "",
      "old prompt",
      "",
    ].join("\n");
    const { adapter, files } = fakeVault({ [TASKS_PATH]: existingBlock });
    const queue = new WriteQueue();
    await createBacklogTask(adapter, queue, { title: "New task", prompt: "new prompt" });

    const parsed = parseTasksFile(files.get(TASKS_PATH)!);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].title).toBe("Old task");
    expect(parsed[1].title).toBe("New task");
    expect(parsed[1].status).toBe("backlog");
  });

  it("serializes concurrent calls through the given WriteQueue (no lost update)", async () => {
    const { adapter, files } = fakeVault();
    const queue = new WriteQueue();
    await Promise.all([
      createBacklogTask(adapter, queue, { title: "One", prompt: "p1" }),
      createBacklogTask(adapter, queue, { title: "Two", prompt: "p2" }),
      createBacklogTask(adapter, queue, { title: "Three", prompt: "p3" }),
    ]);
    const parsed = parseTasksFile(files.get(TASKS_PATH)!);
    expect(parsed).toHaveLength(3);
    expect(parsed.map((t) => t.title).sort()).toEqual(["One", "Three", "Two"]);
  });

  it("enqueues onto the passed-in WriteQueue rather than writing synchronously outside it", async () => {
    const { adapter } = fakeVault();
    const queue = new WriteQueue();
    const spy = vi.spyOn(queue, "enqueue");
    await createBacklogTask(adapter, queue, { title: "T", prompt: "P" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("passes model through when provided", async () => {
    const { adapter, files } = fakeVault();
    const queue = new WriteQueue();
    const entry = await createBacklogTask(adapter, queue, { title: "T", prompt: "P", model: "claude-opus-4-6" });
    expect(entry.model).toBe("claude-opus-4-6");
    const parsed = parseTasksFile(files.get(TASKS_PATH)!);
    expect(parsed[0].model).toBe("claude-opus-4-6");
  });
});

describe("createChildTask", () => {
  it("writes a queued task carrying its parent convo id", async () => {
    const { adapter, files } = fakeVault();
    const queue = new WriteQueue();
    const entry = await createChildTask(adapter, queue, {
      title: "Research pricing",
      prompt: "Look into competitor pricing.",
      parent: "convo-parent-1",
    });
    expect(entry.status).toBe("queued");
    expect(entry.parent).toBe("convo-parent-1");
    const written = files.get(TASKS_PATH)!;
    expect(written).toContain("- parent: convo-parent-1");
    expect(written).toContain("- status: queued");

    const parsed = parseTasksFile(written);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].status).toBe("queued");
    expect(parsed[0].parent).toBe("convo-parent-1");
    expect(parsed[0].title).toBe("Research pricing");
    expect(parsed[0].prompt).toBe("Look into competitor pricing.");
  });

  it("creates the tasks.md file (and parent folder) when it doesn't exist yet", async () => {
    const { adapter, files, folders } = fakeVault();
    const queue = new WriteQueue();
    const createSpy = vi.spyOn(adapter, "create");
    const modifySpy = vi.spyOn(adapter, "modify");
    const ensureFolderSpy = vi.spyOn(adapter, "ensureFolder");

    await createChildTask(adapter, queue, {
      title: "First child",
      prompt: "Do it",
      parent: "convo-1",
    });

    expect(ensureFolderSpy).toHaveBeenCalledWith(TASKS_PATH);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(modifySpy).not.toHaveBeenCalled();
    expect(files.has(TASKS_PATH)).toBe(true);
    expect(folders.has("_system/orchestration")).toBe(true);
  });

  it("appends to an existing tasks.md without clobbering prior tasks (modify branch)", async () => {
    const existingBlock = [
      "## task-1",
      "- title: Old task",
      "- status: review",
      "- created: 2026-07-08T09:00:00.000Z",
      "- updated: 2026-07-08T09:00:00.000Z",
      "",
      "old prompt",
      "",
    ].join("\n");
    const { adapter, files } = fakeVault({ [TASKS_PATH]: existingBlock });
    const queue = new WriteQueue();
    const createSpy = vi.spyOn(adapter, "create");
    const modifySpy = vi.spyOn(adapter, "modify");

    await createChildTask(adapter, queue, {
      title: "New child",
      prompt: "new prompt",
      parent: "convo-2",
    });

    expect(modifySpy).toHaveBeenCalledTimes(1);
    expect(createSpy).not.toHaveBeenCalled();

    const parsed = parseTasksFile(files.get(TASKS_PATH)!);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].title).toBe("Old task");
    expect(parsed[0].status).toBe("review");
    expect(parsed[1].title).toBe("New child");
    expect(parsed[1].status).toBe("queued");
    expect(parsed[1].parent).toBe("convo-2");
  });

  it("enqueues onto the passed-in WriteQueue rather than writing synchronously outside it", async () => {
    const { adapter } = fakeVault();
    const queue = new WriteQueue();
    const spy = vi.spyOn(queue, "enqueue");
    await createChildTask(adapter, queue, { title: "T", prompt: "P", parent: "convo-3" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent calls through the given WriteQueue (no lost update, distinct ids)", async () => {
    const { adapter, files } = fakeVault();
    const queue = new WriteQueue();
    const [a, b, c] = await Promise.all([
      createChildTask(adapter, queue, { title: "One", prompt: "p1", parent: "convo-a" }),
      createChildTask(adapter, queue, { title: "Two", prompt: "p2", parent: "convo-a" }),
      createChildTask(adapter, queue, { title: "Three", prompt: "p3", parent: "convo-a" }),
    ]);
    // Fan-out is exactly the caller that creates N tasks in a tight loop — a
    // collision here means a later drag-to-done on ONE task would flip ALL
    // same-id entries via applyTaskPatch's id match.
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    const parsed = parseTasksFile(files.get(TASKS_PATH)!);
    expect(parsed).toHaveLength(3);
    expect(new Set(parsed.map((t) => t.id)).size).toBe(3);
    expect(parsed.every((t) => t.status === "queued")).toBe(true);
    expect(parsed.every((t) => t.parent === "convo-a")).toBe(true);
    expect(parsed.map((t) => t.title).sort()).toEqual(["One", "Three", "Two"]);
  });

  it("assigns unique ids even when Date.now() does not advance across calls (same-millisecond fan-out)", async () => {
    const { adapter, files } = fakeVault();
    const queue = new WriteQueue();
    const fixed = 1_700_000_000_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(fixed);
    try {
      const [a, b, c] = await Promise.all([
        createChildTask(adapter, queue, { title: "One", prompt: "p1", parent: "convo-b" }),
        createChildTask(adapter, queue, { title: "Two", prompt: "p2", parent: "convo-b" }),
        createChildTask(adapter, queue, { title: "Three", prompt: "p3", parent: "convo-b" }),
      ]);
      expect(new Set([a.id, b.id, c.id]).size).toBe(3);
      const parsed = parseTasksFile(files.get(TASKS_PATH)!);
      expect(parsed).toHaveLength(3);
      expect(new Set(parsed.map((t) => t.id)).size).toBe(3);
      expect(parsed.every((t) => t.status === "queued")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("stores a prompt containing $-sequences verbatim (String.replace metacharacters must not corrupt the ledger)", async () => {
    const { adapter, files } = fakeVault();
    const queue = new WriteQueue();
    // $$ / $& / $` are special inside String.prototype.replace's REPLACEMENT
    // argument (not its search argument). A naive `content.replace(oldBlock,
    // formatTask(queued))` where the entry's own prompt/title feed into the
    // replacement string is vulnerable if the block text itself is ever used
    // as a replacement value anywhere in the pipeline — assert the full
    // round-trip is byte-for-byte and the block still parses as ONE entry
    // in `queued` status, not split/duplicated into a stray `backlog` block.
    const trickyPrompt = "echo $$PID; sed s/x/$&-y/; before $` after";
    const entry = await createChildTask(adapter, queue, {
      title: "Tricky prompt",
      prompt: trickyPrompt,
      parent: "convo-tricky",
    });
    expect(entry.status).toBe("queued");
    expect(entry.prompt).toBe(trickyPrompt);

    const written = files.get(TASKS_PATH)!;
    const parsed = parseTasksFile(written);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].status).toBe("queued");
    expect(parsed[0].prompt).toBe(trickyPrompt);
    expect(parsed[0].parent).toBe("convo-tricky");
  });
});

describe("createChildTask gate (atomic cap check)", () => {
  it("gate approving (ok:true) proceeds to write exactly as with no gate", async () => {
    const { adapter, files } = fakeVault();
    const queue = new WriteQueue();
    const entry = await createChildTask(
      adapter,
      queue,
      { title: "Allowed", prompt: "go", parent: "convo-a" },
      TASKS_PATH,
      () => ({ ok: true })
    );
    expect(entry.status).toBe("queued");
    expect(parseTasksFile(files.get(TASKS_PATH)!)).toHaveLength(1);
  });

  it("gate refusing throws ChildTaskRefused carrying the reason and writes NOTHING", async () => {
    const { adapter, files } = fakeVault();
    const queue = new WriteQueue();
    await expect(
      createChildTask(
        adapter,
        queue,
        { title: "Refused", prompt: "nope", parent: "convo-a" },
        TASKS_PATH,
        () => ({ ok: false, reason: "cap hit" })
      )
    ).rejects.toThrow(ChildTaskRefused);
    expect(files.has(TASKS_PATH)).toBe(false);
  });

  it("preserves the gate's exact reason text on the thrown error", async () => {
    const { adapter } = fakeVault();
    const queue = new WriteQueue();
    try {
      await createChildTask(
        adapter,
        queue,
        { title: "Refused", prompt: "nope", parent: "convo-a" },
        TASKS_PATH,
        () => ({ ok: false, reason: "This conversation already has 5 open child tasks (cap 5)." })
      );
      expect.unreachable("expected createChildTask to reject");
    } catch (e) {
      expect(e).toBeInstanceOf(ChildTaskRefused);
      expect((e as ChildTaskRefused).reason).toBe("This conversation already has 5 open child tasks (cap 5).");
    }
  });

  it("evaluates the gate against a FRESH read taken inside its own queue turn, not a snapshot from before enqueue — a rejection does not poison later queued turns", async () => {
    const { adapter, files } = fakeVault();
    const queue = new WriteQueue();
    // Cap of 2: the gate only allows the write while fewer than 2 entries with
    // this parent already exist in the ledger AS OF THIS TURN. If the gate
    // were evaluated on a snapshot taken before all three calls were
    // enqueued (the bug this test exists to catch), all three would see 0
    // existing entries and all three would pass, landing 3 in the ledger.
    const gate = (tasks: TaskEntry[]) =>
      tasks.filter((t) => t.parent === "convo-cap").length < 2
        ? { ok: true as const }
        : { ok: false as const, reason: "cap 2 reached" };

    const results = await Promise.allSettled([
      createChildTask(adapter, queue, { title: "One", prompt: "p1", parent: "convo-cap" }, TASKS_PATH, gate),
      createChildTask(adapter, queue, { title: "Two", prompt: "p2", parent: "convo-cap" }, TASKS_PATH, gate),
      createChildTask(adapter, queue, { title: "Three", prompt: "p3", parent: "convo-cap" }, TASKS_PATH, gate),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ChildTaskRefused);

    const parsed = parseTasksFile(files.get(TASKS_PATH)!);
    expect(parsed).toHaveLength(2);
    expect(parsed.every((t) => t.parent === "convo-cap")).toBe(true);
  });
});

describe("TaskStore", () => {
  describe("load()", () => {
    it("returns an empty task list (not an error) when tasks.md doesn't exist", async () => {
      const { adapter } = fakeVault();
      const store = new TaskStore(adapter, new WriteQueue());
      const { tasks, warnings } = await store.load();
      expect(tasks).toEqual([]);
      expect(warnings).toEqual([]);
    });

    it("reads existing entries via parseTasksFile", async () => {
      const existingBlock = [
        "## task-1",
        "- title: Old task",
        "- status: review",
        "- created: 2026-07-08T09:00:00.000Z",
        "- updated: 2026-07-08T09:00:00.000Z",
        "",
        "old prompt",
        "",
      ].join("\n");
      const { adapter } = fakeVault({ [TASKS_PATH]: existingBlock });
      const store = new TaskStore(adapter, new WriteQueue());
      const { tasks, warnings } = await store.load();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("Old task");
      expect(warnings).toEqual([]);
    });

    it("never throws on malformed content and surfaces a warning instead", async () => {
      const malformed = [
        "## task-1",
        "- status: backlog",
        "- created: 2026-07-08T09:00:00.000Z",
        "- updated: 2026-07-08T09:00:00.000Z",
        "",
        "prompt with no title",
      ].join("\n");
      const { adapter } = fakeVault({ [TASKS_PATH]: malformed });
      const store = new TaskStore(adapter, new WriteQueue());
      await expect(store.load()).resolves.not.toThrow();
      const { tasks, warnings } = await store.load();
      expect(tasks).toHaveLength(1);
      expect(warnings.length).toBeGreaterThan(0);
    });

    it("never throws even if reading the file itself rejects", async () => {
      const { adapter, files } = fakeVault({ [TASKS_PATH]: "whatever" });
      // Simulate a corrupt/unreadable file: getFile says it exists, read() rejects.
      const brokenAdapter: TaskVaultAdapter = {
        ...adapter,
        read: async () => {
          throw new Error("EIO: corrupt file");
        },
      };
      const store = new TaskStore(brokenAdapter, new WriteQueue());
      const { tasks, warnings } = await store.load();
      expect(tasks).toEqual([]);
      expect(warnings.length).toBeGreaterThan(0);
      expect(files.has(TASKS_PATH)).toBe(true); // untouched
    });
  });

  describe("create()", () => {
    it("creates the file (and parent folder) on first write", async () => {
      const { adapter, files, folders } = fakeVault();
      const store = new TaskStore(adapter, new WriteQueue());
      const entry = await store.create({ title: "First", prompt: "Do it" });
      expect(entry.status).toBe("backlog");
      expect(files.has(TASKS_PATH)).toBe(true);
      expect(folders.has("_system/orchestration")).toBe(true);
    });

    it("creates a marked task once across concurrent retries", async () => {
      const { adapter } = fakeVault();
      const store = new TaskStore(adapter, new WriteQueue());
      const marker = "<!-- exo-proposal:proposal-task -->";
      const task = { title: "Once", prompt: `Do it\n\n${marker}` };

      const [first, second] = await Promise.all([
        store.createOnce(task, marker),
        store.createOnce(task, marker),
      ]);

      expect(second.id).toBe(first.id);
      expect((await store.load()).tasks).toHaveLength(1);
    });
  });

  describe("update()", () => {
    it("patches an existing task's fields", async () => {
      const { adapter } = fakeVault();
      const store = new TaskStore(adapter, new WriteQueue());
      const entry = await store.create({ title: "Original", prompt: "P" });
      const updated = await store.update(entry.id, { title: "Renamed" });
      expect(updated.title).toBe("Renamed");
      const { tasks } = await store.load();
      expect(tasks[0].title).toBe("Renamed");
    });

    it("rejects when the id doesn't exist", async () => {
      const { adapter } = fakeVault();
      const store = new TaskStore(adapter, new WriteQueue());
      await expect(store.update("task-missing", { title: "x" })).rejects.toThrow();
    });
  });

  describe("move()", () => {
    it("updates status and order for a task", async () => {
      const { adapter } = fakeVault();
      const store = new TaskStore(adapter, new WriteQueue());
      const entry = await store.create({ title: "T", prompt: "P" });
      const moved = await store.move(entry.id, "queued", 1);
      expect(moved.status).toBe("queued");
      expect(moved.order).toBe(1);
    });
  });

  describe("archive()", () => {
    it("sets status to archived and keeps the block in the file", async () => {
      const { adapter } = fakeVault();
      const store = new TaskStore(adapter, new WriteQueue());
      const entry = await store.create({ title: "T", prompt: "P" });
      const archived = await store.archive(entry.id);
      expect(archived.status).toBe("archived");
      const { tasks } = await store.load();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe("archived");
      expect(tasks[0].title).toBe("T");
      expect(tasks[0].prompt).toBe("P");
    });
  });

  describe("concurrency", () => {
    it("serializes create/update/move/archive through the SAME shared WriteQueue", async () => {
      const { adapter } = fakeVault();
      const queue = new WriteQueue();
      const spy = vi.spyOn(queue, "enqueue");
      const store = new TaskStore(adapter, queue);
      const a = await store.create({ title: "A", prompt: "pa" });
      const b = await store.create({ title: "B", prompt: "pb" });
      await Promise.all([
        store.update(a.id, { title: "A2" }),
        store.move(b.id, "queued", 0),
        store.archive(a.id),
      ]);
      // create x2 + update + move + archive = 5 enqueues, all on the injected queue.
      expect(spy).toHaveBeenCalledTimes(5);
      const { tasks } = await store.load();
      expect(tasks).toHaveLength(2);
    });
  });
});
