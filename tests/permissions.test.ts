import { describe, expect, it } from "vitest";
import { matchPermRule, decidePermission, allowKey, permArgText, permRuleLine } from "../src/core/permissions";

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

describe("decidePermission", () => {
  const base = {
    tool: "Bash",
    argText: "rm -rf x",
    isRead: false,
    isMemoryTool: false,
    alreadyAllowed: false,
    autoAllowRead: false,
    memoryWriteEnabled: true,
    permDenyRules: "",
    permAllowRules: "",
  };

  it("deny-rule wins over everything else, even when also auto-allow-eligible or a memory tool", () => {
    const outcome = decidePermission({
      ...base,
      tool: "mcp__obsidian__capture_learning",
      argText: "",
      isRead: true,
      isMemoryTool: true,
      alreadyAllowed: true,
      autoAllowRead: true,
      memoryWriteEnabled: false,
      permDenyRules: "mcp__obsidian__capture_learning",
      permAllowRules: "mcp__obsidian__capture_learning",
    });
    expect(outcome).toBe("deny-rule");
  });

  it("auto-allows via autoAllowRead && isRead", () => {
    const outcome = decidePermission({ ...base, tool: "Read", argText: "", isRead: true, autoAllowRead: true });
    expect(outcome).toBe("auto-allow");
  });

  it("auto-allows via alreadyAllowed", () => {
    const outcome = decidePermission({ ...base, alreadyAllowed: true });
    expect(outcome).toBe("auto-allow");
  });

  it("auto-allows via a matching permAllowRules entry", () => {
    const outcome = decidePermission({ ...base, permAllowRules: "Bash(rm)" });
    expect(outcome).toBe("auto-allow");
  });

  it("memory-denies only when isMemoryTool && !memoryWriteEnabled and nothing earlier matched", () => {
    const outcome = decidePermission({
      ...base,
      tool: "mcp__obsidian__capture_learning",
      argText: "",
      isMemoryTool: true,
      memoryWriteEnabled: false,
    });
    expect(outcome).toBe("memory-deny");
  });

  it("does not memory-deny when already allowed (auto-allow takes precedence)", () => {
    const outcome = decidePermission({
      ...base,
      tool: "mcp__obsidian__capture_learning",
      argText: "",
      isMemoryTool: true,
      memoryWriteEnabled: false,
      alreadyAllowed: true,
    });
    expect(outcome).toBe("auto-allow");
  });

  it("falls back to card when nothing else matches", () => {
    const outcome = decidePermission({ ...base, tool: "Edit", argText: "Active/Foo.md" });
    expect(outcome).toBe("card");
  });

  it("orders deny before allow: a deny rule beats a matching allow rule for the same tool/argText", () => {
    const outcome = decidePermission({
      ...base,
      permDenyRules: "Bash(rm)",
      permAllowRules: "Bash(rm)",
    });
    expect(outcome).toBe("deny-rule");
  });
});

describe("allowKey", () => {
  it("keys Bash by the leading command token", () => {
    expect(allowKey("Bash", { command: "rm -rf x" })).toBe("Bash:rm");
  });

  it("keys Bash as bare 'Bash' when the command is empty", () => {
    expect(allowKey("Bash", { command: "" })).toBe("Bash");
  });

  it("keys write tools by target file path", () => {
    expect(allowKey("Write", { file_path: "Active/Foo.md" })).toBe("Write:Active/Foo.md");
  });

  it("keys other tools by the bare tool name", () => {
    expect(allowKey("Read", { file_path: "Active/Foo.md" })).toBe("Read");
    expect(allowKey("mcp__obsidian__search_vault", { query: "x" })).toBe("mcp__obsidian__search_vault");
  });
});

describe("permArgText", () => {
  it("returns the full trimmed command for Bash", () => {
    expect(permArgText("Bash", { command: "  rm -rf x  " })).toBe("rm -rf x");
  });

  it("returns the target file path for write tools", () => {
    expect(permArgText("Write", { file_path: "Active/Foo.md" })).toBe("Active/Foo.md");
  });

  it("returns empty string for other tools", () => {
    expect(permArgText("Read", { file_path: "Active/Foo.md" })).toBe("");
  });
});

describe("permRuleLine", () => {
  it("produces Bash(token) for Bash commands", () => {
    expect(permRuleLine("Bash", { command: "rm -rf x" })).toBe("Bash(rm)");
  });

  it("produces bare Bash when the command is empty", () => {
    expect(permRuleLine("Bash", { command: "" })).toBe("Bash");
  });

  it("produces Tool(path) for write tools", () => {
    expect(permRuleLine("Write", { file_path: "Active/Foo.md" })).toBe("Write(Active/Foo.md)");
  });

  it("produces the bare tool name for other tools", () => {
    expect(permRuleLine("Read", { file_path: "Active/Foo.md" })).toBe("Read");
  });
});
