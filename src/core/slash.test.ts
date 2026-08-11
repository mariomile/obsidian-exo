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
  const known = new Set(["goal", "grilling", "mattpocock-skills:grilling"]);

  it("hoists a command from its own line", () => {
    expect(hoistSlashCommand("organize my notes\n/goal", known)).toBe("/goal organize my notes");
  });

  it("leaves a command that already opens the message", () => {
    expect(hoistSlashCommand("/goal organize my notes", known)).toBe("/goal organize my notes");
  });

  it("keeps the args of a command that owns its line", () => {
    expect(hoistSlashCommand("fix the tests\n/goal ship v2", known)).toBe("/goal ship v2\nfix the tests");
  });

  it("shaves leading whitespace so a leading command actually opens the message", () => {
    // The CLI expands "/goal" only when "/" is the first character, so the
    // already-command-first guard has to hand back a string that starts there.
    expect(hoistSlashCommand("  /goal organize", known)).toBe("/goal organize");
    expect(hoistSlashCommand(" /goal\nmore context", known)).toBe("/goal\nmore context");
  });

  describe("embedded in prose", () => {
    it("hoists a command trailing a sentence", () => {
      // The shape typed in the composer: the palette inserts `/name ` right
      // where the caret is, at the end of a sentence.
      expect(hoistSlashCommand("Fammi domande precise, per capire cosa fare e perché. /grilling", known)).toBe(
        "/grilling Fammi domande precise, per capire cosa fare e perché.",
      );
    });

    it("hoists a command from the middle of a sentence", () => {
      expect(hoistSlashCommand("fai un /grilling su questo piano", known)).toBe("/grilling fai un su questo piano");
    });

    it("hoists a namespaced plugin skill", () => {
      expect(hoistSlashCommand("stress-test this. /mattpocock-skills:grilling", known)).toBe(
        "/mattpocock-skills:grilling stress-test this.",
      );
    });

    it("hoists across lines", () => {
      expect(hoistSlashCommand("prima riga\nseconda riga /goal", known)).toBe("/goal prima riga\nseconda riga");
    });

    it("skips an unknown token and takes the known one after it", () => {
      expect(hoistSlashCommand("check /nope then /goal", known)).toBe("/goal check /nope then");
    });
  });

  describe("false positives it must refuse", () => {
    it("ignores a command name inside a URL", () => {
      expect(hoistSlashCommand("see https://a.b/goal now", known)).toBe("see https://a.b/goal now");
      expect(hoistSlashCommand("see https://a.b/goal", known)).toBe("see https://a.b/goal");
    });

    it("ignores a command name inside a path", () => {
      // "/goal" here is preceded by "s", and "/Users" is followed by "/".
      expect(hoistSlashCommand("apri /Users/mario/goal ora", known)).toBe("apri /Users/mario/goal ora");
    });

    it("ignores unknown commands", () => {
      expect(hoistSlashCommand("text\n/unknowncmd", known)).toBe("text\n/unknowncmd");
      expect(hoistSlashCommand("prose /unknowncmd here", known)).toBe("prose /unknowncmd here");
    });

    it("ignores a bare slash and division-looking text", () => {
      expect(hoistSlashCommand("50/50 chance", known)).toBe("50/50 chance");
      expect(hoistSlashCommand("a / b", known)).toBe("a / b");
    });

    it("leaves the text alone with an empty roster", () => {
      expect(hoistSlashCommand("prose. /goal", new Set())).toBe("prose. /goal");
    });
  });
});
