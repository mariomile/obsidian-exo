import { describe, it, expect } from "vitest";
import { planInputParts, planRecapLabel, planStateText } from "../src/core/plan";

describe("planInputParts", () => {
  it("extracts inline plan markdown + file path (verified ExitPlanMode shape)", () => {
    const input = {
      plan: "# Plan\n\nDo the thing.\n",
      planFilePath: "/Users/x/.claude/plans/plan-abc.md",
    };
    expect(planInputParts(input)).toEqual({
      md: "# Plan\n\nDo the thing.\n",
      filePath: "/Users/x/.claude/plans/plan-abc.md",
    });
  });
  it("returns md null when only a file path is present", () => {
    const parts = planInputParts({ planFilePath: "/tmp/p.md" });
    expect(parts.md).toBeNull();
    expect(parts.filePath).toBe("/tmp/p.md");
  });
  it("tolerates alternate field names", () => {
    expect(planInputParts({ markdown: "hi", planPath: "/x" })).toEqual({ md: "hi", filePath: "/x" });
  });
  it("treats blank / missing / non-object as empty", () => {
    expect(planInputParts({ plan: "   " })).toEqual({ md: null, filePath: null });
    expect(planInputParts(null)).toEqual({ md: null, filePath: null });
    expect(planInputParts("nope")).toEqual({ md: null, filePath: null });
  });
});

describe("planRecapLabel", () => {
  it("summarizes the three states", () => {
    expect(planRecapLabel(true)).toBe("[plan: approved]");
    expect(planRecapLabel(false)).toBe("[plan: revised]");
    expect(planRecapLabel(null)).toBe("[plan: pending]");
  });
});

describe("planStateText", () => {
  it("labels approved / revised / proposed", () => {
    expect(planStateText(true)).toBe("Plan approved");
    expect(planStateText(true, true)).toBe("Plan approved — building");
    expect(planStateText(false)).toBe("Revision requested");
    expect(planStateText(null)).toBe("Plan proposed");
  });
});
