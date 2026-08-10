import { describe, it, expect } from "vitest";
import { createObsidianToolServer } from "../src/obsidian/tools";
import { parseTasksFile, serializeTasks, TASKS_PATH, type TaskEntry } from "../src/core/tasks";
import { WriteQueue } from "../src/core/write-queue";
import { canSpawnChild, MAX_OPEN_CHILDREN } from "../src/core/child-tasks";

/** Registered tool names on an SDK MCP server instance — same shape read by
 *  `tests/tools-add-task.test.ts`, duplicated here rather than imported since
 *  that file keeps its helpers module-local. */
function toolNames(server: ReturnType<typeof createObsidianToolServer>): string[] {
  return Object.keys((server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
}

function registeredTools(server: ReturnType<typeof createObsidianToolServer>) {
  return (server.instance as unknown as {
    _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<any> }>;
  })._registeredTools;
}

/** Minimal fake Obsidian `App` — identical shape to `tests/tools-add-task.test.ts`'s
 *  `fakeApp()`, duplicated per that file's instruction not to invent a third
 *  fake app: this is the same one, just local to this file. */
function fakeApp() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const app = {
    vault: {
      getMarkdownFiles: () => [],
      getAbstractFileByPath: (path: string) => (files.has(path) ? ({ path } as any) : null),
      read: async (f: { path: string }) => {
        const v = files.get(f.path);
        if (v === undefined) throw new Error(`no such file: ${f.path}`);
        return v;
      },
      cachedRead: async (f: { path: string }) => files.get(f.path) ?? "",
      create: async (path: string, content: string) => {
        if (files.has(path)) throw new Error(`already exists: ${path}`);
        files.set(path, content);
        return { path };
      },
      modify: async (f: { path: string }, content: string) => {
        files.set(f.path, content);
      },
      createFolder: async (dir: string) => {
        folders.add(dir);
      },
    },
    workspace: {},
    metadataCache: {},
  } as any;
  return { app, files };
}

const ISO = new Date(1_720_000_000_000).toISOString();

function childEntry(id: string, parent: string, status: TaskEntry["status"] = "queued"): TaskEntry {
  return { id, title: `Child ${id}`, status, created: ISO, updated: ISO, parent, prompt: "work" };
}

describe("fan-out tools registration gating", () => {
  it("registers neither spawn_task nor list_tasks when orchestrationEnabled is false", () => {
    const { app } = fakeApp();
    const server = createObsidianToolServer(
      app, true, false, undefined, true,
      new WriteQueue(), /* orchestrationEnabled */ false, new WriteQueue(),
      false, undefined, new WriteQueue(), undefined, "convo-a"
    );
    const names = toolNames(server);
    expect(names).not.toContain("spawn_task");
    expect(names).not.toContain("list_tasks");
  });

  it("registers list_tasks but withholds spawn_task when there is no parentConvoId", () => {
    const { app } = fakeApp();
    const server = createObsidianToolServer(
      app, true, false, undefined, true,
      new WriteQueue(), /* orchestrationEnabled */ true, new WriteQueue(),
      false, undefined, new WriteQueue(), undefined, /* parentConvoId */ undefined
    );
    const names = toolNames(server);
    expect(names).toContain("list_tasks");
    expect(names).not.toContain("spawn_task");
  });

  it("registers both spawn_task and list_tasks when orchestration is on and a parentConvoId is present", () => {
    const { app } = fakeApp();
    const server = createObsidianToolServer(
      app, true, false, undefined, true,
      new WriteQueue(), /* orchestrationEnabled */ true, new WriteQueue(),
      false, undefined, new WriteQueue(), undefined, "convo-a"
    );
    const names = toolNames(server);
    expect(names).toContain("spawn_task");
    expect(names).toContain("list_tasks");
  });
});

