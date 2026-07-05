import { describe, it, expect } from "vitest";
import {
  wordDiff,
  computeHunks,
  applyDiff,
  hunkCount,
  buildEditPrompt,
  buildContinuePrompt,
  type DiffPart,
} from "../src/core/inline-ai";

describe("computeHunks", () => {
  it("returns a single context part and no hunks for identical text", () => {
    const parts = computeHunks("hello world", "hello world");
    expect(hunkCount(parts)).toBe(0);
    expect(parts.every((p) => p.kind === "context")).toBe(true);
  });

  it("captures a single-word replacement as one hunk", () => {
    const parts = computeHunks("the quick brown fox", "the slow brown fox");
    const hunks = parts.filter((p): p is Extract<DiffPart, { kind: "hunk" }> => p.kind === "hunk");
    expect(hunks).toHaveLength(1);
    expect(hunks[0].before).toContain("quick");
    expect(hunks[0].after).toContain("slow");
    expect(hunks[0].index).toBe(0);
  });

  it("models a pure insertion as a hunk with empty before", () => {
    const parts = computeHunks("hello", "hello world");
    const hunks = parts.filter((p): p is Extract<DiffPart, { kind: "hunk" }> => p.kind === "hunk");
    expect(hunks).toHaveLength(1);
    expect(hunks[0].before).toBe("");
    expect(hunks[0].after).toContain("world");
  });

  it("models a pure deletion as a hunk with empty after", () => {
    const parts = computeHunks("hello cruel world", "hello world");
    const hunks = parts.filter((p): p is Extract<DiffPart, { kind: "hunk" }> => p.kind === "hunk");
    expect(hunks.length).toBeGreaterThanOrEqual(1);
    expect(hunks.some((h) => h.before.includes("cruel") && h.after === "")).toBe(true);
  });

  it("assigns stable increasing indices across multiple hunks", () => {
    const parts = computeHunks("a b c d e", "a X c Y e");
    const hunks = parts.filter((p): p is Extract<DiffPart, { kind: "hunk" }> => p.kind === "hunk");
    expect(hunks.length).toBe(2);
    expect(hunks.map((h) => h.index)).toEqual([0, 1]);
  });
});

describe("applyDiff", () => {
  it("reconstructs the revised text when all hunks are accepted", () => {
    const original = "the quick brown fox jumps";
    const revised = "the slow brown cat leaps";
    const parts = computeHunks(original, revised);
    expect(applyDiff(parts, () => true)).toBe(revised);
  });

  it("reconstructs the original text when all hunks are rejected", () => {
    const original = "the quick brown fox jumps";
    const revised = "the slow brown cat leaps";
    const parts = computeHunks(original, revised);
    expect(applyDiff(parts, () => false)).toBe(original);
  });

  it("mixes per-hunk decisions (seam for per-hunk accept)", () => {
    const original = "a b c d e";
    const revised = "a X c Y e";
    const parts = computeHunks(original, revised);
    // Accept only the first hunk (b -> X), reject the second (d -> Y).
    const out = applyDiff(parts, (i) => i === 0);
    expect(out).toBe("a X c d e");
  });

  it("round-trips insertions and deletions", () => {
    const original = "hello world";
    const revised = "hello there brave world";
    const parts = computeHunks(original, revised);
    expect(applyDiff(parts, () => true)).toBe(revised);
    expect(applyDiff(parts, () => false)).toBe(original);
  });
});

describe("wordDiff (moved to core)", () => {
  it("marks changed words and preserves shared ones", () => {
    const segs = wordDiff("one two three", "one four three");
    expect(segs.some((s) => s.type === "del" && s.text === "two")).toBe(true);
    expect(segs.some((s) => s.type === "add" && s.text === "four")).toBe(true);
    expect(segs.some((s) => s.type === "same" && s.text.includes("one"))).toBe(true);
  });
});

describe("prompt builders", () => {
  it("buildEditPrompt embeds the instruction and text and forbids decoration", () => {
    const p = buildEditPrompt("make it terser", "The cat sat on the mat.");
    expect(p).toContain("make it terser");
    expect(p).toContain("The cat sat on the mat.");
    expect(p).toContain("ONLY");
    expect(p).toContain("no code fences");
  });

  it("buildContinuePrompt embeds the preceding text and asks for only new text", () => {
    const p = buildContinuePrompt("Once upon a time");
    expect(p).toContain("Once upon a time");
    expect(p.toLowerCase()).toContain("continue");
    expect(p).toContain("ONLY");
    expect(p).toContain("no repetition");
  });
});
