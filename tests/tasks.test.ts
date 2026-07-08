import { describe, it, expect } from "vitest";
import {
  formatTask,
  parseTasksFile,
  addBacklogTask,
  TASKS_PATH,
  promoteToTaskCommandVisible,
  type TaskEntry,
} from "../src/core/tasks";

describe("formatTask / parseTasksFile round-trip", () => {
  it("round-trips a minimal backlog task (title + status + created + updated only)", () => {
    const entry: TaskEntry = {
      id: "task-1720000000000",
      title: "Write the launch post",
      status: "backlog",
      created: "2026-07-08T10:00:00.000Z",
      updated: "2026-07-08T10:00:00.000Z",
      prompt: "Draft a launch post for the new feature.",
    };
    const block = formatTask(entry);
    const [parsed] = parseTasksFile(block);
    expect(parsed).toEqual(entry);
  });

  it("round-trips optional fields: model, convo, order", () => {
    const entry: TaskEntry = {
      id: "task-1720000000001",
      title: "Research competitor pricing",
      status: "queued",
      created: "2026-07-08T10:00:00.000Z",
      updated: "2026-07-08T10:05:00.000Z",
      model: "claude-sonnet-5",
      convo: "convo-abc123",
      order: 3,
      prompt: "Look into competitor pricing pages and summarize.",
    };
    const block = formatTask(entry);
    const [parsed] = parseTasksFile(block);
    expect(parsed).toEqual(entry);
  });

  it("preserves a multi-line prompt verbatim", () => {
    const entry: TaskEntry = {
      id: "task-1720000000002",
      title: "Multi-line prompt",
      status: "backlog",
      created: "2026-07-08T10:00:00.000Z",
      updated: "2026-07-08T10:00:00.000Z",
      prompt: "Line one.\n\nLine two with a blank line above.\n- bullet",
    };
    const block = formatTask(entry);
    const [parsed] = parseTasksFile(block);
    expect(parsed.prompt).toBe(entry.prompt);
  });

  it("parses multiple blocks from one file", () => {
    const a: TaskEntry = {
      id: "task-1",
      title: "A",
      status: "backlog",
      created: "2026-07-08T10:00:00.000Z",
      updated: "2026-07-08T10:00:00.000Z",
      prompt: "prompt A",
    };
    const b: TaskEntry = {
      id: "task-2",
      title: "B",
      status: "done",
      created: "2026-07-08T11:00:00.000Z",
      updated: "2026-07-08T11:30:00.000Z",
      prompt: "prompt B",
    };
    const content = `${formatTask(a)}\n\n${formatTask(b)}\n`;
    const parsed = parseTasksFile(content);
    expect(parsed).toEqual([a, b]);
  });

  it("tolerantly skips garbage between/around blocks and never throws", () => {
    const content = [
      "some hand-edited junk at the top",
      "## task-123",
      "- title: Real task",
      "- status: backlog",
      "- created: 2026-07-08T10:00:00.000Z",
      "- updated: 2026-07-08T10:00:00.000Z",
      "",
      "the prompt",
      "",
      "trailing garbage line",
    ].join("\n");
    expect(() => parseTasksFile(content)).not.toThrow();
    const parsed = parseTasksFile(content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe("Real task");
  });

  it("returns [] for an empty file", () => {
    expect(parseTasksFile("")).toEqual([]);
  });

  it("falls back to an 'untitled' status of backlog on an unrecognized status value", () => {
    const content = [
      "## task-999",
      "- title: Weird status",
      "- status: not-a-real-status",
      "- created: 2026-07-08T10:00:00.000Z",
      "- updated: 2026-07-08T10:00:00.000Z",
      "",
      "prompt text",
    ].join("\n");
    const [parsed] = parseTasksFile(content);
    expect(parsed.status).toBe("backlog");
  });
});

describe("addBacklogTask", () => {
  it("appends a new backlog task block to empty content", () => {
    const { content, entry } = addBacklogTask("", { title: "New task", prompt: "Do the thing" }, 1720000000000);
    expect(entry.status).toBe("backlog");
    expect(entry.title).toBe("New task");
    expect(entry.prompt).toBe("Do the thing");
    expect(entry.id).toBe("task-1720000000000");
    const parsed = parseTasksFile(content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(entry);
  });

  it("appends to existing content without disturbing prior tasks", () => {
    const existing: TaskEntry = {
      id: "task-1",
      title: "Existing",
      status: "review",
      created: "2026-07-08T09:00:00.000Z",
      updated: "2026-07-08T09:00:00.000Z",
      prompt: "existing prompt",
    };
    const before = `${formatTask(existing)}\n`;
    const { content } = addBacklogTask(before, { title: "New one", prompt: "new prompt" }, 1720000000001);
    const parsed = parseTasksFile(content);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual(existing);
    expect(parsed[1].title).toBe("New one");
    expect(parsed[1].status).toBe("backlog");
  });

  it("includes model when provided, omits it when not", () => {
    const withModel = addBacklogTask("", { title: "T", prompt: "P", model: "claude-opus-4-6" }, 1);
    expect(withModel.entry.model).toBe("claude-opus-4-6");
    const withoutModel = addBacklogTask("", { title: "T", prompt: "P" }, 2);
    expect(withoutModel.entry.model).toBeUndefined();
  });

  it("exposes the canonical on-disk path for the tasks ledger", () => {
    expect(TASKS_PATH).toBe("_system/orchestration/tasks.md");
  });

  it("collapses a newline in the title so it can't corrupt the block's metadata lines", () => {
    const { content, entry } = addBacklogTask("", { title: "Line one\nLine two", prompt: "the prompt" }, 1);
    expect(entry.title).toBe("Line one Line two");
    const parsed = parseTasksFile(content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].status).toBe("backlog");
    expect(parsed[0].prompt).toBe("the prompt");
  });
});

describe("promoteToTaskCommandVisible", () => {
  it("is false when orchestrationEnabled is false (default) — command invisible", () => {
    expect(promoteToTaskCommandVisible({ orchestrationEnabled: false })).toBe(false);
  });

  it("is true when orchestrationEnabled is true", () => {
    expect(promoteToTaskCommandVisible({ orchestrationEnabled: true })).toBe(true);
  });
});
