import { describe, expect, it } from "vitest";
import { hoistSlashCommand } from "../src/core/slash";

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
