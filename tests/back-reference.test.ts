import { describe, it, expect } from "vitest";
import { isBackReference, selectRecall, DEFAULT_RECALL_OPTS, type MemoryEntry } from "../src/core/memory-store";

describe("isBackReference", () => {
  it("flags Italian continuation phrases (the real mis-continuation bug)", () => {
    // "continue with the other proposed things" — the referent is THIS
    // conversation's own thread, not another session's memory.
    expect(isBackReference("Ok, continuiamo con le altre cose proposte")).toBe(true);
    expect(isBackReference("procedi")).toBe(true);
    expect(isBackReference("Prosegui con lo step 2")).toBe(true);
    expect(isBackReference("vai avanti")).toBe(true);
    expect(isBackReference("come sopra")).toBe(true);
    expect(isBackReference("riprendiamo da dove eravamo")).toBe(true);
  });

  it("flags English continuation / back-deixis phrases", () => {
    expect(isBackReference("continue with the rest")).toBe(true);
    expect(isBackReference("go ahead")).toBe(true);
    expect(isBackReference("proceed")).toBe(true);
    expect(isBackReference("as discussed above")).toBe(true);
  });

  it("does NOT flag specific topical queries (recall should still fire)", () => {
    expect(isBackReference("Come funziona il metric tree di DeepAgent?")).toBe(false);
    expect(isBackReference("Scrivi una nota sul churn di DeepAgent")).toBe(false);
    expect(isBackReference("Qual è il pricing di isendu?")).toBe(false);
  });
});

describe("selectRecall skips back-reference queries", () => {
  const entry = (id: string, text: string): MemoryEntry => ({
    id,
    at: 1_700_000_000_000,
    kind: "decision",
    session: "unknown",
    tags: [],
    source: "user",
    text,
  });

  it("returns [] for a back-reference query even when an entry would score high", () => {
    // An entry that BM25-matches "proposte"/"cose" would otherwise be injected —
    // but a continuation phrase must resolve from the current thread, not memory.
    const entries = [
      entry("a", "Abbiamo proposto diverse cose sul metric tree e altre cose ancora da decidere."),
    ];
    const picked = selectRecall(entries, "Ok, continuiamo con le altre cose proposte", new Set(), DEFAULT_RECALL_OPTS);
    expect(picked).toEqual([]);
  });
});
