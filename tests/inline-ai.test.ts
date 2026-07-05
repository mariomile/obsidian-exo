import { describe, it, expect } from "vitest";
import {
  wordDiff,
  computeHunks,
  applyDiff,
  hunkCount,
  hunkDocRanges,
  nextHunk,
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

  it("commits a partial accepted Set — mixed reconstruction (v2 subset commit)", () => {
    // Three independent changes; accept the 1st and 3rd, reject the 2nd.
    const original = "a b c d e f g";
    const revised = "a X c Y e Z g";
    const parts = computeHunks(original, revised);
    const hunks = parts.filter((p): p is Extract<DiffPart, { kind: "hunk" }> => p.kind === "hunk");
    expect(hunks).toHaveLength(3);
    const accepted = new Set<number>([0, 2]);
    expect(applyDiff(parts, (i) => accepted.has(i))).toBe("a X c d e Z g");
    // Empty Set === reject everything === original; full Set === revised.
    expect(applyDiff(parts, (i) => new Set<number>().has(i))).toBe(original);
    expect(applyDiff(parts, (i) => new Set<number>([0, 1, 2]).has(i))).toBe(revised);
  });
});

describe("hunkDocRanges", () => {
  const rangesOf = (from: number, original: string, revised: string) =>
    hunkDocRanges(from, computeHunks(original, revised));

  it("maps a pure insertion to a zero-width range at the insert point", () => {
    // "hello" -> "hello world": one hunk, before === "".
    const parts = computeHunks("hello", "hello world");
    const r = hunkDocRanges(0, parts);
    expect(r).toHaveLength(1);
    // The insertion lands after "hello" (context "hello" consumes 5 chars).
    expect(r[0].before.from).toBe(r[0].before.to);
    expect(r[0].before.to).toBe(r[0].at);
    expect(r[0].at).toBe(5);
  });

  it("maps a pure deletion to the removed span with `at` at its end", () => {
    // "hello cruel world" -> "hello world": " cruel" (or "cruel ") is removed.
    const parts = computeHunks("hello cruel world", "hello world");
    const r = hunkDocRanges(0, parts);
    expect(r.length).toBeGreaterThanOrEqual(1);
    const del = r[0];
    // The before-range is non-empty and `at` sits at its end.
    expect(del.before.to).toBeGreaterThan(del.before.from);
    expect(del.at).toBe(del.before.to);
    // The removed doc slice matches the hunk's `before` text.
    const hunk = parts.find((p) => p.kind === "hunk") as Extract<DiffPart, { kind: "hunk" }>;
    expect("hello cruel world".slice(del.before.from, del.before.to)).toBe(hunk.before);
  });

  it("maps a replacement to the replaced span", () => {
    const original = "the quick brown fox";
    const parts = computeHunks(original, "the slow brown fox");
    const r = hunkDocRanges(0, parts);
    expect(r).toHaveLength(1);
    const hunk = parts.find((p) => p.kind === "hunk") as Extract<DiffPart, { kind: "hunk" }>;
    expect(original.slice(r[0].before.from, r[0].before.to)).toBe(hunk.before);
    expect(r[0].at).toBe(r[0].before.to);
  });

  it("honors a non-zero `from` offset (selection not at doc start)", () => {
    const parts = computeHunks("hello", "hello world");
    const r = hunkDocRanges(100, parts);
    expect(r[0].at).toBe(105);
  });

  it("maps multiple hunks with context between them", () => {
    const original = "a b c d e";
    const revised = "a X c Y e";
    const parts = computeHunks(original, revised);
    const r = hunkDocRanges(0, parts);
    expect(r.map((x) => x.index)).toEqual([0, 1]);
    // Each before-range slices to its hunk's `before` in the original doc.
    for (const range of r) {
      const hunk = parts.find(
        (p) => p.kind === "hunk" && p.index === range.index
      ) as Extract<DiffPart, { kind: "hunk" }>;
      expect(original.slice(range.before.from, range.before.to)).toBe(hunk.before);
    }
    // Ranges are ordered and non-overlapping (second starts at/after first's end).
    expect(r[1].before.from).toBeGreaterThanOrEqual(r[0].at);
  });

  it("returns nothing when there are no hunks", () => {
    expect(rangesOf(0, "same text", "same text")).toEqual([]);
  });
});

describe("nextHunk", () => {
  const parts3 = computeHunks("a b c d e", "a X c Y e"); // 2 hunks (indices 0,1)

  it("returns 0 for empty parts regardless of direction", () => {
    const empty = computeHunks("same", "same");
    expect(nextHunk(empty, 0, 1)).toBe(0);
    expect(nextHunk(empty, 0, -1)).toBe(0);
  });

  it("clamps at a single hunk (no wrap)", () => {
    const one = computeHunks("the quick fox", "the slow fox"); // 1 hunk
    expect(nextHunk(one, 0, 1)).toBe(0);
    expect(nextHunk(one, 0, -1)).toBe(0);
  });

  it("steps forward and clamps at the last hunk", () => {
    expect(nextHunk(parts3, 0, 1)).toBe(1);
    expect(nextHunk(parts3, 1, 1)).toBe(1); // clamped, not wrapped to 0
  });

  it("steps backward and clamps at the first hunk", () => {
    expect(nextHunk(parts3, 1, -1)).toBe(0);
    expect(nextHunk(parts3, 0, -1)).toBe(0); // clamped, not wrapped to last
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
