import { describe, expect, it } from "vitest";
import { matchPermRule } from "../src/core/permissions";

describe("matchPermRule", () => {
  it("matches Bash rules on command-token boundaries", () => {
    expect(matchPermRule("Bash(rm)", "Bash", "rm -rf x")).toBe(true);
    expect(matchPermRule("Bash(rm)", "Bash", "rmdir x")).toBe(false);
  });

  it("keeps generated file rules exact", () => {
    expect(matchPermRule("Write(Active/Foo.md)", "Write", "Active/Foo.md")).toBe(true);
    expect(matchPermRule("Write(Active/Foo.md)", "Write", "Active/Foo.md.bak")).toBe(false);
  });

  it("requires an explicit wildcard for path-prefix rules", () => {
    expect(matchPermRule("Write(Active/Project/*)", "Write", "Active/Project/note.md")).toBe(true);
    expect(matchPermRule("Write(Active/Project/*)", "Write", "Active/Other/note.md")).toBe(false);
  });
});
