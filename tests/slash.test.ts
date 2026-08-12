import { describe, expect, it } from "vitest";
import { hoistSlashCommand, parseLeadingCommand, expandCommandBody, expandVaultCommand } from "../src/core/slash";

const KNOWN = new Set(["goal", "loop", "superpowers:brainstorming", "deep-research"]);

describe("hoistSlashCommand", () => {
  it("hoists a trailing bare command and folds the text into its argument", () => {
    expect(hoistSlashCommand("Organizzami meglio le note di product heroes\n/goal", KNOWN)).toBe(
      "/goal Organizzami meglio le note di product heroes"
    );
  });

  it("leaves a command already on the first line untouched (CLI expands it)", () => {
    const t = "/goal\nOrganizzami le note";
    expect(hoistSlashCommand(t, KNOWN)).toBe(t);
  });

  it("leaves a message that already starts with a known command untouched", () => {
    const t = "/goal organize my notes\nplus details";
    expect(hoistSlashCommand(t, KNOWN)).toBe(t);
  });

  it("keeps inline args attached and appends the rest below", () => {
    expect(hoistSlashCommand("context first\n/loop 5m check builds", KNOWN)).toBe(
      "/loop 5m check builds\ncontext first"
    );
  });

  it("ignores slashes inside prose, URLs, and paths", () => {
    const t = "see https://example.com/goal and src/goal.ts please";
    expect(hoistSlashCommand(t, KNOWN)).toBe(t);
  });

  it("ignores unknown commands", () => {
    const t = "do the thing\n/notacommand";
    expect(hoistSlashCommand(t, KNOWN)).toBe(t);
  });

  it("matches namespaced commands", () => {
    expect(hoistSlashCommand("idea per una feature\n/superpowers:brainstorming", KNOWN)).toBe(
      "/superpowers:brainstorming idea per una feature"
    );
  });

  it("hoists only the first matching command", () => {
    expect(hoistSlashCommand("text\n/goal\n/loop", KNOWN)).toBe("/goal text\n/loop");
  });

  it("returns text unchanged when the known set is empty (no caps yet)", () => {
    const t = "hello\n/goal";
    expect(hoistSlashCommand(t, new Set())).toBe(t);
  });

  it("handles a bare command with no other text", () => {
    expect(hoistSlashCommand("/goal", KNOWN)).toBe("/goal");
  });

  it("tolerates hyphenated command names", () => {
    expect(hoistSlashCommand("ricerca su X\n/deep-research", KNOWN)).toBe("/deep-research ricerca su X");
  });
});

describe("parseLeadingCommand", () => {
  it("splits a command that opens the message from its arguments", () => {
    expect(parseLeadingCommand("/search prompt universe")).toEqual({ name: "search", args: "prompt universe" });
    expect(parseLeadingCommand("  /brief")).toEqual({ name: "brief", args: "" });
  });

  it("folds the lines below the command into the arguments", () => {
    expect(parseLeadingCommand("/export q3\nand include the appendix")).toEqual({
      name: "export",
      args: "q3\nand include the appendix",
    });
  });

  it("ignores prose, paths and mid-message commands", () => {
    expect(parseLeadingCommand("please run /brief")).toBeNull();
    expect(parseLeadingCommand("/Users/mario/notes")).toBeNull();
    expect(parseLeadingCommand("")).toBeNull();
  });
});

describe("expandCommandBody", () => {
  const BODY = ['---', 'description: Search', '---', 'Use "$ARGUMENTS" as the query.'].join("\n");

  it("strips frontmatter and substitutes $ARGUMENTS", () => {
    expect(expandCommandBody(BODY, "prompt universe")).toBe('Use "prompt universe" as the query.');
  });

  it("substitutes positional arguments", () => {
    expect(expandCommandBody("Move $1 into $2.", "a.md Archive")).toBe("Move a.md into Archive.");
  });

  it("leaves an unmatched positional token alone rather than emptying it", () => {
    expect(expandCommandBody("Move $1 into $2.", "a.md")).toBe("Move a.md into $2.");
  });

  // Silently dropping the arguments would make "/brief for Q3" behave exactly
  // like a bare "/brief", with nothing to show the difference.
  it("appends arguments when the command has no placeholder", () => {
    expect(expandCommandBody("Run the morning brief.", "for Q3")).toBe("Run the morning brief.\n\nfor Q3");
  });

  it("adds nothing when there are no arguments", () => {
    expect(expandCommandBody("Run the morning brief.", "")).toBe("Run the morning brief.");
  });

  // Half-emulating these would be worse than not expanding them: `!` runs a
  // shell command and `@` inlines a file, both BEFORE the model sees the text.
  it("leaves shell and file directives verbatim", () => {
    const raw = "Context: !`git status`\nRead @notes/a.md";
    expect(expandCommandBody(raw, "")).toBe(raw);
  });
});

describe("expandVaultCommand", () => {
  const read = async (path: string) => {
    if (path === ".claude/commands/search.md") return 'Use "$ARGUMENTS" as the query.';
    throw new Error("ENOENT");
  };

  it("expands a vault command when the engine cannot", async () => {
    expect(await expandVaultCommand("/search prompt universe", read)).toBe('Use "prompt universe" as the query.');
  });

  // Claude Code resolves these itself: expanding here too would send the body
  // AND leave the command in place.
  it("is a no-op when the engine expands natively", async () => {
    expect(await expandVaultCommand("/search prompt universe", null)).toBe("/search prompt universe");
  });

  it("leaves an unknown command exactly as the model saw it before", async () => {
    expect(await expandVaultCommand("/nope arg", read)).toBe("/nope arg");
    expect(await expandVaultCommand("just prose", read)).toBe("just prose");
  });
});
