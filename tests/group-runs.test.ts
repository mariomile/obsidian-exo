import { describe, expect, it } from "vitest";
import { groupRuns } from "../src/core/group-runs";

const T = true;
const F = false;

describe("groupRuns", () => {
  it("finds a run of exactly min length", () => {
    expect(groupRuns([T, T, T], 3)).toEqual([[0, 2]]);
  });

  it("ignores runs shorter than min", () => {
    expect(groupRuns([T, T, F, T], 3)).toEqual([]);
  });

  it("finds a run ending at the sequence end", () => {
    expect(groupRuns([F, T, T, T, T], 3)).toEqual([[1, 4]]);
  });

  it("finds multiple separate runs", () => {
    expect(groupRuns([T, T, T, F, T, T, T, T], 3)).toEqual([
      [0, 2],
      [4, 7],
    ]);
  });

  it("returns nothing for an empty sequence", () => {
    expect(groupRuns([], 3)).toEqual([]);
  });

  it("returns nothing when no entries are set", () => {
    expect(groupRuns([F, F, F], 3)).toEqual([]);
  });

  it("the real 03-07 case: 4 consecutive tool rows collapse", () => {
    // text, tool, tool, tool, tool, text
    expect(groupRuns([F, T, T, T, T, F], 3)).toEqual([[1, 4]]);
  });
});
