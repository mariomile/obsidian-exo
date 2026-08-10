import { describe, it, expect } from "vitest";
import {
  outcomeFromState,
  buildExcerpt,
  formatReportsForParent,
  EXCERPT_CAP,
  type ChildReport,
} from "../src/core/child-reports";

describe("outcomeFromState", () => {
  it("maps a clean turn-end to done", () => {
    expect(outcomeFromState("turn-end")).toBe("done");
  });

  it("maps needs-input with an error reason to error, and otherwise to blocked", () => {
    expect(outcomeFromState("needs-input", "error")).toBe("error");
    expect(outcomeFromState("needs-input", "perm")).toBe("blocked");
    expect(outcomeFromState("needs-input", "ask")).toBe("blocked");
  });

  it("maps needs-input with no reason at all to blocked, not error", () => {
    expect(outcomeFromState("needs-input")).toBe("blocked");
  });

  it("maps stopped to stopped", () => {
    expect(outcomeFromState("stopped", "stopped")).toBe("stopped");
  });

  it("maps a direct error state to error", () => {
    expect(outcomeFromState("error")).toBe("error");
  });

  it("returns null for turn-start, which is not an outcome", () => {
    expect(outcomeFromState("turn-start")).toBeNull();
  });
});

describe("buildExcerpt", () => {
  it("returns short text unchanged", () => {
    expect(buildExcerpt("all done")).toBe("all done");
  });

  it("caps long text and marks the truncation", () => {
    const out = buildExcerpt("x".repeat(EXCERPT_CAP + 500));
    expect(out.length).toBeLessThanOrEqual(EXCERPT_CAP + 20);
    expect(out).toContain("truncated");
  });

  it("does not truncate or mark text exactly at the cap", () => {
    const exact = "y".repeat(EXCERPT_CAP);
    const out = buildExcerpt(exact);
    expect(out).toBe(exact);
    expect(out).not.toContain("truncated");
  });

  it("truncates text one character past the cap", () => {
    const overByOne = "z".repeat(EXCERPT_CAP + 1);
    const out = buildExcerpt(overByOne);
    expect(out).toContain("truncated");
    expect(out.startsWith("z".repeat(EXCERPT_CAP))).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    expect(buildExcerpt("  hi\n\n")).toBe("hi");
  });

  it("trims before capping, so cap boundary is measured on trimmed text", () => {
    const padded = `  ${"a".repeat(EXCERPT_CAP)}  `;
    const out = buildExcerpt(padded);
    expect(out).toBe("a".repeat(EXCERPT_CAP));
    expect(out).not.toContain("truncated");
  });

  it("returns empty string unchanged", () => {
    expect(buildExcerpt("")).toBe("");
  });
});

describe("formatReportsForParent", () => {
  const base: ChildReport = {
    taskId: "task-1",
    childConvoId: "convo-b",
    title: "Research pricing",
    outcome: "done",
    excerpt: "Found three competitors.",
    at: 1720000000000,
  };

  it("names the child, its outcome and its excerpt", () => {
    const out = formatReportsForParent([base]);
    expect(out).toContain("Research pricing");
    expect(out).toContain("done");
    expect(out).toContain("Found three competitors.");
  });

  it("batches several reports into one message", () => {
    const out = formatReportsForParent([base, { ...base, taskId: "task-2", title: "Draft post" }]);
    expect(out).toContain("Research pricing");
    expect(out).toContain("Draft post");
  });

  it("carries anti-hallucination guidance for stopped children", () => {
    const out = formatReportsForParent([{ ...base, outcome: "stopped" }]);
    expect(out.toLowerCase()).toContain("do not resume");
  });

  it("does not carry the stopped guidance when nothing was stopped", () => {
    const out = formatReportsForParent([base]);
    expect(out.toLowerCase()).not.toContain("do not resume");
  });

  it("distinguishes blocked from error children in the rendered text", () => {
    const blocked = formatReportsForParent([{ ...base, outcome: "blocked" }]);
    const error = formatReportsForParent([{ ...base, outcome: "error" }]);
    expect(blocked).not.toBe(error);
    // A reviewer skimming this must be able to tell "waiting" from "failed"
    // without cross-referencing anything else.
    expect(blocked.toLowerCase()).not.toContain("fail");
    expect(error.toLowerCase()).toMatch(/fail|error/);
  });

  it("reads as prose, not as a tool result: no JSON braces or key:value dumps", () => {
    const out = formatReportsForParent([base]);
    expect(out).not.toContain("{");
    expect(out).not.toContain("}");
    expect(out).not.toMatch(/"taskId"/);
  });

  it("returns an empty string for no reports", () => {
    expect(formatReportsForParent([])).toBe("");
  });
});
