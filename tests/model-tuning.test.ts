import { describe, expect, test } from "vitest";
import { clampEffort, effortOptionsFor } from "../src/core/model-tuning";

/** Effort tiers are a consequence of the chosen model (per the claude-api
 *  reference, 2026-07): xhigh exists on Opus 4.7+/Fable 5/Sonnet 5; max on
 *  Opus 4.6+/Sonnet 4.6+; Haiku 4.5 rejects effort entirely; Codex's
 *  model_reasoning_effort has no "max". */
describe("effortOptionsFor", () => {
  const values = (provider: string, model: string) =>
    effortOptionsFor(provider as "claude" | "codex", model)?.map(([v]) => v) ?? null;

  test("frontier Claude models get the full ladder", () => {
    for (const m of ["claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5"]) {
      expect(values("claude", m)).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
    }
  });

  test("Opus 4.6 and Sonnet 4.6 lack xhigh but keep max", () => {
    expect(values("claude", "claude-opus-4-6")).toEqual(["default", "low", "medium", "high", "max"]);
    expect(values("claude", "claude-sonnet-4-6")).toEqual(["default", "low", "medium", "high", "max"]);
  });

  test("Haiku does not support effort — control hidden", () => {
    expect(values("claude", "claude-haiku-4-5")).toBeNull();
    expect(values("claude", "claude-haiku-4-5-20251001")).toBeNull();
  });

  test("unknown/custom Claude ids and the CLI default get the full ladder", () => {
    expect(values("claude", "claude-nova-6")).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
    expect(values("claude", "")).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
    expect(values("claude", "default")).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
  });

  test("Codex models have no max tier", () => {
    expect(values("codex", "gpt-5.5")).toEqual(["default", "low", "medium", "high", "xhigh"]);
    expect(values("codex", "gpt-5-codex")).toEqual(["default", "low", "medium", "high", "xhigh"]);
  });
});

describe("clampEffort", () => {
  test("keeps a valid effort", () => {
    expect(clampEffort("high", effortOptionsFor("claude", "claude-opus-4-8"))).toBe("high");
  });

  test("falls back to default when the tier is not offered by the model", () => {
    expect(clampEffort("max", effortOptionsFor("codex", "gpt-5.5"))).toBe("default");
    expect(clampEffort("xhigh", effortOptionsFor("claude", "claude-sonnet-4-6"))).toBe("default");
  });

  test("falls back to default when the control is hidden", () => {
    expect(clampEffort("high", effortOptionsFor("claude", "claude-haiku-4-5"))).toBe("default");
  });
});
