import { describe, it, expect } from "vitest";
import { bootFileHead } from "../src/core/boot-content";

const FM = `---\ntype: memory\ncreated_by: claudian\ntags:\n  - type/memory\n---\n`;

describe("bootFileHead", () => {
  it("strips YAML frontmatter before capping", () => {
    const out = bootFileHead(`${FM}# Title\nreal content`, 100);
    expect(out).not.toContain("created_by");
    expect(out).toBe("# Title\nreal content");
  });

  it("spends the cap on content, not on frontmatter", () => {
    // The whole point: the head-slice used to be eaten by the YAML block, so the
    // budget bought zero signal. 60 chars of cap must now buy 60 chars of body.
    const out = bootFileHead(`${FM}${"c".repeat(200)}`, 60);
    expect(out).toBe("c".repeat(60) + "\n…(truncated)");
  });

  it("does not spend the head on the blank lines the frontmatter leaves behind", () => {
    const out = bootFileHead(`${FM}\n\n\n# Title\nbody`, 100);
    expect(out).toBe("# Title\nbody");
  });

  it("caps with the explicit truncation marker", () => {
    const out = bootFileHead("x".repeat(500), 100);
    expect(out).toBe("x".repeat(100) + "\n…(truncated)");
  });

  it("a body at exactly the cap is not truncated", () => {
    expect(bootFileHead("x".repeat(100), 100)).toBe("x".repeat(100));
  });

  it("returns short content unchanged (no marker)", () => {
    expect(bootFileHead("short", 100)).toBe("short");
  });

  it("returns empty for an empty or frontmatter-only file", () => {
    expect(bootFileHead("", 100)).toBe("");
    expect(bootFileHead(FM, 100)).toBe("");
  });
});
