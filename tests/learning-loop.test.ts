import { describe, it, expect } from "vitest";
import { turnQualifies, buildDistillPrompt, parseDistillReply, uniquePlaybookName } from "../src/core/learning-loop";

const base = { ok: true, toolCount: 8, distinctTools: 3, durationMs: 120_000, userText: "prepara il digest" };

describe("turnQualifies", () => {
  it("qualifies a substantial healthy turn", () => {
    expect(turnQualifies(base)).toBe(true);
  });

  it("rejects unhealthy, small, single-tool, or fast turns", () => {
    expect(turnQualifies({ ...base, ok: false })).toBe(false);
    expect(turnQualifies({ ...base, toolCount: 4 })).toBe(false);
    expect(turnQualifies({ ...base, distinctTools: 1 })).toBe(false);
    expect(turnQualifies({ ...base, durationMs: 10_000 })).toBe(false);
  });

  it("rejects turns that were already a command/playbook run", () => {
    expect(turnQualifies({ ...base, userText: "/morning-digest" })).toBe(false);
    expect(turnQualifies({ ...base, userText: "  /compact keep decisions" })).toBe(false);
  });
});

describe("buildDistillPrompt", () => {
  it("embeds user text, tool lines, and final text, capped", () => {
    const p = buildDistillPrompt({
      userText: "u".repeat(2000),
      toolLines: ["search_vault: gtm", "read_note: Captoo"],
      finalText: "f".repeat(2000),
    });
    expect(p).toContain("search_vault: gtm");
    expect(p).toContain("u".repeat(1200));
    expect(p).not.toContain("u".repeat(1201));
    expect(p).toContain('{"name"');
  });
});

describe("parseDistillReply", () => {
  const good = `{"name": "Vault GTM recon", "prompt": "${"Search the vault for GTM notes, read the project context, then synthesize a plan. ".repeat(2).trim()}"}`;

  it("parses a clean reply", () => {
    const r = parseDistillReply(good);
    expect(r?.name).toBe("Vault GTM recon");
    expect(r?.prompt).toContain("Search the vault");
  });

  it("parses JSON wrapped in prose or fences", () => {
    expect(parseDistillReply("Here you go:\n```json\n" + good + "\n```")).not.toBeNull();
  });

  it("rejects malformed, non-string, too-short, and oversized replies", () => {
    expect(parseDistillReply("no json here")).toBeNull();
    expect(parseDistillReply('{"name": 3, "prompt": "x".repeat}')).toBeNull();
    expect(parseDistillReply('{"name": "x", "prompt": "too short"}')).toBeNull();
    expect(parseDistillReply(`{"name": "x", "prompt": "${"a".repeat(4001)}"}`)).toBeNull();
  });

  it("trims and caps the name", () => {
    const r = parseDistillReply(`{"name": "  ${"n".repeat(80)}  ", "prompt": "${"p".repeat(60)}"}`);
    expect(r?.name.length).toBe(60);
  });
});

describe("uniquePlaybookName", () => {
  it("keeps a free name, suffixes a taken one (case-insensitive)", () => {
    expect(uniquePlaybookName("Digest", ["Other"])).toBe("Digest");
    expect(uniquePlaybookName("Digest", ["digest"])).toBe("Digest 2");
    expect(uniquePlaybookName("Digest", ["digest", "Digest 2"])).toBe("Digest 3");
  });
});
