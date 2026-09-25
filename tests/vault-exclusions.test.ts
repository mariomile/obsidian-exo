import { describe, it, expect } from "vitest";
import { makeExclusion } from "../src/core/vault-exclusions";
import { searchVaultNotes } from "../src/obsidian/vault-search";
import { HarvestLog } from "../src/obsidian/harvest-log";

describe("makeExclusion", () => {
  const ex = makeExclusion(["Archive/", "/^Journal\\/\\d{4}\\//", "/[invalid/", 42], ["_exo/reports/"]);
  it("excludes Obsidian prefix filters, /regex/ filters, dot-folders and extra prefixes", () => {
    expect(ex("Archive/old.md")).toBe(true);
    expect(ex("Journal/2026/day.md")).toBe(true);
    expect(ex(".archive/x.md")).toBe(true);
    expect(ex("notes/.trash/x.md")).toBe(true);
    expect(ex("_exo/reports/2026-09-25-digest.md")).toBe(true);
  });
  it("keeps everything else, and ignores invalid or non-string filters", () => {
    expect(ex("Journal/notes.md")).toBe(false);
    expect(ex("CRM/People/Anna.md")).toBe(false);
  });
});

describe("searchVaultNotes exclusions", () => {
  it("drops excluded Sonar hits (the live case: reports outranking the person's note)", async () => {
    const app = {
      vault: { getMarkdownFiles: () => [] },
      plugins: {
        plugins: {
          sonar: {
            search: async () => [
              { path: "_exo/reports/a.md", title: "a", score: 9, excerpt: "Anna" },
              { path: "_exo/reports/b.md", title: "b", score: 8, excerpt: "Anna" },
              { path: "CRM/People/Anna.md", title: "Anna", score: 5, excerpt: "Anna" },
            ],
          },
        },
      },
    } as never;
    const { hits } = await searchVaultNotes(app, "anna", 1, makeExclusion([], ["_exo/reports/"]));
    expect(hits.map((h) => h.path)).toEqual(["CRM/People/Anna.md"]);
  });

  it("the built-in scorer skips excluded notes too", async () => {
    const file = (path: string) => ({ path, basename: path, stat: { size: 10, mtime: 1 }, content: "anna" });
    const files = [file("Private/anna.md"), file("CRM/anna.md")];
    const app = {
      vault: { getMarkdownFiles: () => files, cachedRead: async (f: { content: string }) => f.content },
      plugins: { plugins: {} },
    } as never;
    const { hits } = await searchVaultNotes(app, "anna", 5, makeExclusion(["Private/"]));
    expect(hits.map((h) => h.path)).toEqual(["CRM/anna.md"]);
  });
});

describe("HarvestLog", () => {
  it("moves a corrupt log aside instead of wiping it on the next append", async () => {
    let content: string | null = "{not json";
    const preserved: string[] = [];
    const log = new HarvestLog({
      read: async () => content,
      write: async (c) => void (content = c),
      preserveCorrupt: async (c) => void preserved.push(c),
    });
    await log.append({ id: "h1", at: 1, convoId: "c", title: "t", writes: [] });
    expect(preserved).toEqual(["{not json"]);
    expect(JSON.parse(content!)).toHaveLength(1);
  });
});
