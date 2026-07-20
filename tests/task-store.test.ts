import { describe, it, expect, vi } from "vitest";
import { createBacklogTask, TaskStore, type TaskVaultAdapter } from "../src/obsidian/task-store";
import { parseTasksFile, TASKS_PATH } from "../src/core/tasks";
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
