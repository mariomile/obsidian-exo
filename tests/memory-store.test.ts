import { describe, it, expect } from "vitest";
import {
  formatEntry,
  parseStoreFile,
  monthFileName,
  scoreEntries,
  resolveSupersedence,
  guardSupersede,
  type MemoryEntry,
} from "../src/core/memory-store";

/** A timestamp with a whole-ms ISO representation (round-trips through toISOString). */
const T = Date.UTC(2024, 6, 3, 12, 0, 0); // 2024-07-03T12:00:00.000Z

function entry(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: `mem-${T}`,
    kind: "preference",
    at: T,
    session: "sess-1",
    tags: [],
    source: "user",
    text: "verbatim text",
    ...over,
  };
}

describe("formatEntry / parseStoreFile round-trip", () => {
  it("round-trips a minimal entry (no tags, no supersedes)", () => {
    const e = entry();
    const parsed = parseStoreFile(formatEntry(e));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(e);
  });

  it("round-trips tags and supersedes when present", () => {
    const e = entry({ tags: ["product", "roadmap"], supersedes: "mem-100" });
    const parsed = parseStoreFile(formatEntry(e));
    expect(parsed[0]).toEqual(e);
  });

  it("omits the tags and supersedes lines when absent", () => {
    const block = formatEntry(entry());
    expect(block).not.toContain("tags:");
    expect(block).not.toContain("supersedes:");
    expect(block).not.toContain("origin:");
  });

  it("round-trips an import provenance origin line", () => {
    const e = entry({ source: "generated", origin: "claude-mem:123" });
    const parsed = parseStoreFile(formatEntry(e));
    expect(parsed[0]).toEqual(e);
    expect(formatEntry(e)).toContain("- origin: claude-mem:123");
  });

  it("round-trips a multi-id (comma-list) supersedes line", () => {
    const e = entry({ source: "generated", supersedes: "mem-1, mem-2, mem-3" });
    const parsed = parseStoreFile(formatEntry(e));
    expect(parsed[0].supersedes).toBe("mem-1, mem-2, mem-3");
  });

  it("preserves multi-line verbatim text including internal blank lines", () => {
    const e = entry({ text: "line one\n\n- a bullet\n- another\n\nfinal para" });
    const parsed = parseStoreFile(formatEntry(e));
    expect(parsed[0].text).toBe(e.text);
  });

  it("round-trips several entries concatenated into one file", () => {
    const a = entry({ id: "mem-1", at: 1, text: "first" });
    const b = entry({ id: "mem-2", at: 2, text: "second\nmore", tags: ["x"] });
    const file = [formatEntry(a), formatEntry(b)].join("\n\n");
    expect(parseStoreFile(file)).toEqual([a, b]);
  });

  it("tolerates junk around blocks: ignores leading prose, recovers every block", () => {
    const a = entry({ id: "mem-1", at: 1, text: "first" });
    const b = entry({ id: "mem-2", at: 2, text: "second" });
    const file =
      "# a human heading someone typed\n\nsome loose prose\n\n" +
      formatEntry(a) +
      "\n\n" +
      formatEntry(b) +
      "\n\ntrailing junk\n";
    const parsed = parseStoreFile(file);
    // Leading prose is ignored; both real blocks are recovered with correct metadata.
    expect(parsed.map((e) => e.id)).toEqual(["mem-1", "mem-2"]);
    expect(parsed[0].kind).toBe("preference");
    expect(parsed[0].text).toBe("first");
    // Trailing junk after the last block is absorbed into its verbatim text (no terminator exists).
    expect(parsed[1].text.startsWith("second")).toBe(true);
  });

  it("falls back to the id epoch when the at: line is missing", () => {
    const file = `## mem-42 fact\n- session: unknown\n\nhello`;
    const parsed = parseStoreFile(file);
    expect(parsed[0].at).toBe(42);
    expect(parsed[0].session).toBe("unknown");
  });

  it("returns [] for an empty store", () => {
    expect(parseStoreFile("")).toEqual([]);
    expect(parseStoreFile("just prose, no blocks\n")).toEqual([]);
  });
});

