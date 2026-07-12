import { describe, it, expect } from "vitest";
import { stepPlacement, stepsLabel } from "../src/core/steps";

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
