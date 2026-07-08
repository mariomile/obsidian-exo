import { describe, it, expect } from "vitest";
import {
  formatTask,
  parseTasksFile,
  parseTasksFileWithWarnings,
  serializeTasks,
  addBacklogTask,
  applyTaskPatch,
  applyTaskMove,
  applyTaskArchive,
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

describe("serializeTasks / parseTasksFile round-trip", () => {
  it("round-trips a list of entries through serializeTasks -> parseTasksFile", () => {
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
    const content = serializeTasks([a, b]);
    expect(parseTasksFile(content)).toEqual([a, b]);
  });

  it("returns an empty string for an empty list", () => {
    expect(serializeTasks([])).toBe("");
  });
});

describe("parseTasksFileWithWarnings", () => {
  it("returns no warnings for a well-formed file", () => {
    const { tasks, warnings } = parseTasksFileWithWarnings(
      [
        "## task-1",
        "- title: Fine",
        "- status: backlog",
        "- created: 2026-07-08T10:00:00.000Z",
        "- updated: 2026-07-08T10:00:00.000Z",
        "",
        "prompt text",
      ].join("\n")
    );
    expect(tasks).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("returns an empty task list and no warnings for empty content", () => {
    const { tasks, warnings } = parseTasksFileWithWarnings("");
    expect(tasks).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("warns (never throws) when a block is missing its title", () => {
    const content = [
      "## task-1",
      "- status: backlog",
      "- created: 2026-07-08T10:00:00.000Z",
      "- updated: 2026-07-08T10:00:00.000Z",
      "",
      "prompt text",
    ].join("\n");
    expect(() => parseTasksFileWithWarnings(content)).not.toThrow();
    const { tasks, warnings } = parseTasksFileWithWarnings(content);
    expect(tasks).toHaveLength(1);
    expect(warnings).toEqual([expect.stringContaining("task-1")]);
  });

  it("warns when a status value is unrecognized (tolerantly coerced to backlog)", () => {
    const content = [
      "## task-999",
      "- title: Weird status",
      "- status: not-a-real-status",
      "- created: 2026-07-08T10:00:00.000Z",
      "- updated: 2026-07-08T10:00:00.000Z",
      "",
      "prompt text",
    ].join("\n");
    const { tasks, warnings } = parseTasksFileWithWarnings(content);
    expect(tasks[0].status).toBe("backlog");
    expect(warnings).toEqual([expect.stringContaining("task-999")]);
  });

  it("warns when created/updated timestamps are missing", () => {
    const content = ["## task-2", "- title: No dates", "", "prompt text"].join("\n");
    const { tasks, warnings } = parseTasksFileWithWarnings(content);
    expect(tasks).toHaveLength(1);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("applyTaskPatch", () => {
  const base: TaskEntry = {
    id: "task-1",
    title: "Original",
    status: "backlog",
    created: "2026-07-08T09:00:00.000Z",
    updated: "2026-07-08T09:00:00.000Z",
    prompt: "original prompt",
  };

  it("patches title and bumps updated, leaving other entries untouched", () => {
    const other: TaskEntry = { ...base, id: "task-2", title: "Other" };
    const next = applyTaskPatch([base, other], "task-1", { title: "Renamed" }, 1720000005000);
    expect(next[0].title).toBe("Renamed");
    expect(next[0].updated).toBe(new Date(1720000005000).toISOString());
    expect(next[1]).toEqual(other);
  });

  it("never mutates status via patch alone if not provided", () => {
    const next = applyTaskPatch([base], "task-1", { prompt: "new prompt" }, 1720000005000);
    expect(next[0].status).toBe("backlog");
    expect(next[0].prompt).toBe("new prompt");
  });

  it("throws when the id doesn't exist (never silently no-ops)", () => {
    expect(() => applyTaskPatch([base], "task-missing", { title: "x" })).toThrow();
  });
});

describe("applyTaskMove", () => {
  const base: TaskEntry = {
    id: "task-1",
    title: "Original",
    status: "backlog",
    created: "2026-07-08T09:00:00.000Z",
    updated: "2026-07-08T09:00:00.000Z",
    prompt: "original prompt",
  };

  it("updates status and order, bumps updated", () => {
    const next = applyTaskMove([base], "task-1", "queued", 2, 1720000005000);
    expect(next[0].status).toBe("queued");
    expect(next[0].order).toBe(2);
    expect(next[0].updated).toBe(new Date(1720000005000).toISOString());
  });

  it("throws when the id doesn't exist", () => {
    expect(() => applyTaskMove([base], "task-missing", "done", 0)).toThrow();
  });
});

describe("applyTaskArchive", () => {
  const base: TaskEntry = {
    id: "task-1",
    title: "Original",
    status: "review",
    created: "2026-07-08T09:00:00.000Z",
    updated: "2026-07-08T09:00:00.000Z",
    prompt: "original prompt",
  };

  it("sets status to archived and bumps updated, keeps the block (title/prompt intact)", () => {
    const next = applyTaskArchive([base], "task-1", 1720000005000);
    expect(next[0].status).toBe("archived");
    expect(next[0].title).toBe("Original");
    expect(next[0].prompt).toBe("original prompt");
    expect(next[0].updated).toBe(new Date(1720000005000).toISOString());
  });

  it("never removes the entry from the list — length unchanged", () => {
    const other: TaskEntry = { ...base, id: "task-2" };
    const next = applyTaskArchive([base, other], "task-1");
    expect(next).toHaveLength(2);
  });

  it("throws when the id doesn't exist", () => {
    expect(() => applyTaskArchive([base], "task-missing")).toThrow();
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
