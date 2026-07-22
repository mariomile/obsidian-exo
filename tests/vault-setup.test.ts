import { describe, it, expect } from "vitest";
import { scaffoldItems, isVaultSetUp, parentFolder, memorySetupNeeded } from "../src/core/vault-setup";
import { exoPaths } from "../src/core/paths";

// Exercise with both a legacy (_system) and a fresh (_exo) root so the scaffold
// is proven root-agnostic — the whole point of the memory-root migration.
const LEGACY = exoPaths("_system");
const FRESH = exoPaths("_exo");

describe("scaffoldItems", () => {
  it("derives every path from the given root", () => {
    for (const item of scaffoldItems(FRESH, "full")) {
      expect(item.path.startsWith("_exo/")).toBe(true);
    }
    for (const item of scaffoldItems(LEGACY, "full")) {
      expect(item.path.startsWith("_system/")).toBe(true);
    }
  });

  it("folder items carry no content, file items carry string content", () => {
    for (const item of scaffoldItems(LEGACY, "full")) {
      if (item.kind === "folder") expect(item.content).toBeUndefined();
      else expect(typeof item.content).toBe("string");
    }
  });

  it("has no duplicate paths", () => {
    const paths = scaffoldItems(LEGACY, "full").map((i) => i.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("includes the vault-context.md sentinel as a file item (full only)", () => {
    const item = scaffoldItems(LEGACY, "full").find((i) => i.path === LEGACY.vaultContext);
    expect(item?.kind).toBe("file");
  });

  it("does not touch the agent-folder blocks or review.md — those are owned by other features", () => {
    const paths = scaffoldItems(LEGACY, "full").map((i) => i.path);
    expect(paths).not.toContain("_system/agent/now.md");
    expect(paths).not.toContain("_system/agent/persona.md");
    expect(paths).not.toContain("_system/agent/human.md");
    expect(paths).not.toContain("_system/review.md");
  });
});

describe("scaffoldItems presets", () => {
  it("minimal is the mechanism subset of full", () => {
    const full = scaffoldItems(LEGACY, "full").map((i) => i.path);
    const minimal = scaffoldItems(LEGACY, "minimal").map((i) => i.path);
    expect(minimal.length).toBeLessThan(full.length);
    for (const p of minimal) expect(full).toContain(p);
  });

  it("minimal contains only mechanism-tier items", () => {
    for (const item of scaffoldItems(LEGACY, "minimal")) {
      expect(item.tier).toBe("mechanism");
    }
  });

  it("minimal creates the operational layer but no marioverse content", () => {
    const minimal = scaffoldItems(LEGACY, "minimal").map((i) => i.path);
    // mechanism present
    expect(minimal).toContain(LEGACY.store);
    expect(minimal).toContain(LEGACY.tasks);
    expect(minimal).toContain(LEGACY.openLoops);
    // content absent
    expect(minimal).not.toContain(LEGACY.vaultContext);
    expect(minimal).not.toContain(LEGACY.preferences);
    expect(minimal).not.toContain(LEGACY.rules);
    expect(minimal).not.toContain(LEGACY.decisions);
  });

  it("full adds the content tier on top of minimal", () => {
    const full = scaffoldItems(LEGACY, "full").map((i) => i.path);
    expect(full).toContain(LEGACY.vaultContext);
    expect(full).toContain(LEGACY.preferences);
    expect(full).toContain(LEGACY.rules);
  });
});

describe("memorySetupNeeded", () => {
  it("offers the picker on a fresh vault with no choice made", () => {
    expect(memorySetupNeeded(undefined, false)).toBe(true);
  });

  it("does not offer it once any choice is recorded — including 'none'", () => {
    expect(memorySetupNeeded("none", false)).toBe(false);
    expect(memorySetupNeeded("minimal", false)).toBe(false);
    expect(memorySetupNeeded("full", false)).toBe(false);
  });

  it("does not offer it to a pre-picker install that's already set up", () => {
    expect(memorySetupNeeded(undefined, true)).toBe(false);
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
    for (const item of scaffoldItems(FRESH, "full")) {
      if (item.kind === "file") {
        expect(parentFolder(item.path)).not.toBeNull();
      }
    }
  });
});
