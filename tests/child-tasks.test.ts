import { describe, it, expect } from "vitest";
import {
  childrenOf,
  openChildCount,
  fanoutDepth,
  canSpawnChild,
  MAX_OPEN_CHILDREN,
} from "../src/core/child-tasks";
import type { TaskEntry } from "../src/core/tasks";

function task(over: Partial<TaskEntry> & { id: string }): TaskEntry {
  return {
    title: "t",
    status: "queued",
    created: "2026-08-10T10:00:00.000Z",
    updated: "2026-08-10T10:00:00.000Z",
    prompt: "p",
    ...over,
  } as TaskEntry;
}

describe("childrenOf / openChildCount", () => {
  it("returns only tasks whose parent matches", () => {
    const tasks = [
      task({ id: "task-1", parent: "convo-a" }),
      task({ id: "task-2", parent: "convo-b" }),
      task({ id: "task-3" }),
    ];
    expect(childrenOf(tasks, "convo-a").map((t) => t.id)).toEqual(["task-1"]);
  });

  it("does not count done or archived children as open", () => {
    const tasks = [
      task({ id: "task-1", parent: "convo-a", status: "running" }),
      task({ id: "task-2", parent: "convo-a", status: "done" }),
      task({ id: "task-3", parent: "convo-a", status: "archived" }),
    ];
    expect(openChildCount(tasks, "convo-a")).toBe(1);
  });
});

describe("fanoutDepth", () => {
  it("is 0 for a convo that is not itself a child", () => {
    expect(fanoutDepth([task({ id: "task-1", parent: "convo-a" })], "convo-a")).toBe(0);
  });

  it("is 1 for the convo of a task that has a parent", () => {
    const tasks = [task({ id: "task-1", parent: "convo-a", convo: "convo-b" })];
    expect(fanoutDepth(tasks, "convo-b")).toBe(1);
  });

  it("is 2 for a grandchild convo", () => {
    const tasks = [
      task({ id: "task-1", parent: "convo-a", convo: "convo-b" }),
      task({ id: "task-2", parent: "convo-b", convo: "convo-c" }),
    ];
    expect(fanoutDepth(tasks, "convo-c")).toBe(2);
  });

  it("terminates on a cyclic ledger instead of hanging", () => {
    const tasks = [
      task({ id: "task-1", parent: "convo-b", convo: "convo-a" }),
      task({ id: "task-2", parent: "convo-a", convo: "convo-b" }),
    ];
    expect(fanoutDepth(tasks, "convo-a")).toBeGreaterThanOrEqual(2);
  });
});

describe("canSpawnChild", () => {
  it("allows a spawn under both caps", () => {
    expect(canSpawnChild([], "convo-a")).toEqual({ ok: true });
  });

  it("refuses past the open-children cap, naming the cap", () => {
    const tasks = Array.from({ length: MAX_OPEN_CHILDREN }, (_, i) =>
      task({ id: `task-${i}`, parent: "convo-a", status: "queued" })
    );
    const res = canSpawnChild(tasks, "convo-a");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain(String(MAX_OPEN_CHILDREN));
  });

  it("refuses at max depth", () => {
    const tasks = [
      task({ id: "task-1", parent: "convo-a", convo: "convo-b" }),
      task({ id: "task-2", parent: "convo-b", convo: "convo-c" }),
    ];
    const res = canSpawnChild(tasks, "convo-c");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("depth");
  });
});
