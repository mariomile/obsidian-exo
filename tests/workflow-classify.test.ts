import { describe, it, expect } from "vitest";
import { classifyTurnOutput, isSensitiveTool } from "../src/core/workflow-classify";

const tools = (...names: string[]) => names.map((name) => ({ name }));

describe("isSensitiveTool", () => {
  it("shells are sensitive", () => {
    expect(isSensitiveTool("Bash")).toBe(true);
    expect(isSensitiveTool("Shell")).toBe(true);
  });

  it("write tools are sensitive", () => {
    expect(isSensitiveTool("Write")).toBe(true);
    expect(isSensitiveTool("Edit")).toBe(true);
  });

  it("plain read tools are not", () => {
    expect(isSensitiveTool("Read")).toBe(false);
    expect(isSensitiveTool("Grep")).toBe(false);
  });

  it("the vault's own MCP surface is exempt", () => {
    expect(isSensitiveTool("mcp__obsidian__search")).toBe(false);
  });

  it("an unknown external MCP tool is sensitive", () => {
    expect(isSensitiveTool("mcp__stripe__create_charge")).toBe(true);
  });
});

describe("classifyTurnOutput — outputType precedence", () => {
  it("artifact wins over everything", () => {
    const c = classifyTurnOutput(tools("Write", "Bash"), "# heading", true);
    expect(c.outputType).toBe("artifact");
  });

  it("vault-write wins when there is no artifact", () => {
    const c = classifyTurnOutput(tools("Write"), "# heading", false);
    expect(c.outputType).toBe("vault-write");
  });

  it("structured markdown with no write is `structured`", () => {
    expect(classifyTurnOutput([], "## Results\n", false).outputType).toBe("structured");
    expect(classifyTurnOutput([], "| a | b |\n", false).outputType).toBe("structured");
    expect(classifyTurnOutput([], "```json\n{}\n```", false).outputType).toBe("structured");
    expect(classifyTurnOutput([], "- [ ] todo", false).outputType).toBe("structured");
  });

  it("loose markdown falls to `markdown`, not `structured`", () => {
    // A bullet alone is markdown; a TASK bullet is structured. That distinction
    // is the whole difference between the two regexes.
    const c = classifyTurnOutput([], "- just a bullet", false);
    expect(c.outputType).toBe("markdown");
    expect(c.structuredOutput).toBe(false);
  });

  it("ordered lists count as markdown", () => {
    expect(classifyTurnOutput([], "1. first", false).outputType).toBe("markdown");
  });

  it("plain prose is `message`", () => {
    const c = classifyTurnOutput([], "Sure, that is done.", false);
    expect(c.outputType).toBe("message");
    expect(c.structuredOutput).toBe(false);
  });

  it("empty output is `message`", () => {
    expect(classifyTurnOutput([], "", false).outputType).toBe("message");
  });
});

describe("classifyTurnOutput — structure detection anchoring", () => {
  it("a heading mid-text still counts (multiline anchor)", () => {
    expect(classifyTurnOutput([], "intro\n## Section", false).structuredOutput).toBe(true);
  });

  it("a '#' that is not a heading does not count", () => {
    // No space after the hashes → not an ATX heading.
    const c = classifyTurnOutput([], "issue #42 is fixed", false);
    expect(c.structuredOutput).toBe(false);
    expect(c.outputType).toBe("message");
  });

  it("a bare ``` fence is not structured (only json/csv are)", () => {
    expect(classifyTurnOutput([], "```\nplain\n```", false).structuredOutput).toBe(false);
  });
});

describe("classifyTurnOutput — passthrough fields", () => {
  it("reports tool names in order", () => {
    expect(classifyTurnOutput(tools("Read", "Grep", "Read"), "", false).toolNames).toEqual([
      "Read",
      "Grep",
      "Read",
    ]);
  });

  it("hasVaultWrite and sensitive are independent of each other", () => {
    // Bash is sensitive but is not a vault write.
    const c = classifyTurnOutput(tools("Bash"), "", false);
    expect(c.sensitive).toBe(true);
    expect(c.hasVaultWrite).toBe(false);
    expect(c.outputType).toBe("message");
  });

  it("a read-only turn is neither sensitive nor structured", () => {
    const c = classifyTurnOutput(tools("Read"), "plain answer", false);
    expect(c.sensitive).toBe(false);
    expect(c.structuredOutput).toBe(false);
  });
});
