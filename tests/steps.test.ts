import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stepPlacement, stepsLabel, fileEditKey, isCommandTool, summarizeSteps } from "../src/core/steps";
import { milestoneLine } from "../src/core/steps";
import { firstErrorLine, isLargeContent } from "../src/core/steps";
import { isSubagentTool, shouldFoldStepsRun } from "../src/core/steps";

describe("isSubagentTool", () => {
  it("recognizes both the legacy Task name and the current Agent name", () => {
    // The CLI renamed the subagent-spawning tool Task → Agent; both must count
    // so nesting + running-agent tracking survive the rename.
    expect(isSubagentTool("Task")).toBe(true);
    expect(isSubagentTool("Agent")).toBe(true);
  });

  it("is false for ordinary tools", () => {
    expect(isSubagentTool("Bash")).toBe(false);
    expect(isSubagentTool("Read")).toBe(false);
    expect(isSubagentTool("mcp__obsidian__log_session")).toBe(false);
  });
});

describe("shouldFoldStepsRun", () => {
  it("folds when no subagent is running", () => {
    expect(shouldFoldStepsRun({ runningSubagents: 0, force: false, interrupted: false })).toBe(true);
  });

  it("stays live (in-progress) while a foreground subagent is still running", () => {
    // The header must not stamp a ✓ while a descendant subagent spins.
    expect(shouldFoldStepsRun({ runningSubagents: 1, force: false, interrupted: false })).toBe(false);
    expect(shouldFoldStepsRun({ runningSubagents: 3, force: false, interrupted: false })).toBe(false);
  });

  it("always folds at turn-end (force) or on interrupt, even with a subagent tracked", () => {
    expect(shouldFoldStepsRun({ runningSubagents: 2, force: true, interrupted: false })).toBe(true);
    expect(shouldFoldStepsRun({ runningSubagents: 2, force: false, interrupted: true })).toBe(true);
  });
});

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

describe("milestoneLine", () => {
  it("leads with the outcome, the way the settled turn reads it", () => {
    expect(milestoneLine({ tools: 9, files: 3, commands: 2 }, "41s")).toBe(
      "Edited 3 files, ran 2 commands · 41s",
    );
  });

  it("capitalizes whichever clause comes first", () => {
    expect(milestoneLine({ tools: 4, files: 0, commands: 2 }, "8s")).toBe("Ran 2 commands · 8s");
  });

  it("falls back to the tool count when a run changed and ran nothing", () => {
    expect(milestoneLine({ tools: 5, files: 0, commands: 0 }, "3s")).toBe("5 tools · 3s");
    expect(milestoneLine({ tools: 1, files: 0, commands: 0 }, "1s")).toBe("1 tool · 1s");
  });

  it("omits the duration when there is none (a restored turn)", () => {
    expect(milestoneLine({ tools: 2, files: 1, commands: 1 })).toBe("Edited 1 file, ran 1 command");
  });
});

describe("the settled turn folds by default", () => {
  // The fold is DOM, and this suite runs in `node`; what is pinned here is the
  // decision, read off `StepsRun.close()` — the header collapses the body and
  // becomes the milestone line, and the head stays a one-click toggle.
  const src = readFileSync(join(__dirname, "..", "src/ui/steps.ts"), "utf8");
  const close = /close\(scroller[\s\S]*?\n {2}\}/.exec(src)?.[0] ?? "";

  it("collapses the work section when the run closes", () => {
    expect(close).toMatch(/addClass\("is-collapsed"\)/);
  });

  it("stamps the milestone line on the folded header", () => {
    expect(src).toMatch(/milestoneLine\(/);
  });

  it("keeps the header a one-click toggle", () => {
    expect(src).toMatch(/clickable\(this\.headEl/);
    expect(src).toMatch(/toggleClass\("is-collapsed"/);
  });
});

describe("firstErrorLine", () => {
  it("returns the first non-empty line, trimmed", () => {
    expect(firstErrorLine("\n\n  Error: nope  \nstack\n")).toBe("Error: nope");
  });
  it("truncates to max with an ellipsis", () => {
    expect(firstErrorLine("x".repeat(200), 10)).toBe("xxxxxxxxxx…");
  });
  it("returns empty string for blank output", () => {
    expect(firstErrorLine("   \n  \n")).toBe("");
    expect(firstErrorLine("")).toBe("");
  });
});

describe("isLargeContent", () => {
  it("is true past the line threshold", () => {
    expect(isLargeContent("a\n".repeat(25), 20)).toBe(true);
  });
  it("is false at or under the threshold", () => {
    expect(isLargeContent("a\n".repeat(5), 20)).toBe(false);
    expect(isLargeContent("", 20)).toBe(false);
  });
});