describe("provenance sentinels (source)", () => {
  it("round-trips a generated entry and emits the sentinel line", () => {
    const e = entry({ source: "generated" });
    const block = formatEntry(e);
    expect(block).toContain("- source: @generated");
    expect(parseStoreFile(block)[0]).toEqual(e);
    expect(parseStoreFile(block)[0].source).toBe("generated");
  });

  it("omits the source line for user entries (legacy byte-identical format)", () => {
    const block = formatEntry(entry({ source: "user" }));
    expect(block).not.toContain("source:");
  });

  it("parses a legacy sentinel-less block as source 'user'", () => {
    const legacy = `## mem-1 fact\n- at: 2024-07-03T12:00:00.000Z\n- session: sess-1\n\nhello`;
    expect(parseStoreFile(legacy)[0].source).toBe("user");
  });

  it("falls back to 'user' for a malformed/unknown source value", () => {
    const bad = `## mem-1 fact\n- session: sess-1\n- source: nonsense\n\nhello`;
    expect(parseStoreFile(bad)[0].source).toBe("user");
  });

  it("accepts the source value with or without the @ prefix", () => {
    const noAt = `## mem-1 fact\n- session: sess-1\n- source: generated\n\nhello`;
    expect(parseStoreFile(noAt)[0].source).toBe("generated");
  });
});

describe("guardSupersede (truth firewall)", () => {
  it("blocks a generated entry from superseding a user entry", () => {
    const userE = entry({ id: "mem-1", source: "user" });
    const gen = entry({ id: "mem-2", source: "generated", supersedes: "mem-1" });
    const res = guardSupersede(gen, [userE]);
    expect(res.ok).toBe(false);
  });

  it("allows a user entry to supersede a user entry", () => {
    const a = entry({ id: "mem-1", source: "user" });
    const b = entry({ id: "mem-2", source: "user", supersedes: "mem-1" });
    expect(guardSupersede(b, [a]).ok).toBe(true);
  });

  it("allows a user entry to supersede a generated entry", () => {
    const g = entry({ id: "mem-1", source: "generated" });
    const u = entry({ id: "mem-2", source: "user", supersedes: "mem-1" });
    expect(guardSupersede(u, [g]).ok).toBe(true);
  });

  it("allows a generated entry to supersede a generated entry", () => {
    const g1 = entry({ id: "mem-1", source: "generated" });
    const g2 = entry({ id: "mem-2", source: "generated", supersedes: "mem-1" });
    expect(guardSupersede(g2, [g1]).ok).toBe(true);
  });

  it("allows a generated entry that supersedes nothing", () => {
    const g = entry({ id: "mem-2", source: "generated" });
    expect(guardSupersede(g, []).ok).toBe(true);
  });

  it("allows a generated entry whose supersedes target is unknown", () => {
    const g = entry({ id: "mem-2", source: "generated", supersedes: "mem-missing" });
    expect(guardSupersede(g, []).ok).toBe(true);
  });

  it("blocks a generated merge whose comma-list touches ANY user entry", () => {
    const genTarget = entry({ id: "mem-1", source: "generated" });
    const userTarget = entry({ id: "mem-2", source: "user" });
    const merged = entry({ id: "mem-9", source: "generated", supersedes: "mem-1, mem-2" });
    expect(guardSupersede(merged, [genTarget, userTarget]).ok).toBe(false);
  });

  it("allows a generated merge whose comma-list targets are all generated", () => {
    const g1 = entry({ id: "mem-1", source: "generated" });
    const g2 = entry({ id: "mem-2", source: "generated" });
    const merged = entry({ id: "mem-9", source: "generated", supersedes: "mem-1, mem-2" });
    expect(guardSupersede(merged, [g1, g2]).ok).toBe(true);
  });
});

