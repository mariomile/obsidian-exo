import { describe, it, expect } from "vitest";
import { stepPlacement, stepsLabel, fileEditKey, isCommandTool, summarizeSteps } from "../src/core/steps";

describe("stepPlacement", () => {
  it("puts generic tools in the timeline", () => {
    expect(stepPlacement("Bash", { command: "ls" })).toBe("timeline");
    expect(stepPlacement("Grep", { pattern: "x" })).toBe("timeline");
    expect(stepPlacement("WebSearch", { query: "x" })).toBe("timeline");
    expect(stepPlacement("Task", { prompt: "x" })).toBe("timeline");
  });

  it("puts note-touching calls in the timeline too (they dissolve without breaking the run)", () => {
    expect(stepPlacement("Read", { file_path: "/v/n.md" })).toBe("timeline");
    expect(stepPlacement("Edit", { file_path: "/v/n.md" })).toBe("timeline");
    expect(stepPlacement("mcp__obsidian__read_note", { target: "n" })).toBe("timeline");
  });

  it("keeps background Bash flat (live status badge)", () => {
    expect(stepPlacement("Bash", { command: "sleep 99", run_in_background: true })).toBe("flat");
  });

  it("keeps BashOutput/KillShell flat (they link to background tasks)", () => {
    expect(stepPlacement("BashOutput", { bash_id: "b1" })).toBe("flat");
    expect(stepPlacement("KillShell", { shell_id: "s1" })).toBe("flat");
  });

  it("tolerates non-object input", () => {
    expect(stepPlacement("Bash", undefined)).toBe("timeline");
    expect(stepPlacement("Bash", "raw")).toBe("timeline");
  });
});

describe("stepsLabel", () => {
  it("pluralizes", () => {
    expect(stepsLabel(1)).toBe("1 step");
    expect(stepsLabel(4)).toBe("4 steps");
  });
});

describe("fileEditKey", () => {
  it("keys Write/Edit/MultiEdit calls by file_path", () => {
    expect(fileEditKey("Write", { file_path: "/v/a.md" })).toBe("/v/a.md");
    expect(fileEditKey("Edit", { file_path: "/v/b.md" })).toBe("/v/b.md");
    expect(fileEditKey("MultiEdit", { file_path: "/v/c.md" })).toBe("/v/c.md");
  });

  it("keys NotebookEdit by notebook_path", () => {
    expect(fileEditKey("NotebookEdit", { notebook_path: "/v/n.ipynb" })).toBe("/v/n.ipynb");
  });

  it("returns null for non-edit tools", () => {
    expect(fileEditKey("Read", { file_path: "/v/a.md" })).toBeNull();
    expect(fileEditKey("Bash", { command: "ls" })).toBeNull();
  });

  it("returns null when the path is missing or not a string", () => {
    expect(fileEditKey("Write", {})).toBeNull();
    expect(fileEditKey("Write", { file_path: 5 })).toBeNull();
    expect(fileEditKey("Write", undefined)).toBeNull();
  });

  it("keys native mcp__obsidian__* write tools by target/path", () => {
    expect(fileEditKey("mcp__obsidian__edit_note", { target: "X.md" })).toBe("X.md");
    expect(fileEditKey("mcp__obsidian__create_note", { path: "Y.md" })).toBe("Y.md");
  });

  it("returns null for the native read-only mcp__obsidian__read_note tool", () => {
    expect(fileEditKey("mcp__obsidian__read_note", { target: "Z.md" })).toBeNull();
  });
});

describe("isCommandTool", () => {
  it("is true only for Bash", () => {
    expect(isCommandTool("Bash")).toBe(true);
    expect(isCommandTool("BashOutput")).toBe(false);
    expect(isCommandTool("Read")).toBe(false);
  });
});

describe("summarizeSteps", () => {
  it("always shows the tool count", () => {
    expect(summarizeSteps(1, 0, 0)).toBe("1 tool");
    expect(summarizeSteps(3, 0, 0)).toBe("3 tools");
  });

  it("omits a clause when its count is zero", () => {
    expect(summarizeSteps(2, 0, 1)).toBe("2 tools · 1 command");
    expect(summarizeSteps(2, 1, 0)).toBe("2 tools · 1 file edited");
  });

  it("pluralizes files and commands", () => {
    expect(summarizeSteps(18, 5, 2)).toBe("18 tools · 5 files edited · 2 commands");
  });
});
