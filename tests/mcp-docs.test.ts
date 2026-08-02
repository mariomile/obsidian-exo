import { describe, expect, it } from "vitest";
import {
  mcpDocPath,
  isSafeDocName,
  mcpDocTemplate,
  summarizeMcpDoc,
  hasMcpDocContent,
} from "../src/core/mcp-docs";

describe("mcpDocPath / isSafeDocName", () => {
  it("puts notes under .claude/mcp", () => {
    expect(mcpDocPath("notion")).toBe(".claude/mcp/notion.md");
  });

  it("rejects names that would escape the docs dir", () => {
    expect(isSafeDocName("notion")).toBe(true);
    expect(isSafeDocName("my-server_2")).toBe(true);
    expect(isSafeDocName("../../etc/passwd")).toBe(false);
    expect(isSafeDocName("a/b")).toBe(false);
    expect(isSafeDocName("plugin:brand-voice:figma")).toBe(false); // inherited names aren't ours
  });
});

describe("summarizeMcpDoc", () => {
  it("drops frontmatter, comments and placeholder bullets", () => {
    const raw = mcpDocTemplate("notion", "npx notion-mcp");
    const body = summarizeMcpDoc(raw);
    expect(body).not.toContain("---");
    expect(body).not.toContain("<!--");
    expect(body).toContain("# notion");
    expect(body.split("\n").filter((l) => l.trim() === "-")).toHaveLength(0);
  });

  it("keeps the user's own prose", () => {
    const raw = `---\ntags:\n  - type/reference\n---\n\n# notion\n\n## Scope\n- Read the roadmap DB\n\n<!-- hint -->\n`;
    const body = summarizeMcpDoc(raw);
    expect(body).toContain("Read the roadmap DB");
    expect(body).not.toContain("hint");
  });

  it("clamps long notes", () => {
    const raw = `# x\n\n${"word ".repeat(500)}`;
    expect(summarizeMcpDoc(raw, 100)).toHaveLength(101); // 100 + ellipsis
  });
});

describe("hasMcpDocContent", () => {
  it("is false for a never-filled template — an empty note must not read as documented", () => {
    expect(hasMcpDocContent(mcpDocTemplate("notion", "npx notion-mcp"))).toBe(false);
  });

  it("is false for headings alone", () => {
    expect(hasMcpDocContent("# notion\n\n## Scope\n")).toBe(false);
  });

  it("is true once real content exists", () => {
    expect(hasMcpDocContent("# notion\n\n## Scope\n- Read the roadmap DB\n")).toBe(true);
  });
});
