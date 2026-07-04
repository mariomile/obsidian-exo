import { describe, it, expect } from "vitest";
import {
  matchesQuery,
  buildOptionRows,
  visibleOptions,
  type SelectOption,
} from "../src/core/option-filter";

const OPTS: SelectOption[] = [
  { value: "claude-opus-4-8", label: "Opus 4.8", group: "Claude" },
  { value: "claude-sonnet-5", label: "Sonnet 5", group: "Claude" },
  { value: "gpt-5-codex", label: "GPT-5 Codex", group: "Codex" },
  { value: "o4-mini", label: "o4-mini", group: "Codex" },
];

describe("matchesQuery", () => {
  it("matches on label and value, case-insensitive", () => {
    expect(matchesQuery(OPTS[0], "opus")).toBe(true);
    expect(matchesQuery(OPTS[0], "OPUS")).toBe(true);
    expect(matchesQuery(OPTS[0], "4-8")).toBe(true);
    expect(matchesQuery(OPTS[0], "sonnet")).toBe(false);
  });
  it("empty / whitespace query matches everything", () => {
    expect(matchesQuery(OPTS[0], "")).toBe(true);
    expect(matchesQuery(OPTS[0], "   ")).toBe(true);
  });
});

describe("buildOptionRows", () => {
  it("emits a header when a group first appears, in source order", () => {
    const rows = buildOptionRows(OPTS, "");
    expect(rows.map((r) => (r.kind === "header" ? `#${r.group}` : r.option.value))).toEqual([
      "#Claude",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "#Codex",
      "gpt-5-codex",
      "o4-mini",
    ]);
  });
  it("drops a header whose group has no visible option after filtering", () => {
    const rows = buildOptionRows(OPTS, "codex");
    expect(rows.map((r) => (r.kind === "header" ? `#${r.group}` : r.option.value))).toEqual([
      "#Codex",
      "gpt-5-codex",
    ]);
    // No Claude header survives.
    expect(rows.some((r) => r.kind === "header" && r.group === "Claude")).toBe(false);
  });
  it("emits no headers for ungrouped options (other pickers unaffected)", () => {
    const flat: SelectOption[] = [
      { value: "low", label: "Low" },
      { value: "high", label: "High" },
    ];
    const rows = buildOptionRows(flat, "");
    expect(rows.every((r) => r.kind === "option")).toBe(true);
    expect(rows).toHaveLength(2);
  });
});

describe("visibleOptions", () => {
  it("returns filtered options without headers, in order", () => {
    expect(visibleOptions(OPTS, "5").map((o) => o.value)).toEqual([
      "claude-sonnet-5",
      "gpt-5-codex",
    ]);
    expect(visibleOptions(OPTS, "")).toHaveLength(4);
  });
});
