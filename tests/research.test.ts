import { describe, expect, it } from "vitest";
import {
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
