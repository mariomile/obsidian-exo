import { describe, it, expect } from "vitest";
import {
  AGENT_BLOCK_NAMES,
  blockSpec,
  isAgentBlock,
  parseManifest,
  compileIdentity,
  rethinkPolicy,
  planRethink,
  buildSeedPrompt,
  parseSeedBlocks,
  manifestContent,
  IDENTITY_ARBITRATION_LINE,
  type BlockName,
  type IdentityBlock,
} from "../src/core/agent-self";

/* ------------------------------ registry -------------------------------- */

describe("AGENT_BLOCKS registry", () => {
  it("declares persona/human/now in that order with the spec limits", () => {
    expect(AGENT_BLOCK_NAMES).toEqual<BlockName[]>(["persona", "human", "now"]);
    expect(blockSpec("persona").limit).toBe(1500);
    expect(blockSpec("human").limit).toBe(2000);
    expect(blockSpec("now").limit).toBe(1500);
  });

  it("assigns the spec ownership tiers", () => {
    expect(blockSpec("now").owner).toBe("rewrite");
    expect(blockSpec("human").owner).toBe("rewrite-with-rationale");
    expect(blockSpec("persona").owner).toBe("propose-only");
  });

  it("recognizes only the three block names", () => {
    expect(isAgentBlock("persona")).toBe(true);
    expect(isAgentBlock("human")).toBe(true);
    expect(isAgentBlock("now")).toBe(true);
    expect(isAgentBlock("nope")).toBe(false);
    expect(isAgentBlock("")).toBe(false);
  });
});

describe("rethinkPolicy", () => {
  it("maps each block to its write policy", () => {
    expect(rethinkPolicy("now")).toBe("rewrite");
    expect(rethinkPolicy("human")).toBe("rewrite-with-rationale");
    expect(rethinkPolicy("persona")).toBe("propose-only");
  });
});

describe("planRethink", () => {
  it("now.md → free write, no rationale required", () => {
    expect(planRethink("now")).toEqual({ verb: "write", block: "now", requireRationale: false });
  });

  it("human.md → write that requires the rationale surfaced", () => {
    expect(planRethink("human")).toEqual({ verb: "write", block: "human", requireRationale: true });
  });

  it("persona.md → propose-only (no direct write)", () => {
    expect(planRethink("persona")).toEqual({ verb: "propose", block: "persona" });
  });
});

/* ---------------------------- parseManifest ----------------------------- */

describe("parseManifest", () => {
  it("returns hardcoded defaults on empty/garbage input", () => {
    const a = parseManifest("");
    const b = parseManifest("%%% not a manifest %%%");
    expect(a.version).toBe(b.version);
    expect(a.blocks.map((x) => x.name)).toEqual(["persona", "human", "now"]);
    // Defaults carry the canonical limits.
    expect(a.blocks.find((x) => x.name === "human")?.limit).toBe(2000);
  });

  it("parses a well-formed manifest table without throwing", () => {
    const md = [
      "# Agent manifest",
      "version: 1",
      "",
      "| block | limit | owner |",
      "| persona | 1500 | propose-only |",
      "| human | 2000 | rewrite-with-rationale |",
      "| now | 1500 | rewrite |",
    ].join("\n");
    const m = parseManifest(md);
    expect(m.blocks.map((b) => b.name)).toEqual(["persona", "human", "now"]);
  });

  it("falls back to the canonical block set when the table is corrupt", () => {
    const m = parseManifest("version: 9\n| block | limit |\n| garbage row without cols");
    expect(m.blocks.map((b) => b.name)).toEqual(["persona", "human", "now"]);
  });

  it("never throws on any input", () => {
    expect(() => parseManifest(undefined as unknown as string)).not.toThrow();
    expect(() => parseManifest(null as unknown as string)).not.toThrow();
  });
});

/* --------------------------- compileIdentity ---------------------------- */

const NOW_MS = Date.UTC(2026, 6, 10, 12, 0, 0); // 2026-07-10

function block(name: BlockName, content: string, ageDays?: number): IdentityBlock {
  return {
    name,
    content,
    mtime: ageDays === undefined ? undefined : NOW_MS - ageDays * 86_400_000,
  };
}

