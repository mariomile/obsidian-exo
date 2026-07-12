import { describe, it, expect } from "vitest";
import { parseAcToken, queryWords, matchesWords } from "../src/core/ac-token";

const SPECS = [
  { trigger: "/" },
  { trigger: "$" },
  { trigger: "@", allowSpaces: true },
];

describe("parseAcToken", () => {
  it("matches a word-bound trigger at line start", () => {
    expect(parseAcToken("/comp", SPECS)).toEqual({ trigger: "/", query: "comp", start: 0 });
  });

  it("matches a trigger after whitespace", () => {
    expect(parseAcToken("run /comp", SPECS)).toEqual({ trigger: "/", query: "comp", start: 4 });
  });

  it("does not match a trigger glued to a word", () => {
    expect(parseAcToken("mario@mail", SPECS)).toBeNull();
  });

  it("word-bound trigger dies at the first space", () => {
    expect(parseAcToken("/comp act", SPECS)).toBeNull();
  });

  it("space-allowing trigger keeps matching past spaces", () => {
    expect(parseAcToken("@mario mil", SPECS)).toEqual({ trigger: "@", query: "mario mil", start: 0 });
  });

  it("space-allowing query stops at a newline", () => {
    expect(parseAcToken("@mario\nhello", SPECS)).toBeNull();
  });

  it("the last @ on the line wins", () => {
    expect(parseAcToken("@one two @three f", SPECS)).toEqual({
      trigger: "@",
      query: "three f",
      start: 9,
    });
  });

  it("a path slash inside an @ query does not activate the / trigger", () => {
    expect(parseAcToken("@Atlas/People", SPECS)).toEqual({
      trigger: "@",
      query: "Atlas/People",
      start: 0,
    });
  });

  it("a later word-bound trigger beats an earlier space-allowing one", () => {
    expect(parseAcToken("@notes /comp", SPECS)).toEqual({ trigger: "/", query: "comp", start: 7 });
  });

  it("returns null when no trigger is present", () => {
    expect(parseAcToken("just typing", SPECS)).toBeNull();
  });

  it("empty query right after the trigger", () => {
    expect(parseAcToken("@", SPECS)).toEqual({ trigger: "@", query: "", start: 0 });
  });
});

describe("queryWords / matchesWords", () => {
  it("splits on whitespace and lowercases", () => {
    expect(queryWords("  Mario   Mil ")).toEqual(["mario", "mil"]);
  });

  it("empty query matches everything", () => {
    expect(matchesWords("Atlas/People/Mario Miletta.md", [])).toBe(true);
  });

  it("AND-matches all words regardless of order", () => {
    const words = queryWords("miletta mario");
    expect(matchesWords("Atlas/People/Mario Miletta.md", words)).toBe(true);
  });

  it("fails when one word is missing", () => {
    const words = queryWords("mario rossi");
    expect(matchesWords("Atlas/People/Mario Miletta.md", words)).toBe(false);
  });

  it("matches across path segments", () => {
    const words = queryWords("people mario");
    expect(matchesWords("Atlas/People/Mario Miletta.md", words)).toBe(true);
  });
});
