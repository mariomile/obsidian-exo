import { describe, it, expect } from "vitest";
import { scaffoldItems, isVaultSetUp, parentFolder } from "../src/core/vault-setup";
import { exoPaths } from "../src/core/paths";

// Exercise with both a legacy (_system) and a fresh (_exo) root so the scaffold
// is proven root-agnostic — the whole point of the memory-root migration.
const LEGACY = exoPaths("_system");
const FRESH = exoPaths("_exo");

describe("scaffoldItems", () => {
  it("derives every path from the given root", () => {
    for (const item of scaffoldItems(FRESH)) {
      expect(item.path.startsWith("_exo/")).toBe(true);
    }
    for (const item of scaffoldItems(LEGACY)) {
      expect(item.path.startsWith("_system/")).toBe(true);
    }
  });

  it("folder items carry no content, file items carry string content", () => {
    for (const item of scaffoldItems(LEGACY)) {
      if (item.kind === "folder") expect(item.content).toBeUndefined();
      else expect(typeof item.content).toBe("string");
    }
  });

  it("has no duplicate paths", () => {
    const paths = scaffoldItems(LEGACY).map((i) => i.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("includes the vault-context.md sentinel as a file item", () => {
    const item = scaffoldItems(LEGACY).find((i) => i.path === LEGACY.vaultContext);
    expect(item?.kind).toBe("file");
  });

  it("does not touch the agent-folder blocks or review.md — those are owned by other features", () => {
    const paths = scaffoldItems(LEGACY).map((i) => i.path);
    expect(paths).not.toContain("_system/agent/now.md");
    expect(paths).not.toContain("_system/agent/persona.md");
    expect(paths).not.toContain("_system/agent/human.md");
    expect(paths).not.toContain("_system/review.md");
  });
});

describe("isVaultSetUp", () => {
  it("is false when vault-context.md is absent", () => {
    expect(isVaultSetUp(() => false, LEGACY)).toBe(false);
  });

  it("is true when vault-context.md exists", () => {
    expect(isVaultSetUp((path) => path === LEGACY.vaultContext, LEGACY)).toBe(true);
  });

  it("only checks the sentinel path, ignoring others", () => {
    expect(isVaultSetUp((path) => path === "_system/some-other-file.md", LEGACY)).toBe(false);
  });

  it("respects the configured root (a _system sentinel doesn't satisfy an _exo vault)", () => {
    expect(isVaultSetUp((path) => path === "_system/vault-context.md", FRESH)).toBe(false);
    expect(isVaultSetUp((path) => path === FRESH.vaultContext, FRESH)).toBe(true);
  });
});

describe("parentFolder", () => {
  it("returns the parent directory for a nested path", () => {
    expect(parentFolder("_system/memory/preferences/preferences.md")).toBe("_system/memory/preferences");
  });

  it("returns null for a top-level path with no slash", () => {
    expect(parentFolder("vault-context.md")).toBeNull();
  });
});

describe("scaffoldItems parent coverage", () => {
  it("every file item resolves to a non-null parent folder (guards the ENOENT-on-fresh-vault regression)", () => {
    for (const item of scaffoldItems(FRESH)) {
      if (item.kind === "file") {
        expect(parentFolder(item.path)).not.toBeNull();
      }
    }
  });
});
