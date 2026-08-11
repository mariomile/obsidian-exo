import { describe, it, expect } from "vitest";
import { codexSessionToolset } from "../src/core/codex-toolset";

const READ = new Set(["mcp__obsidian__search_vault", "mcp__obsidian__read_note"]);
const tools = [
  { name: "search_vault" },
  { name: "read_note" },
  { name: "create_note" },
  { name: "ask_user" },
];

describe("codexSessionToolset", () => {
  it("returns the input array ITSELF when the sandbox is not read-only", () => {
    // Reference equality on purpose: the tool list sent to sessions must stay
    // byte-identical when no gating applies — a defensive copy would already
    // be drift surface.
    expect(codexSessionToolset(tools, false, READ)).toBe(tools);
  });

  it("keeps only read tools in a read-only sandbox", () => {
    const names = codexSessionToolset(tools, true, READ).map((t) => t.name);
    expect(names).toContain("search_vault");
    expect(names).toContain("read_note");
    expect(names).not.toContain("create_note");
  });

  it("keeps ask_user in a read-only sandbox even though it is not a read tool", () => {
    const names = codexSessionToolset(tools, true, READ).map((t) => t.name);
    expect(names).toContain("ask_user");
  });

  it("matches read names by basename (the read set carries the mcp__obsidian__ prefix)", () => {
    // A broken prefix strip would filter EVERYTHING out in read-only mode.
    expect(codexSessionToolset(tools, true, READ).length).toBe(3);
  });
});
