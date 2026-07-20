import { describe, expect, it } from "vitest";
import {
  buildResearchReceipt,
  buildResearchOutbound,
  initialResearchModeState,
  normalizeResearchModeState,
  parseResearchCommand,
  toggleResearchMode,
} from "../src/core/research";

const NOW = Date.parse("2026-07-20T10:00:00.000Z");

describe("Research Mode contract", () => {
  it("activates from /research and keeps the command out of visible user text", () => {
    const result = parseResearchCommand(
      "  /ReSeArCh   Compare the current approaches  ",
      initialResearchModeState(),
      NOW
    );

    expect(result).toEqual({
      kind: "start",
      question: "Compare the current approaches",
      state: {
        enabled: true,
        startedAt: NOW,
        scope: "both",
        depth: "standard",
      },
    });
  });

  it("does not intercept lookalike slash commands", () => {
    expect(parseResearchCommand(
      "/researcher explain this",
      initialResearchModeState(),
      NOW
    )).toBeNull();
  });

  it("returns a quiet validation result for an empty question", () => {
    expect(parseResearchCommand(
      "/research",
      initialResearchModeState(),
      NOW
    )).toEqual({
      kind: "invalid",
      message: "Add a question after /research.",
    });
  });

  it("supports an explicit exit without producing a chat turn", () => {
    const active = {
      enabled: true,
      startedAt: NOW - 1_000,
      scope: "vault" as const,
      depth: "deep" as const,
    };

    expect(parseResearchCommand("/research off", active, NOW)).toEqual({
      kind: "exit",
      state: { ...active, enabled: false },
    });
    expect(parseResearchCommand("/research exit", active, NOW)).toEqual({
      kind: "exit",
      state: { ...active, enabled: false },
    });
  });

  it("keeps the original start timestamp when a research conversation continues", () => {
    const active = {
      enabled: true,
      startedAt: NOW - 5_000,
      scope: "web" as const,
      depth: "quick" as const,
    };

    expect(parseResearchCommand("/research Follow up", active, NOW)).toMatchObject({
      kind: "start",
      question: "Follow up",
      state: active,
    });
  });

  it("toggles per-conversation state without mutating the prior value", () => {
    const initial = initialResearchModeState();
    const enabled = toggleResearchMode(initial, NOW);

    expect(initial.enabled).toBe(false);
    expect(enabled).toEqual({
      enabled: true,
      startedAt: NOW,
      scope: "both",
      depth: "standard",
    });
    expect(toggleResearchMode(enabled, NOW + 1)).toEqual({
      ...enabled,
      enabled: false,
    });
  });

  it("repairs invalid persisted state to a safe disabled default", () => {
    expect(normalizeResearchModeState({
      enabled: true,
      startedAt: NOW,
      scope: "vault",
      depth: "deep",
    })).toEqual({
      enabled: true,
      startedAt: NOW,
      scope: "vault",
      depth: "deep",
    });
    expect(normalizeResearchModeState({
      enabled: true,
      startedAt: "yesterday",
      scope: "everything",
      depth: "huge",
    })).toEqual(initialResearchModeState());
  });

  it("injects the contract only into outbound provider text", () => {
    const state = {
      enabled: true,
      startedAt: NOW,
      scope: "both" as const,
      depth: "standard" as const,
    };
    const visibleText = "Compare local notes with current primary sources";
    const outbound = buildResearchOutbound(state, visibleText);

    expect(outbound).toContain('<research-mode scope="both" depth="standard">');
    expect(outbound).toContain("consult vault sources and at least one available external source");
    expect(outbound).toContain(visibleText);
    expect(visibleText).not.toContain("research-mode");
    expect(buildResearchOutbound(initialResearchModeState(), visibleText)).toBe(visibleText);
  });
});

describe("Research source receipt", () => {
  const state = (scope: "vault" | "web" | "both") => ({
    enabled: true,
    startedAt: NOW - 1_000,
    scope,
    depth: "standard" as const,
  });
  const available = {
    vault: true,
    web: true,
    mcpServers: [] as { name: string; status: string }[],
  };

  it("records a vault-only run and marks web as skipped by scope", () => {
    const receipt = buildResearchReceipt({
      state: state("vault"),
      completedAt: NOW,
      availability: available,
      tools: [{
        name: "mcp__obsidian__read_note",
        input: { target: "[[Active/Project Alpha]]" },
        ok: true,
      }],
    });

    expect(receipt.status).toBe("complete");
    expect(receipt.sources).toEqual([
      { kind: "vault", label: "Active/Project Alpha", status: "consulted" },
      { kind: "web", label: "Web sources", status: "skipped", detail: "Outside selected scope" },
    ]);
  });

  it("records a web-only run and marks vault as skipped by scope", () => {
    const receipt = buildResearchReceipt({
      state: state("web"),
      completedAt: NOW,
      availability: available,
      tools: [{ name: "WebSearch", input: { query: "current standard" }, ok: true }],
    });

    expect(receipt.status).toBe("complete");
    expect(receipt.sources).toEqual([
      { kind: "vault", label: "Vault sources", status: "skipped", detail: "Outside selected scope" },
      { kind: "web", label: "current standard", status: "consulted" },
    ]);
  });

  it("requires both source classes and preserves a partial web failure", () => {
    const receipt = buildResearchReceipt({
      state: state("both"),
      completedAt: NOW,
      availability: available,
      tools: [
        { name: "Read", input: { file_path: "Notes/Local.md" }, ok: true },
        { name: "WebFetch", input: { url: "https://example.com/source" }, ok: false },
      ],
    });

    expect(receipt.status).toBe("partial");
    expect(receipt.sources).toEqual([
      { kind: "vault", label: "Notes/Local.md", status: "consulted" },
      { kind: "web", label: "https://example.com/source", status: "failed" },
    ]);
  });

  it("marks a required source unavailable instead of claiming completion", () => {
    const receipt = buildResearchReceipt({
      state: state("both"),
      completedAt: NOW,
      availability: { ...available, web: false },
      tools: [{ name: "Grep", input: { pattern: "evidence" }, ok: true }],
    });

    expect(receipt.status).toBe("partial");
    expect(receipt.sources.at(-1)).toEqual({
      kind: "web",
      label: "Web sources",
      status: "unavailable",
      detail: "No observable web capability",
    });
  });

  it("records read-only external MCP sources without persisting their arguments", () => {
    const receipt = buildResearchReceipt({
      state: state("both"),
      completedAt: NOW,
      availability: {
        ...available,
        mcpServers: [{ name: "Readwise", status: "connected" }],
      },
      tools: [
        { name: "mcp__obsidian__search_vault", input: { query: "private query" }, ok: true },
        { name: "WebSearch", input: { query: "public query" }, ok: true },
        {
          name: "mcp__claude_ai_Readwise__search",
          input: { query: "sensitive connector query" },
          ok: true,
        },
      ],
    });

    expect(receipt.status).toBe("complete");
    expect(receipt.sources).toContainEqual({
      kind: "mcp",
      label: "claude_ai_Readwise: search",
      status: "consulted",
    });
    expect(JSON.stringify(receipt)).not.toContain("sensitive connector query");
  });

  it("reports no-sources when no requested class was actually consulted", () => {
    const receipt = buildResearchReceipt({
      state: state("both"),
      completedAt: NOW,
      availability: available,
      tools: [],
    });

    expect(receipt.status).toBe("no-sources");
    expect(receipt.sources.map((source) => source.status)).toEqual(["skipped", "skipped"]);
  });
});
