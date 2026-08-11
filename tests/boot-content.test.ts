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

  it("fromFirstHeading skips a prose header and lands on the first ## entry", () => {
    const boilerplate = "# Session Log\n\n> Questo file e GENERATO: non modificarlo a mano.\n".repeat(8);
    const raw = `${FM}${boilerplate}\n## [2026-08-11 12:02] lint | Delete pass\nbody\n## [2026-08-10 15:03] refactor | Archivio\n`;
    const out = bootFileHead(raw, 200, { fromFirstHeading: true });
    expect(out.startsWith("## [2026-08-11 12:02]")).toBe(true);
    expect(out).not.toContain("GENERATO");
    expect(out).toContain("## [2026-08-10 15:03]");
  });

  it("fromFirstHeading anchors on `## `, not on a `# ` or `### ` heading", () => {
    const raw = `# Title\n### Deep\nprose\n## Entry one\ntail`;
    const out = bootFileHead(raw, 100, { fromFirstHeading: true });
    expect(out).toBe("## Entry one\ntail");
  });

  it("fromFirstHeading falls back to the stripped body when no heading exists", () => {
    const out = bootFileHead(`${FM}just prose, no headings`, 100, { fromFirstHeading: true });
    expect(out).toBe("just prose, no headings");
  });

  it("leaves the body alone when fromFirstHeading is absent", () => {
    const raw = `# Session Log\nwarning line\n## Entry one\n`;
    expect(bootFileHead(raw, 100)).toBe("# Session Log\nwarning line\n## Entry one");
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
