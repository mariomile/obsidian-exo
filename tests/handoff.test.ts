import { describe, it, expect } from "vitest";
import { handoffPrefix } from "../src/core/handoff";

describe("handoffPrefix", () => {
  it("maps sonar-intent to a directive that names both sonar tools", () => {
    const p = handoffPrefix("sonar-intent");
    expect(p).toBeTruthy();
    expect(p).toContain("list_sonar_actions");
    expect(p).toContain("run_sonar_action");
    expect(p).toMatch(/destructive/i);
  });

  it("returns undefined for unknown or absent sources", () => {
    expect(handoffPrefix(undefined)).toBeUndefined();
    expect(handoffPrefix("")).toBeUndefined();
    expect(handoffPrefix("some-future-source")).toBeUndefined();
  });
});
