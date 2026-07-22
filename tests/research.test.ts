import { describe, expect, it } from "vitest";
import {
  buildResearchOutbound,
  initialResearchModeState,
  normalizeResearchModeState,
  parseResearchCommand,
  toggleResearchMode,
  type ResearchModeState,
} from "../src/core/research";

describe("Research Mode contract", () => {
  it("activates from /research and keeps the command out of visible user text", () => {
    const result = parseResearchCommand(
      "/research what changed in EU AI act enforcement?",
      initialResearchModeState(),
      1000
    );
    expect(result).toEqual({
      kind: "start",
      question: "what changed in EU AI act enforcement?",
      state: { enabled: true, startedAt: 1000 },
    });
  });

  it("does not intercept lookalike slash commands", () => {
    expect(parseResearchCommand("/researcher notes", initialResearchModeState(), 1)).toBeNull();
    expect(parseResearchCommand("tell me about /research", initialResearchModeState(), 1)).toBeNull();
  });

  it("returns a quiet validation result for an empty question", () => {
    const result = parseResearchCommand("/research", initialResearchModeState(), 1);
    expect(result?.kind).toBe("invalid");
  });

  it("supports an explicit exit without producing a chat turn", () => {
    const active: ResearchModeState = { enabled: true, startedAt: 5 };
    const result = parseResearchCommand("/research off", active, 9);
    expect(result).toEqual({ kind: "exit", state: { enabled: false, startedAt: 5 } });
  });

  it("keeps the original start timestamp when a research conversation continues", () => {
    const active: ResearchModeState = { enabled: true, startedAt: 5 };
    const result = parseResearchCommand("/research follow-up", active, 900);
    expect(result?.kind === "start" && result.state.startedAt).toBe(5);
  });

  it("toggles per-conversation state without mutating the prior value", () => {
    const before = initialResearchModeState();
    const on = toggleResearchMode(before, 42);
    expect(before.enabled).toBe(false);
    expect(on).toEqual({ enabled: true, startedAt: 42 });
    expect(toggleResearchMode(on, 99)).toEqual({ enabled: false, startedAt: 42 });
  });

  it("repairs invalid persisted state to a safe disabled default", () => {
    expect(normalizeResearchModeState(null)).toEqual({ enabled: false, startedAt: 0 });
    expect(normalizeResearchModeState({ enabled: "yes" })).toEqual({ enabled: false, startedAt: 0 });
    expect(normalizeResearchModeState({ enabled: true, startedAt: -3 }))
      .toEqual({ enabled: false, startedAt: 0 });
  });

  it("drops pre-v2 scope/depth extras while keeping a valid core state", () => {
    const normalized = normalizeResearchModeState({
      enabled: true,
      startedAt: 7,
      scope: "both",
      depth: "deep",
    });
    expect(normalized).toEqual({ enabled: true, startedAt: 7 });
  });

  it("injects the deep-research workflow contract only when enabled", () => {
    const off = buildResearchOutbound({ enabled: false, startedAt: 0 }, "hello");
    expect(off).toBe("hello");
    const on = buildResearchOutbound({ enabled: true, startedAt: 1 }, "hello");
    expect(on).toContain('name: "deep-research"');
    expect(on).toContain("Sources");
    expect(on).toContain("read operations");
    expect(on.endsWith("\n\nhello")).toBe(true);
  });
});
