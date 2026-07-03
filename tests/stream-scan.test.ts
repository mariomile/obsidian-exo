import { describe, it, expect } from "vitest";
import { advanceBoundary, type ScanState } from "../src/core/stream-scan";

const fresh = (curRaw: string): ScanState => ({
  curRaw,
  scanPos: 0,
  fenceOpen: false,
  lastBoundary: 0,
});

describe("advanceBoundary", () => {
  it("finds a boundary at a blank line outside a fence", () => {
    const s = fresh("para one\n\npara two\n");
    const b = advanceBoundary(s);
    expect(b).toBe("para one\n\n".length); // just after the blank line
  });

  it("does NOT emit a boundary inside a ``` fence", () => {
    const s = fresh("```\ncode\n\nstill code\n");
    const b = advanceBoundary(s);
    // The blank line sits inside the open fence → no safe boundary.
    expect(b).toBe(0);
    expect(s.fenceOpen).toBe(true);
  });

  it("re-enables boundaries after the fence closes", () => {
    const s = fresh("```\ncode\n```\n\nafter\n");
    const b = advanceBoundary(s);
    expect(s.fenceOpen).toBe(false);
    // Boundary is the blank line AFTER the closing fence.
    expect(b).toBe("```\ncode\n```\n\n".length);
  });

  it("does not consume a partial trailing line (scanPos only past newline-terminated lines)", () => {
    const s = fresh("done line\npartial without newline");
    advanceBoundary(s);
    // scanPos advanced past "done line\n" only; the partial tail waits for its \n.
    expect(s.scanPos).toBe("done line\n".length);
  });

  it("is cumulative across incremental calls (O(delta) contract)", () => {
    // First tick: only the first line has arrived (no newline yet on the tail).
    const s = fresh("first\n\nsecond");
    const b1 = advanceBoundary(s);
    expect(b1).toBe("first\n\n".length);
    const posAfterFirst = s.scanPos;

    // More text streams in; the SAME state object continues from prior scanPos.
    s.curRaw += "\n\nthird\n";
    const b2 = advanceBoundary(s);
    // The second call must not rescan from 0 — it continues past posAfterFirst.
    expect(s.scanPos).toBeGreaterThan(posAfterFirst);
    // New boundary is after "second\n\n".
    expect(b2).toBe("first\n\nsecond\n\n".length);
  });

  it("treats ~~~ fences the same as ``` fences", () => {
    const s = fresh("~~~\ncode\n\nx\n");
    expect(advanceBoundary(s)).toBe(0);
    expect(s.fenceOpen).toBe(true);
  });
});
