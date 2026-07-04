import { describe, it, expect } from "vitest";
import { sanitizeTitle } from "../src/core/title";

describe("sanitizeTitle", () => {
  it("returns a clean plain title unchanged", () => {
    expect(sanitizeTitle("Refactor the auth flow")).toBe("Refactor the auth flow");
  });

  it("strips surrounding quotes and backticks (including nested)", () => {
    expect(sanitizeTitle('"Refactor the auth flow"')).toBe("Refactor the auth flow");
    expect(sanitizeTitle("`Refactor the auth flow`")).toBe("Refactor the auth flow");
    expect(sanitizeTitle('“Refactor the auth flow”')).toBe("Refactor the auth flow");
    expect(sanitizeTitle('"`Refactor the auth flow`"')).toBe("Refactor the auth flow");
  });

  it("drops a leading Title:/Chat:/Topic: preamble", () => {
    expect(sanitizeTitle("Title: Refactor the auth flow")).toBe("Refactor the auth flow");
    expect(sanitizeTitle("Chat - Refactor the auth flow")).toBe("Refactor the auth flow");
  });

  it("strips trailing punctuation", () => {
    expect(sanitizeTitle("Refactor the auth flow.")).toBe("Refactor the auth flow");
    expect(sanitizeTitle("Refactor the auth flow!!!")).toBe("Refactor the auth flow");
    expect(sanitizeTitle("What broke the build?")).toBe("What broke the build");
  });

  it("keeps only the first non-empty line", () => {
    expect(sanitizeTitle("\n\nRefactor the auth flow\nHere is why: ...")).toBe("Refactor the auth flow");
  });

  it("collapses internal whitespace", () => {
    expect(sanitizeTitle("Refactor   the\tauth  flow")).toBe("Refactor the auth flow");
  });

  it("caps length", () => {
    const long = "word ".repeat(40).trim();
    expect(sanitizeTitle(long, 20).length).toBeLessThanOrEqual(20);
  });

  it("returns empty string for empty or whitespace input", () => {
    expect(sanitizeTitle("")).toBe("");
    expect(sanitizeTitle("   \n  ")).toBe("");
    expect(sanitizeTitle('""')).toBe("");
  });
});