describe("spawn_task behavior", () => {
  it("writes a queued child task carrying the parent convo id", async () => {
    const { app, files } = fakeApp();
    const queue = new WriteQueue();
    const server = createObsidianToolServer(
      app, true, false, undefined, true,
      queue, true, queue, false, undefined, queue, undefined, "convo-a"
    );
    const spawnTask = registeredTools(server)["spawn_task"];
    expect(spawnTask).toBeTruthy();

    expect(files.has(TASKS_PATH)).toBe(false);
    const result: any = await spawnTask.handler({ title: "Research the pricing page", prompt: "Go read it" }, {});
    expect(result.isError).toBeFalsy();

    const parsed = parseTasksFile(files.get(TASKS_PATH)!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].status).toBe("queued");
    expect(parsed[0].parent).toBe("convo-a");
    expect(parsed[0].title).toBe("Research the pricing page");
    expect(parsed[0].prompt).toBe("Go read it");
  });

  it("refuses past the open-children cap and writes NOTHING to the ledger", async () => {
    const { app, files } = fakeApp();
    const existing = Array.from({ length: MAX_OPEN_CHILDREN }, (_, i) => childEntry(`task-${1_720_000_000_000 + i}`, "convo-a"));
    files.set(TASKS_PATH, serializeTasks(existing));
    const before = files.get(TASKS_PATH);

    const queue = new WriteQueue();
    const server = createObsidianToolServer(
      app, true, false, undefined, true,
      queue, true, queue, false, undefined, queue, undefined, "convo-a"
    );
    const spawnTask = registeredTools(server)["spawn_task"];
    const gate = canSpawnChild(existing, "convo-a");
    expect(gate.ok).toBe(false);

    const result: any = await spawnTask.handler({ title: "One too many", prompt: "nope" }, {});
    // The refusal is reported back to the agent as a normal (non-error) result
    // carrying the cap's own reason text verbatim, so the agent doesn't blindly retry.
    expect(result.isError).toBeFalsy();
    if (!gate.ok) expect(result.content[0].text).toBe(gate.reason);

    expect(files.get(TASKS_PATH)).toBe(before);
    expect(parseTasksFile(files.get(TASKS_PATH)!)).toHaveLength(MAX_OPEN_CHILDREN);
  });
});

describe("list_tasks behavior", () => {
  it("defaults to only this conversation's children", async () => {
    const { app, files } = fakeApp();
    const entries: TaskEntry[] = [
      childEntry("task-1", "convo-a"),
      childEntry("task-2", "convo-b"),
      { id: "task-3", title: "Not delegated", status: "backlog", created: ISO, updated: ISO, prompt: "p" },
    ];
    files.set(TASKS_PATH, serializeTasks(entries));

    const queue = new WriteQueue();
    const server = createObsidianToolServer(
      app, true, false, undefined, true,
      queue, true, queue, false, undefined, queue, undefined, "convo-a"
    );
    const listTasks = registeredTools(server)["list_tasks"];
    expect(listTasks).toBeTruthy();

    const result: any = await listTasks.handler({}, {});
    const text = result.content[0].text as string;
    expect(text).toContain("task-1");
    expect(text).not.toContain("task-2");
    expect(text).not.toContain("task-3");
  });

  it("with all: true, lists every task on the board regardless of parentage", async () => {
    const { app, files } = fakeApp();
    const entries: TaskEntry[] = [
      childEntry("task-1", "convo-a"),
      childEntry("task-2", "convo-b"),
      { id: "task-3", title: "Not delegated", status: "backlog", created: ISO, updated: ISO, prompt: "p" },
    ];
    files.set(TASKS_PATH, serializeTasks(entries));

    const queue = new WriteQueue();
    const server = createObsidianToolServer(
      app, true, false, undefined, true,
      queue, true, queue, false, undefined, queue, undefined, "convo-a"
    );
    const listTasks = registeredTools(server)["list_tasks"];
    const result: any = await listTasks.handler({ all: true }, {});
    const text = result.content[0].text as string;
    expect(text).toContain("task-1");
    expect(text).toContain("task-2");
    expect(text).toContain("task-3");
  });

  it("is present (and reports no delegated tasks) even with no parentConvoId", async () => {
    const { app } = fakeApp();
    const server = createObsidianToolServer(
      app, true, false, undefined, true,
      new WriteQueue(), true, new WriteQueue(), false, undefined, new WriteQueue(), undefined, undefined
    );
    const listTasks = registeredTools(server)["list_tasks"];
    expect(listTasks).toBeTruthy();
    const result: any = await listTasks.handler({}, {});
    expect(result.isError).toBeFalsy();
  });
});
