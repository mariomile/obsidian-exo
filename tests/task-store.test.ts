import { describe, it, expect, vi } from "vitest";
import { createBacklogTask, type TaskVaultAdapter } from "../src/obsidian/task-store";
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
    ensureFolder: async (dir: string) => {
      folders.add(dir);
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
