import { describe, it, expect } from "vitest";
import { hoistSlashCommand, mergeSlashEntries } from "./slash";

describe("mergeSlashEntries", () => {
  it("prints a skill once when both rosters know it", () => {
    // The shape that produced the duplicate: the CLI lists plugin skills in its
    // command roster too, so the same name arrives from both sides.
    const merged = mergeSlashEntries(
      ["mattpocock-skills:grilling", "mattpocock-skills:grill-me"],
      ["mattpocock-skills:grilling", "mattpocock-skills:grill-me"],
    );
    expect(merged).toEqual([
      { name: "mattpocock-skills:grilling", kind: "skill" },
      { name: "mattpocock-skills:grill-me", kind: "skill" },
    ]);
  });

  it("tags an overlapping name as a skill, not a command", () => {
    expect(mergeSlashEntries(["grilling"], ["grilling"])).toEqual([{ name: "grilling", kind: "skill" }]);
  });

  it("keeps command-only names, ahead of the skills", () => {
    expect(mergeSlashEntries(["goal", "compact"], ["research"])).toEqual([
      { name: "goal", kind: "command" },
      { name: "compact", kind: "command" },
      { name: "research", kind: "skill" },
    ]);
  });

  it("keeps skill-only names", () => {
    expect(mergeSlashEntries([], ["brainstorming"])).toEqual([{ name: "brainstorming", kind: "skill" }]);
  });

  it("collapses repeats inside one roster", () => {
    // .claude/skills is scanned as folders AND files: `foo/` + `foo.md` collide.
    expect(mergeSlashEntries([], ["foo", "foo"])).toEqual([{ name: "foo", kind: "skill" }]);
    expect(mergeSlashEntries(["bar", "bar"], [])).toEqual([{ name: "bar", kind: "command" }]);
  });

  it("never emits the same name twice", () => {
    const merged = mergeSlashEntries(["a", "b", "c", "b"], ["b", "c", "d", "d"]);
    const names = merged.map((e) => e.name);
    expect(names).toEqual([...new Set(names)]);
    expect(names).toEqual(["a", "b", "c", "d"]);
  });

  it("handles empty rosters", () => {
    expect(mergeSlashEntries([], [])).toEqual([]);
  });
});

describe("hoistSlashCommand", () => {
  const known = new Set(["goal", "grilling"]);

  it("hoists a command from its own line", () => {
    expect(hoistSlashCommand("organize my notes\n/goal", known)).toBe("/goal organize my notes");
  });

  it("leaves a command that already opens the message", () => {
    expect(hoistSlashCommand("/goal organize my notes", known)).toBe("/goal organize my notes");
  });

  it("ignores a command trailing prose on the same line", () => {
    // The shape typed in the composer screenshot: `/grilling` after a sentence
    // is not a standalone command line, so it stays literal text.
    const text = "Fammi domande precise, per capire cosa fare e perché. /grilling";
    expect(hoistSlashCommand(text, known)).toBe(text);
  });

  it("ignores unknown commands and URLs", () => {
    expect(hoistSlashCommand("text\n/unknowncmd", known)).toBe("text\n/unknowncmd");
    expect(hoistSlashCommand("see https://a.b/goal now", known)).toBe("see https://a.b/goal now");
  });
});