describe("monthFileName", () => {
  it("names the monthly file YYYY-MM.md", () => {
    expect(monthFileName(Date.UTC(2024, 0, 15))).toBe("2024-01.md");
    expect(monthFileName(Date.UTC(2024, 6, 3))).toBe("2024-07.md");
    expect(monthFileName(Date.UTC(2026, 11, 31))).toBe("2026-12.md");
  });
});

describe("scoreEntries", () => {
  it("ranks an exact multi-term match above a partial one", () => {
    const both = entry({ id: "mem-both", text: "product roadmap planning" });
    const partial = entry({ id: "mem-partial", text: "product only note" });
    const noise = entry({ id: "mem-noise", text: "unrelated grocery list" });
    const ranked = scoreEntries("product roadmap", [partial, noise, both]);
    expect(ranked[0].entry.id).toBe("mem-both");
    expect(ranked[1].entry.id).toBe("mem-partial");
    expect(ranked.find((r) => r.entry.id === "mem-noise")!.score).toBe(0);
  });

  it("matches against tags and kind, not just text", () => {
    const byTag = entry({ id: "mem-tag", text: "nothing here", tags: ["pricing"] });
    const miss = entry({ id: "mem-miss", text: "nothing here", tags: ["other"] });
    const ranked = scoreEntries("pricing", [miss, byTag]);
    expect(ranked[0].entry.id).toBe("mem-tag");
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  it("breaks score ties by recency (newest first)", () => {
    const older = entry({ id: "mem-old", at: 1000, text: "same words here" });
    const newer = entry({ id: "mem-new", at: 2000, text: "same words here" });
    const ranked = scoreEntries("same words", [older, newer]);
    expect(ranked[0].entry.id).toBe("mem-new");
    expect(ranked[1].entry.id).toBe("mem-old");
    expect(ranked[0].score).toBe(ranked[1].score);
  });

  it("returns [] for an empty corpus", () => {
    expect(scoreEntries("anything", [])).toEqual([]);
  });
});

describe("resolveSupersedence", () => {
  it("excludes an entry that another supersedes", () => {
    const old = entry({ id: "mem-1", text: "old" });
    const neu = entry({ id: "mem-2", text: "new", supersedes: "mem-1" });
    expect(resolveSupersedence([old, neu]).map((e) => e.id)).toEqual(["mem-2"]);
  });

  it("excludes every link in a supersedence chain", () => {
    const c = entry({ id: "mem-c", text: "c" });
    const b = entry({ id: "mem-b", text: "b", supersedes: "mem-c" });
    const a = entry({ id: "mem-a", text: "a", supersedes: "mem-b" });
    expect(resolveSupersedence([a, b, c]).map((e) => e.id)).toEqual(["mem-a"]);
  });

  it("ignores unknown supersedes ids", () => {
    const only = entry({ id: "mem-1", text: "x", supersedes: "mem-does-not-exist" });
    expect(resolveSupersedence([only]).map((e) => e.id)).toEqual(["mem-1"]);
  });

  it("excludes every id in a comma-list supersedes (merge consolidation)", () => {
    const a = entry({ id: "mem-1", text: "a" });
    const b = entry({ id: "mem-2", text: "b" });
    const c = entry({ id: "mem-3", text: "c" });
    const merged = entry({ id: "mem-99", text: "consolidated", source: "generated", supersedes: "mem-1, mem-2, mem-3" });
    expect(resolveSupersedence([a, b, c, merged]).map((e) => e.id)).toEqual(["mem-99"]);
  });

  it("returns all entries when none supersede", () => {
    const a = entry({ id: "mem-1", text: "a" });
    const b = entry({ id: "mem-2", text: "b" });
    expect(resolveSupersedence([a, b])).toEqual([a, b]);
  });
});
