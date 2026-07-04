import { describe, it, expect } from "vitest";
import { parseCustomModels, modelOptions } from "../src/core/model-options";
import type { ModelOption } from "../src/providers/types";

const BUILTINS: ModelOption[] = [
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
];

describe("parseCustomModels", () => {
  it("splits on commas and newlines, trimming blanks", () => {
    expect(parseCustomModels("a, b\nc ,  \n d")).toEqual(["a", "b", "c", "d"]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parseCustomModels("")).toEqual([]);
    expect(parseCustomModels("  \n , ")).toEqual([]);
  });
});

describe("modelOptions", () => {
  it("returns the built-ins when there are no custom models", () => {
    expect(modelOptions(BUILTINS, "")).toEqual(BUILTINS);
  });

  it("appends custom ids after the built-ins, using the id as the label", () => {
    expect(modelOptions(BUILTINS, "claude-sonnet-5\nmy-model")).toEqual([
      { id: "claude-fable-5", label: "Fable 5" },
      { id: "claude-opus-4-8", label: "Opus 4.8" },
      { id: "claude-sonnet-5", label: "claude-sonnet-5" },
      { id: "my-model", label: "my-model" },
    ]);
  });

  it("dedupes a custom id that repeats a built-in (built-in label wins)", () => {
    expect(modelOptions(BUILTINS, "claude-fable-5, brand-new")).toEqual([
      { id: "claude-fable-5", label: "Fable 5" },
      { id: "claude-opus-4-8", label: "Opus 4.8" },
      { id: "brand-new", label: "brand-new" },
    ]);
  });

  it("dedupes repeated custom ids", () => {
    expect(modelOptions([], "x, x, y")).toEqual([
      { id: "x", label: "x" },
      { id: "y", label: "y" },
    ]);
  });
});
