import { describe, it, expect } from "vitest";
import { stepPlacement, stepsLabel } from "../src/core/steps";

describe("stepPlacement", () => {
  it("puts generic tools in the timeline", () => {
    expect(stepPlacement("Bash", { command: "ls" }, null)).toBe("timeline");
    expect(stepPlacement("Grep", { pattern: "x" }, null)).toBe("timeline");
    expect(stepPlacement("WebSearch", { query: "x" }, null)).toBe("timeline");
    expect(stepPlacement("Task", { prompt: "x" }, null)).toBe("timeline");
  });

  it("keeps note-touching calls flat (they dissolve into the touched footer)", () => {
    expect(stepPlacement("Read", { file_path: "/v/n.md" }, "/v/n.md")).toBe("flat");
    expect(stepPlacement("Edit", { file_path: "/v/n.md" }, "/v/n.md")).toBe("flat");
  });

  it("keeps background Bash flat (live status badge)", () => {
    expect(stepPlacement("Bash", { command: "sleep 99", run_in_background: true }, null)).toBe("flat");
  });

  it("keeps BashOutput/KillShell flat (they link to background tasks)", () => {
    expect(stepPlacement("BashOutput", { bash_id: "b1" }, null)).toBe("flat");
    expect(stepPlacement("KillShell", { shell_id: "s1" }, null)).toBe("flat");
  });

  it("tolerates non-object input", () => {
    expect(stepPlacement("Bash", undefined, null)).toBe("timeline");
    expect(stepPlacement("Bash", "raw", null)).toBe("timeline");
  });
});

describe("stepsLabel", () => {
  it("pluralizes", () => {
    expect(stepsLabel(1)).toBe("1 step");
    expect(stepsLabel(4)).toBe("4 steps");
  });
});
