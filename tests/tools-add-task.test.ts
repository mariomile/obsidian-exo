import { describe, it, expect } from "vitest";
import { createObsidianToolServer } from "../src/obsidian/tools";
import { parseTasksFile, TASKS_PATH } from "../src/core/tasks";
import { WriteQueue } from "../src/core/write-queue";

/** Registered tool names on an SDK MCP server instance — the same shape
 *  `server.instance._registeredTools` exposes across the modelcontextprotocol
 *  SDK build this repo pins. */
function toolNames(server: ReturnType<typeof createObsidianToolServer>): string[] {
  return Object.keys((server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
}

/** Minimal fake Obsidian `App` — just enough surface for `createObsidianToolServer`
 *  to construct without throwing, plus an in-memory vault so `add_task` can be
 *  invoked end-to-end against a fake `vault.create`/`modify`. */
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

describe("add_task tool registration (orchestrationEnabled gating)", () => {
  it("is ABSENT from the tool list when orchestrationEnabled is false (default)", () => {
    const { app } = fakeApp();
    const server = createObsidianToolServer(app, true, false, undefined, true, new WriteQueue(), false);
    expect(toolNames(server)).not.toContain("add_task");
  });

  it("is PRESENT in the tool list when orchestrationEnabled is true", () => {
    const { app } = fakeApp();
    const server = createObsidianToolServer(app, true, false, undefined, true, new WriteQueue(), true);
    expect(toolNames(server)).toContain("add_task");
  });

  it("produces a BYTE-IDENTICAL tool list with the flag off vs. calling the function with no flag arg at all (pre-feature default)", () => {
    const { app: appA } = fakeApp();
    const { app: appB } = fakeApp();
    // Pre-feature call shape (no orchestrationEnabled / tasksWriteQueue args at all).
    const before = createObsidianToolServer(appA, true, false, undefined, true);
    // Post-feature call shape, flag explicitly off.
    const after = createObsidianToolServer(appB, true, false, undefined, true, new WriteQueue(), false);
    expect(toolNames(after)).toEqual(toolNames(before));
  });
});

describe("add_task tool behavior (flag on)", () => {
  it("creates a backlog entry in tasks.md via the WriteQueue path — no direct vault write outside it", async () => {
    const { app, files } = fakeApp();
    const queue = new WriteQueue();
    const server = createObsidianToolServer(app, true, false, undefined, true, queue, true);
    const registered = (server.instance as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
    })._registeredTools;
    const addTask = registered["add_task"];
    expect(addTask).toBeTruthy();

    expect(files.has(TASKS_PATH)).toBe(false);
    const result: any = await addTask.handler({ title: "Draft the launch post", prompt: "Write it up" }, {});
    expect(result.isError).toBeFalsy();

    expect(files.has(TASKS_PATH)).toBe(true);
    const parsed = parseTasksFile(files.get(TASKS_PATH)!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].status).toBe("backlog");
    expect(parsed[0].title).toBe("Draft the launch post");
    expect(parsed[0].prompt).toBe("Write it up");
  });

  it("respects an optional model argument", async () => {
    const { app, files } = fakeApp();
    const queue = new WriteQueue();
    const server = createObsidianToolServer(app, true, false, undefined, true, queue, true);
    const registered = (server.instance as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
    })._registeredTools;
    await registered["add_task"].handler({ title: "T", prompt: "P", model: "claude-opus-4-6" }, {});
    const parsed = parseTasksFile(files.get(TASKS_PATH)!);
    expect(parsed[0].model).toBe("claude-opus-4-6");
  });
});
