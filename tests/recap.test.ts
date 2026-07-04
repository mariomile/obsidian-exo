import { describe, it, expect } from "vitest";
import { buildRecap } from "../src/core/recap";
import type { Message, Segment } from "../src/core/model";

function tool(name: string, input: unknown): Segment {
  return { t: "tool", name, input, ok: true, output: "" };
}
function assistant(...segments: Segment[]): Message {
  return { role: "assistant", segments };
}
function user(text: string): Message {
  return { role: "user", text };
}

describe("buildRecap — web", () => {
  it("classifies WebSearch (query) and WebFetch (url) and dedupes, first-seen order", () => {
    const r = buildRecap([
      assistant(
        tool("WebSearch", { query: "obsidian plugins" }),
        tool("WebFetch", { url: "https://example.com/a" }),
        tool("WebSearch", { query: "obsidian plugins" }), // dup query
        tool("WebFetch", { url: "https://example.com/a" }) // dup url
      ),
    ]);
    expect(r.web).toEqual([
      { label: "obsidian plugins" },
      { label: "https://example.com/a", url: "https://example.com/a" },
    ]);
  });

  it("ignores web tools with no query/url", () => {
    const r = buildRecap([assistant(tool("WebSearch", {}), tool("WebFetch", { url: "" }))]);
    expect(r.web).toEqual([]);
  });
});

describe("buildRecap — read/write from segments", () => {
  it("derives reads and writes from tool file paths", () => {
    const r = buildRecap([
      assistant(
        tool("Read", { file_path: "Notes/A.md" }),
        tool("Read", { file_path: "Notes/B.md" }),
        tool("Write", { file_path: "Notes/C.md" })
      ),
    ]);
    expect(r.read).toEqual(["Notes/A.md", "Notes/B.md"]);
    expect(r.written).toEqual([{ path: "Notes/C.md" }]);
  });

  it("a read-then-write upgrades to written (not listed under read)", () => {
    const r = buildRecap([
      assistant(tool("Read", { file_path: "Notes/A.md" }), tool("Edit", { file_path: "Notes/A.md" })),
    ]);
    expect(r.read).toEqual([]);
    expect(r.written).toEqual([{ path: "Notes/A.md" }]);
  });

  it("aggregates the edit count across repeated writes", () => {
    const r = buildRecap([
      assistant(
        tool("Write", { file_path: "Notes/A.md" }),
        tool("Edit", { file_path: "Notes/A.md" }),
        tool("Edit", { file_path: "Notes/A.md" })
      ),
    ]);
    expect(r.written).toEqual([{ path: "Notes/A.md", count: 3 }]);
  });
});

describe("buildRecap — artifacts & skills", () => {
  it("includes artifact segments as written files", () => {
    const r = buildRecap([assistant({ t: "artifact", path: "Resources/deck.html" })]);
    expect(r.written).toEqual([{ path: "Resources/deck.html" }]);
  });

  it("extracts skill invocations, deduped", () => {
    const r = buildRecap([
      assistant(tool("Skill", { skill: "defuddle" }), tool("Skill", { skill: "defuddle" }), tool("Skill", { skill: "search" })),
    ]);
    expect(r.skills).toEqual(["defuddle", "search"]);
  });
});

describe("buildRecap — aggregation & empty", () => {
  it("rolls up across multiple assistant turns and ignores user turns", () => {
    const r = buildRecap([
      user("do research"),
      assistant(tool("WebSearch", { query: "q1" }), tool("Read", { file_path: "A.md" })),
      user("now write it"),
      assistant(tool("Write", { file_path: "B.md" }), tool("WebSearch", { query: "q2" })),
    ]);
    expect(r.web).toEqual([{ label: "q1" }, { label: "q2" }]);
    expect(r.read).toEqual(["A.md"]);
    expect(r.written).toEqual([{ path: "B.md" }]);
  });

  it("returns an all-empty recap for an empty conversation", () => {
    expect(buildRecap([])).toEqual({ web: [], read: [], written: [], skills: [] });
  });
});
