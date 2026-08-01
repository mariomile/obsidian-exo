import { describe, it, expect } from "vitest";
import { mcpSections, skillSections } from "../src/core/hub-sections";
import type { DiscoveryItem } from "../src/core/connections-scan";

const mcp = (name: string, state: DiscoveryItem["state"], status?: string, origin = "vault"): DiscoveryItem => ({
  kind: "mcp", name, source: "vault", origin, state, status,
});
const skill = (name: string, state: DiscoveryItem["state"], origin = "proj"): DiscoveryItem => ({
  kind: "skill", name, source: "other-project", origin, state,
});

describe("mcpSections", () => {
  it("partitions into connected / disabled / importable / inherited", () => {
    const items = [
      mcp("a", "active", "connected"),
      mcp("b", "active", "disabled"),
      mcp("c", "importable", undefined, "Codex"),
      mcp("d", "have", undefined, "claude-global"),
    ];
    const s = mcpSections(items);
    expect(s.connected.map((i) => i.name)).toEqual(["a"]);
    expect(s.disabled.map((i) => i.name)).toEqual(["b"]);
    expect(s.importable.map((i) => i.name)).toEqual(["c"]);
    expect(s.inherited.map((i) => i.name)).toEqual(["d"]);
  });

  it("keeps needs-auth and failed servers in Connected (live rows with recovery actions)", () => {
    const s = mcpSections([mcp("x", "active", "needs-auth"), mcp("y", "active", "failed")]);
    expect(s.connected.map((i) => i.name)).toEqual(["x", "y"]);
    expect(s.disabled).toEqual([]);
  });

  it("sorts each section by origin then name", () => {
    const s = mcpSections([
      mcp("zeta", "active", "connected", "vault"),
      mcp("alpha", "active", "connected", "vault"),
      mcp("beta", "active", "connected", "claude-global"),
    ]);
    expect(s.connected.map((i) => `${i.origin}/${i.name}`)).toEqual([
      "claude-global/beta", "vault/alpha", "vault/zeta",
    ]);
  });
});

describe("skillSections", () => {
  it("splits vault-active, importable-by-origin, and collapses the have count", () => {
    const items = [
      skill("mine", "active", "vault"),
      skill("b", "importable", "projB"),
      skill("a", "importable", "projA"),
      skill("a2", "importable", "projA"),
      skill("global1", "have"),
      skill("global2", "have"),
    ];
    const s = skillSections(items);
    expect(s.vault.map((i) => i.name)).toEqual(["mine"]);
    expect(s.groups.map((g) => g.origin)).toEqual(["projA", "projB"]); // origins sorted
    expect(s.groups[0].items.map((i) => i.name)).toEqual(["a", "a2"]);
    expect(s.haveCount).toBe(2);
  });

  it("returns empty groups and zero haveCount on no input", () => {
    const s = skillSections([]);
    expect(s.vault).toEqual([]);
    expect(s.groups).toEqual([]);
    expect(s.haveCount).toBe(0);
  });
});