describe("compileIdentity", () => {
  it("returns an empty string when every block is missing", () => {
    expect(compileIdentity([], { now: NOW_MS })).toBe("");
    expect(compileIdentity([block("persona", "   ")], { now: NOW_MS })).toBe("");
  });

  it("orders persona → human → now regardless of input order", () => {
    const out = compileIdentity(
      [block("now", "now text"), block("persona", "persona text"), block("human", "human text")],
      { now: NOW_MS }
    );
    const pi = out.indexOf("persona text");
    const hi = out.indexOf("human text");
    const ni = out.indexOf("now text");
    expect(pi).toBeGreaterThan(-1);
    expect(pi).toBeLessThan(hi);
    expect(hi).toBeLessThan(ni);
  });

  it("heads each block and appends the arbitration line", () => {
    const out = compileIdentity([block("persona", "be terse")], { now: NOW_MS });
    expect(out).toContain("Persona");
    expect(out).toContain("be terse");
    expect(out).toContain(IDENTITY_ARBITRATION_LINE);
  });

  it("adds a staleness marker from the mtime", () => {
    const out = compileIdentity([block("now", "hot project X", 5)], { now: NOW_MS });
    expect(out).toMatch(/updated 5 days ago/);
  });

  it("says 'today' for a same-day mtime", () => {
    const out = compileIdentity([block("now", "hot project X", 0)], { now: NOW_MS });
    expect(out).toMatch(/updated today/);
  });

  it("omits the staleness marker when the mtime is unknown", () => {
    const out = compileIdentity([block("now", "hot project X")], { now: NOW_MS });
    expect(out).not.toMatch(/updated .* days ago/);
    expect(out).not.toMatch(/updated today/);
  });

  it("includes an over-limit block WHOLE and marks it over budget (never truncates)", () => {
    const big = "x".repeat(1600); // persona limit is 1500
    const out = compileIdentity([block("persona", big)], { now: NOW_MS });
    expect(out).toContain(big); // the whole block survives verbatim
    expect(out).toMatch(/over budget/i);
  });

  it("does not mark an at-limit block as over budget", () => {
    const exact = "y".repeat(1500);
    const out = compileIdentity([block("persona", exact)], { now: NOW_MS });
    expect(out).not.toMatch(/over budget/i);
  });

  it("skips missing/blank blocks silently while keeping the present ones", () => {
    const out = compileIdentity(
      [block("persona", "p"), block("human", "  "), block("now", "n")],
      { now: NOW_MS }
    );
    expect(out).toContain("p");
    expect(out).toContain("n");
    // no empty 'Human' heading with nothing under it — human was blank so it's skipped
    const hMatches = out.match(/Human/g) ?? [];
    expect(hMatches.length).toBe(0);
  });
});

/* ------------------------------- seeder --------------------------------- */

describe("buildSeedPrompt", () => {
  const sources = {
    mentalModel: "Mario is a 0-to-1 PM.",
    preferences: "Direct, no filler.",
    vaultContext: "marioverse.ai vault.",
  };

  it("includes all three source sections and the per-block limits", () => {
    const p = buildSeedPrompt(sources);
    expect(p).toContain("Mario is a 0-to-1 PM.");
    expect(p).toContain("Direct, no filler.");
    expect(p).toContain("marioverse.ai vault.");
    expect(p).toContain("1500"); // persona/now limit
    expect(p).toContain("2000"); // human limit
  });

  it("instructs distillation, not copying", () => {
    expect(buildSeedPrompt(sources).toLowerCase()).toContain("distill");
  });
});

describe("parseSeedBlocks", () => {
  it("parses all three fenced blocks", () => {
    const raw = [
      "<<<persona>>>", "Be terse.", "<<<end-persona>>>",
      "<<<human>>>", "Mario, PM.", "<<<end-human>>>",
      "<<<now>>>", "Shipping identity.", "<<<end-now>>>",
    ].join("\n");
    expect(parseSeedBlocks(raw)).toEqual({
      persona: "Be terse.",
      human: "Mario, PM.",
      now: "Shipping identity.",
    });
  });

  it("omits a missing block rather than inventing it", () => {
    const raw = "<<<persona>>>\nBe terse.\n<<<end-persona>>>";
    const out = parseSeedBlocks(raw);
    expect(out.persona).toBe("Be terse.");
    expect(out.human).toBeUndefined();
    expect(out.now).toBeUndefined();
  });

  it("returns an empty map on garbage and never throws", () => {
    expect(parseSeedBlocks("no fences at all")).toEqual({});
    expect(parseSeedBlocks("")).toEqual({});
  });
});

describe("manifestContent", () => {
  it("documents the block registry and the read-don't-write contract", () => {
    const m = manifestContent();
    expect(m).toContain("persona.md");
    expect(m).toContain("human.md");
    expect(m).toContain("now.md");
    expect(m).toMatch(/read.*don'?t write/i);
    expect(m).toContain("Exo owns maintenance");
  });
});
