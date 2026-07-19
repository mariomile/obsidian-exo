import { describe, it, expect } from "vitest";
import { SCAFFOLD_ITEMS, isVaultSetUp, VAULT_CONTEXT_PATH } from "../src/core/vault-setup";

describe("SCAFFOLD_ITEMS", () => {
  it("every path lives under _system/", () => {
    for (const item of SCAFFOLD_ITEMS) {
      expect(item.path.startsWith("_system/")).toBe(true);
    }
  });

  it("folder items carry no content, file items carry string content", () => {
    for (const item of SCAFFOLD_ITEMS) {
      if (item.kind === "folder") expect(item.content).toBeUndefined();
      else expect(typeof item.content).toBe("string");
    }
  });

  it("has no duplicate paths", () => {
    const paths = SCAFFOLD_ITEMS.map((i) => i.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("includes the vault-context.md sentinel as a file item", () => {
    const item = SCAFFOLD_ITEMS.find((i) => i.path === VAULT_CONTEXT_PATH);
    expect(item?.kind).toBe("file");
  });

  it("does not touch the agent-folder blocks or review.md — those are owned by other features", () => {
    const paths = SCAFFOLD_ITEMS.map((i) => i.path);
    expect(paths).not.toContain("_system/agent/now.md");
    expect(paths).not.toContain("_system/agent/persona.md");
    expect(paths).not.toContain("_system/agent/human.md");
    expect(paths).not.toContain("_system/review.md");
  });
});

describe("isVaultSetUp", () => {
  it("is false when vault-context.md is absent", () => {
    expect(isVaultSetUp(() => false)).toBe(false);
  });

  it("is true when vault-context.md exists", () => {
    expect(isVaultSetUp((path) => path === VAULT_CONTEXT_PATH)).toBe(true);
  });

  it("only checks the sentinel path, ignoring others", () => {
    expect(isVaultSetUp((path) => path === "_system/some-other-file.md")).toBe(false);
  });
});
