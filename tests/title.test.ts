import { describe, it, expect } from "vitest";
import { sanitizeTitle, classifyTitleOutcome } from "../src/core/title";

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

describe("classifyTitleOutcome", () => {
  it("reports a real title as ok", () => {
    expect(classifyTitleOutcome({ threw: false, timedOut: false, callerAborted: false, title: "Refactor the auth flow" })).toBe(
      "ok"
    );
  });

  it("distinguishes a reply that sanitized to nothing from a real success", () => {
    expect(classifyTitleOutcome({ threw: false, timedOut: false, callerAborted: false, title: "" })).toBe("ok-empty");
  });

  it("reports the internal 15s ceiling firing as timeout, even if the caller signal also ends up aborted", () => {
    // ctrl.abort() inside the timer callback never touches the caller's own
    // signal, but the classifier still must not let a coincidentally-aborted
    // caller signal mask a genuine timeout — timedOut wins.
    expect(classifyTitleOutcome({ threw: true, timedOut: true, callerAborted: true, title: "" })).toBe("timeout");
    expect(classifyTitleOutcome({ threw: true, timedOut: true, callerAborted: false, title: "" })).toBe("timeout");
  });

  it("reports the caller's own signal aborting (not the internal timer) as caller-abort", () => {
    expect(classifyTitleOutcome({ threw: true, timedOut: false, callerAborted: true, title: "" })).toBe("caller-abort");
  });

  it("reports any other thrown failure (e.g. CLI missing) as error", () => {
    expect(classifyTitleOutcome({ threw: true, timedOut: false, callerAborted: false, title: "" })).toBe("error");
  });
});
