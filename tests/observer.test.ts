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
  parseNowProposal,
  NOW_UPDATE_OPEN,
  NOW_UPDATE_CLOSE,
  MAX_NOW_PROPOSAL_CHARS,
  type Candidate,
} from "../src/core/observer";
import { formatEntry, parseStoreFile, removeEntriesById, type MemoryEntry } from "../src/core/memory-store";
import { WriteQueue } from "../src/core/write-queue";

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
    const existing = ["The user prefers dark mode in the editor"];
    const cands: Candidate[] = [
      { kind: "preference", text: "The user prefers dark mode in the editor.", tags: [] },
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

/**
 * Undo-exactness: the observer's undo must strip EXACTLY the entry ids it wrote,
 * re-reading the current file — never blind-restore a before-image and never
 * delete the whole file. This is what protects an interleaved @user entry.
 */
describe("removeEntriesById (observer undo primitive)", () => {
  const entry = (id: string, source: "user" | "generated", text: string): MemoryEntry => ({
    id,
    kind: "fact",
    at: Number(id.replace("mem-", "")),
    session: "s",
    tags: [],
    source,
    text,
  });

  it("removes only the named ids, preserving every other block verbatim", () => {
    const user = entry("mem-1000", "user", "The user ships on Fridays");
    const gen1 = entry("mem-2000", "generated", "Observer thought A");
    const gen2 = entry("mem-2001", "generated", "Observer thought B");
    const file = [formatEntry(user), formatEntry(gen1), formatEntry(gen2)].join("\n\n") + "\n";

    const out = removeEntriesById(file, ["mem-2000", "mem-2001"]);

    const parsed = parseStoreFile(out);
    expect(parsed.map((e) => e.id)).toEqual(["mem-1000"]);
    expect(parsed[0].text).toBe("The user ships on Fridays");
    expect(parsed[0].source).toBe("user");
  });

  it("preserves a @user entry that was appended AFTER the observer's blocks (interleaved write)", () => {
    // File existed as X (a user entry) → observer appends B → remember appends R (a @user entry).
    const x = entry("mem-1000", "user", "existing user memory");
    const observerBlock = entry("mem-2000", "generated", "observer generated memory");
    const rememberR = entry("mem-3000", "user", "brand-new user memory R");
    const file =
      [formatEntry(x), formatEntry(observerBlock), formatEntry(rememberR)].join("\n\n") + "\n";

    // Undo strips ONLY the observer's own id.
    const out = removeEntriesById(file, ["mem-2000"]);

    const parsed = parseStoreFile(out);
    expect(parsed.map((e) => e.id)).toEqual(["mem-1000", "mem-3000"]);
    // The user entry R that landed between the append and the undo MUST survive.
    expect(parsed.find((e) => e.id === "mem-3000")?.text).toBe("brand-new user memory R");
    expect(parsed.find((e) => e.id === "mem-2000")).toBeUndefined();
  });

  it("returns an empty string when the file only ever held the removed blocks (observer-created, nothing else)", () => {
    const gen1 = entry("mem-2000", "generated", "only observer entry");
    const file = formatEntry(gen1) + "\n";
    expect(removeEntriesById(file, ["mem-2000"]).trim()).toBe("");
  });

  it("is a no-op for ids not present in the file", () => {
    const user = entry("mem-1000", "user", "keep me");
    const file = formatEntry(user) + "\n";
    expect(parseStoreFile(removeEntriesById(file, ["mem-9999"])).map((e) => e.id)).toEqual(["mem-1000"]);
  });
});

/**
 * Shared-queue regression: a `remember`-style append and an observer append that
 * race on ONE shared WriteQueue must both survive. Two independent queues would
 * interleave their read-modify-write cycles and clobber one of the entries — the
 * exact w1-1 corruption this feature must not reintroduce.
 */
describe("shared WriteQueue serialization (observer vs remember)", () => {
  // Minimal in-memory model of the read-modify-write both writers do on the store file.
  function makeStore() {
    let content = "";
    return {
      // A read-modify-write with an awaited gap between read and write (where a
      // concurrent writer could interleave if not serialized).
      appendVia: (queue: WriteQueue, block: string) =>
        queue.enqueue(async () => {
          const cur = content; // read
          await Promise.resolve(); // <-- yield: gives any concurrent writer a chance
          await Promise.resolve();
          content = cur ? `${cur}\n\n${block}` : block; // modify + write
        }),
      get: () => content,
    };
  }

  it("preserves BOTH entries when observer and remember append on the shared queue", async () => {
    const store = makeStore();
    const shared = new WriteQueue();
    await Promise.all([
      store.appendVia(shared, "REMEMBER @user R"),
      store.appendVia(shared, "OBSERVER @generated B"),
    ]);
    expect(store.get()).toContain("REMEMBER @user R");
    expect(store.get()).toContain("OBSERVER @generated B");
  });

  it("demonstrates the clobber when two SEPARATE queues target the same file (guards against regression)", async () => {
    const store = makeStore();
    const qA = new WriteQueue();
    const qB = new WriteQueue();
    await Promise.all([
      store.appendVia(qA, "REMEMBER @user R"),
      store.appendVia(qB, "OBSERVER @generated B"),
    ]);
    // Independent queues do NOT serialize: one write clobbers the other (lost update).
    const survived =
      Number(store.get().includes("REMEMBER @user R")) +
      Number(store.get().includes("OBSERVER @generated B"));
    expect(survived).toBe(1);
  });
});

/* -------------------- now.md observer proposal (§5) --------------------- */

describe("buildObserverPrompt — now-proposal addition", () => {
  it("is byte-identical to the memory-only form when no nowContext is given", () => {
    const digest = { user: "u text here", assistant: "a text here" };
    expect(buildObserverPrompt(digest)).toBe(buildObserverPrompt(digest, {}));
  });

  it("adds the now-update instruction and the current now.md when nowContext is given", () => {
    const p = buildObserverPrompt(
      { user: "we pivoted to the identity layer", assistant: "noted" },
      { nowContext: "Focus: proactive recall." }
    );
    expect(p).toContain(NOW_UPDATE_OPEN);
    expect(p).toContain(NOW_UPDATE_CLOSE);
    expect(p).toContain("Focus: proactive recall.");
  });

  it("does not mention now.md at all without nowContext", () => {
    const p = buildObserverPrompt({ user: "hi there friend", assistant: "hello" });
    expect(p).not.toContain(NOW_UPDATE_OPEN);
    expect(p).not.toContain("now.md");
  });
});

describe("parseNowProposal", () => {
  it("extracts a fenced now.md rewrite", () => {
    const raw = "[]\n" + NOW_UPDATE_OPEN + "\nFocus: shipping the identity layer.\n" + NOW_UPDATE_CLOSE;
    expect(parseNowProposal(raw)).toEqual({ text: "Focus: shipping the identity layer." });
  });

  it("returns null when there is no fence (zero-noise)", () => {
    expect(parseNowProposal(JSON.stringify([{ kind: "fact", text: "x", tags: [] }]))).toBeNull();
    expect(parseNowProposal("")).toBeNull();
    expect(parseNowProposal("no proposal here")).toBeNull();
  });

  it("returns null for a whitespace-only body", () => {
    expect(parseNowProposal(NOW_UPDATE_OPEN + "   \n  " + NOW_UPDATE_CLOSE)).toBeNull();
  });

  it("returns null for an unterminated fence", () => {
    expect(parseNowProposal(NOW_UPDATE_OPEN + "\nhalf a proposal with no close")).toBeNull();
  });

  it("caps the proposal at MAX_NOW_PROPOSAL_CHARS", () => {
    const big = "z".repeat(MAX_NOW_PROPOSAL_CHARS + 500);
    const raw = NOW_UPDATE_OPEN + big + NOW_UPDATE_CLOSE;
    expect(parseNowProposal(raw)?.text.length).toBe(MAX_NOW_PROPOSAL_CHARS);
  });
});
