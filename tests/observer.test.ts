import { describe, it, expect } from "vitest";
import {
  buildObserverPrompt,
  parseObserverOutput,
  shouldSkipTurn,
  dedupeCandidates,
  MAX_USER_CHARS,
  MAX_ASSISTANT_CHARS,
  MAX_CANDIDATES,
  MAX_CANDIDATE_TEXT_CHARS,
  MIN_TURN_CHARS,
  type Candidate,
} from "../src/core/observer";

describe("buildObserverPrompt", () => {
  it("includes both the user and assistant text", () => {
    const p = buildObserverPrompt({ user: "I always ship on Fridays", assistant: "Noted, Friday shipping it is" });
    expect(p).toContain("I always ship on Fridays");
    expect(p).toContain("Noted, Friday shipping it is");
  });

  it("lists all four valid kinds in the instructions", () => {
    const p = buildObserverPrompt({ user: "hi", assistant: "hello" });
    for (const kind of ["preference", "fact", "decision", "lesson"]) {
      expect(p).toContain(kind);
    }
  });

  it("caps the user text at MAX_USER_CHARS", () => {
    const longUser = "u".repeat(MAX_USER_CHARS + 500);
    const p = buildObserverPrompt({ user: longUser, assistant: "ok" });
    // The verbatim run of 'u' must not exceed the cap.
    const run = p.match(/u+/)?.[0] ?? "";
    expect(run.length).toBeLessThanOrEqual(MAX_USER_CHARS);
  });

  it("caps the assistant text at MAX_ASSISTANT_CHARS", () => {
    const longAsst = "a".repeat(MAX_ASSISTANT_CHARS + 500);
    const p = buildObserverPrompt({ user: "ok", assistant: longAsst });
    const run = p.match(/a+/)?.[0] ?? "";
    expect(run.length).toBeLessThanOrEqual(MAX_ASSISTANT_CHARS);
  });
});

describe("parseObserverOutput", () => {
  it("parses a clean JSON array", () => {
    const raw = JSON.stringify([
      { kind: "preference", text: "Prefers TypeScript", tags: ["lang"] },
      { kind: "fact", text: "Ships on Fridays", tags: [] },
    ]);
    const out = parseObserverOutput(raw);
    expect(out).toEqual<Candidate[]>([
      { kind: "preference", text: "Prefers TypeScript", tags: ["lang"] },
      { kind: "fact", text: "Ships on Fridays", tags: [] },
    ]);
  });

  it("parses JSON wrapped in a code fence", () => {
    const raw = "```json\n" + JSON.stringify([{ kind: "decision", text: "Use Vitest", tags: ["tooling"] }]) + "\n```";
    const out = parseObserverOutput(raw);
    expect(out).toEqual<Candidate[]>([{ kind: "decision", text: "Use Vitest", tags: ["tooling"] }]);
  });

  it("parses JSON embedded in prose", () => {
    const raw =
      'Here are the candidate memories I found:\n[{"kind":"lesson","text":"Always run tests first","tags":["tdd"]}]\nHope that helps!';
    const out = parseObserverOutput(raw);
    expect(out).toEqual<Candidate[]>([{ kind: "lesson", text: "Always run tests first", tags: ["tdd"] }]);
  });

  it("parses a simple line-based format", () => {
    const raw = ["preference: Prefers dark mode | ui, theme", "- [fact] The build runs on CI"].join("\n");
    const out = parseObserverOutput(raw);
    expect(out).toEqual<Candidate[]>([
      { kind: "preference", text: "Prefers dark mode", tags: ["ui", "theme"] },
      { kind: "fact", text: "The build runs on CI", tags: [] },
    ]);
  });

  it("returns [] on garbage", () => {
    expect(parseObserverOutput("this is just prose, no memories at all")).toEqual([]);
    expect(parseObserverOutput("")).toEqual([]);
    expect(parseObserverOutput("{not: valid json")).toEqual([]);
  });

  it("drops candidates with an invalid kind", () => {
    const raw = JSON.stringify([
      { kind: "preference", text: "keep me", tags: [] },
      { kind: "gossip", text: "drop me", tags: [] },
    ]);
    expect(parseObserverOutput(raw)).toEqual<Candidate[]>([{ kind: "preference", text: "keep me", tags: [] }]);
  });

  it("drops candidates with empty text", () => {
    const raw = JSON.stringify([
      { kind: "fact", text: "   ", tags: [] },
      { kind: "fact", text: "real", tags: [] },
    ]);
    expect(parseObserverOutput(raw)).toEqual<Candidate[]>([{ kind: "fact", text: "real", tags: [] }]);
  });

  it("enforces the max-candidates cap", () => {
    const many = Array.from({ length: MAX_CANDIDATES + 3 }, (_, i) => ({
      kind: "fact",
      text: `fact number ${i}`,
      tags: [],
    }));
    expect(parseObserverOutput(JSON.stringify(many)).length).toBe(MAX_CANDIDATES);
  });

  it("truncates candidate text to the per-candidate cap", () => {
    const raw = JSON.stringify([{ kind: "fact", text: "x".repeat(MAX_CANDIDATE_TEXT_CHARS + 200), tags: [] }]);
    const out = parseObserverOutput(raw);
    expect(out[0].text.length).toBeLessThanOrEqual(MAX_CANDIDATE_TEXT_CHARS);
  });

  it("coerces a non-array tags field to an empty array", () => {
    const raw = JSON.stringify([{ kind: "fact", text: "hi", tags: "notarray" }]);
    expect(parseObserverOutput(raw)).toEqual<Candidate[]>([{ kind: "fact", text: "hi", tags: [] }]);
  });
});

describe("shouldSkipTurn", () => {
  it("skips a turn below the minimum combined length", () => {
    expect(shouldSkipTurn({ user: "hi", assistant: "ok" })).toBe(true);
  });

  it("skips when either side is empty", () => {
    expect(shouldSkipTurn({ user: "", assistant: "a".repeat(MIN_TURN_CHARS + 10) })).toBe(true);
    expect(shouldSkipTurn({ user: "a".repeat(MIN_TURN_CHARS + 10), assistant: "" })).toBe(true);
  });

  it("skips a pure slash-command turn", () => {
    expect(shouldSkipTurn({ user: "/help", assistant: "a".repeat(MIN_TURN_CHARS + 10) })).toBe(true);
  });

  it("does not skip a normal, substantive turn", () => {
    expect(
      shouldSkipTurn({
        user: "Remember that I always deploy to production only on Tuesday mornings before standup.",
        assistant: "Got it — Tuesday-morning-only production deploys, before standup. I'll keep that in mind.",
      })
    ).toBe(false);
  });
});

describe("dedupeCandidates", () => {
  const novel: Candidate = { kind: "decision", text: "The project ships in Q3", tags: [] };

  it("drops a candidate that near-duplicates an existing entry", () => {
    const existing = ["Mario prefers dark mode in the editor"];
    const cands: Candidate[] = [
      { kind: "preference", text: "Mario prefers dark mode in the editor.", tags: [] },
      novel,
    ];
    expect(dedupeCandidates(cands, existing)).toEqual([novel]);
  });

  it("keeps a fully novel candidate", () => {
    expect(dedupeCandidates([novel], ["something entirely unrelated about billing"])).toEqual([novel]);
  });

  it("de-duplicates within the candidate list itself", () => {
    const a: Candidate = { kind: "fact", text: "The sky is blue today", tags: [] };
    const b: Candidate = { kind: "fact", text: "The sky is blue today!", tags: [] };
    expect(dedupeCandidates([a, b], [])).toEqual([a]);
  });
});
