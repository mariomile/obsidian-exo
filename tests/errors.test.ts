import { describe, it, expect } from "vitest";
import { describeCliFailure } from "../src/core/errors";

describe("describeCliFailure", () => {
  it("maps error_during_execution / EDE diagnostics to a transient-crash message + hint", () => {
    for (const raw of [
      "error_during_execution",
      "Claude ended: error_during_execution",
      "Some noise [EDE_DIAGNOSTIC] more noise",
    ]) {
      const r = describeCliFailure(raw);
      expect(r?.message).toMatch(/crashed mid-turn/i);
      expect(r?.hint).toMatch(/update the CLI/i);
    }
  });

  it("maps a process exit to a transient-crash message + hint", () => {
    const r = describeCliFailure("process exited with code 1");
    expect(r?.message).toMatch(/exited unexpectedly/i);
    expect(r?.hint).toMatch(/update the CLI/i);
  });

  it("maps ENOENT / not-found to a binary-path message", () => {
    for (const raw of ["spawn claude ENOENT", "claude: command not found", "claude not found"]) {
      const r = describeCliFailure(raw);
      expect(r?.message).toMatch(/not found — set the binary path/i);
      expect(r?.hint).toBeUndefined();
    }
  });

  it("maps auth failures to a login message", () => {
    for (const raw of [
      "You are not logged in",
      "Invalid API key",
      "Please run /login to continue",
      "Error: unauthorized",
    ]) {
      const r = describeCliFailure(raw);
      expect(r?.message).toMatch(/isn't authenticated/i);
    }
  });

  it("prefers the auth message when a crash string also mentions auth", () => {
    // "not logged in" must win over "process exited".
    const r = describeCliFailure("process exited with code 1: not logged in");
    expect(r?.message).toMatch(/isn't authenticated/i);
  });

  it("is case-insensitive", () => {
    expect(describeCliFailure("ERROR_DURING_EXECUTION")?.message).toMatch(/crashed mid-turn/i);
  });

  it("returns null for unknown / benign strings", () => {
    for (const raw of [
      "",
      "API error 400: bad request",
      "rate limit exceeded",
      "the model produced an odd answer",
    ]) {
      expect(describeCliFailure(raw)).toBeNull();
    }
  });
});
