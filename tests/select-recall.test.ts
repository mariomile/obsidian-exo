import { describe, it, expect } from "vitest";
import {
  selectRecall,
  DEFAULT_RECALL_OPTS,
  type MemoryEntry,
} from "../src/core/memory-store";

/** A timestamp with a whole-ms ISO representation. */
const T = Date.UTC(2026, 6, 3, 12, 0, 0);

function entry(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: `mem-${T}`,
    kind: "fact",
    at: T,
    session: "sess-1",
    tags: [],
    source: "user",
    text: "verbatim text",
    ...over,
  };
}

/** Baseline opts with a permissive floor so tests exercise the OTHER guards in
 *  isolation; the floor itself gets its own dedicated cases. */
const opts = (over: Partial<typeof DEFAULT_RECALL_OPTS> = {}) => ({
  ...DEFAULT_RECALL_OPTS,
  minScore: 0.0001, // essentially "any positive score" unless a case overrides
  ...over,
});

describe("selectRecall — query-word guard", () => {
  const entries = [
    entry({ id: "mem-1", text: "Mario cofounded Captoo the geo optimization startup" }),
    entry({ id: "mem-2", text: "isendu was acquired by Sendcloud in 2024" }),
  ];

  it("returns [] when the message has fewer than minQueryWords words", () => {
    expect(selectRecall(entries, "Captoo", new Set(), opts({ minQueryWords: 3 }))).toEqual([]);
    expect(selectRecall(entries, "about Captoo", new Set(), opts({ minQueryWords: 3 }))).toEqual([]);
  });

  it("counts word tokens, not raw whitespace splits (punctuation is not a word)", () => {
    // "Captoo?!" is one word; the guard must still see < 3.
    expect(selectRecall(entries, "Captoo?! ...", new Set(), opts({ minQueryWords: 3 }))).toEqual([]);
  });

  it("passes the guard at exactly minQueryWords words", () => {
    const got = selectRecall(entries, "tell me Captoo", new Set(), opts({ minQueryWords: 3 }));
    expect(got.map((e) => e.id)).toContain("mem-1");
  });
});

describe("selectRecall — relevance floor", () => {
  const entries = [
    entry({ id: "mem-1", text: "Mario cofounded Captoo the geo optimization startup" }),
    entry({ id: "mem-2", text: "the sky is often blue on a clear day" }),
  ];

  it("drops entries scoring below minScore even though the recall tool would keep score>0", () => {
    // A query that weakly touches mem-2 via a common word, strongly touches mem-1.
    const got = selectRecall(entries, "Mario Captoo startup founding", new Set(), opts({ minScore: 2.0 }));
    expect(got.map((e) => e.id)).toEqual(["mem-1"]);
  });

  it("returns [] when nothing clears the floor", () => {
    const got = selectRecall(entries, "quantum chromodynamics lagrangian density", new Set(), opts({ minScore: 2.0 }));
    expect(got).toEqual([]);
  });
});

describe("selectRecall — dedup against already-injected", () => {
  const entries = [
    entry({ id: "mem-1", text: "Mario prefers Claude Code and Codex as his main AI tools" }),
    entry({ id: "mem-2", text: "Mario dislikes Haiku for subagent delegation, floor is Sonnet" }),
  ];

  it("skips ids present in alreadyInjected", () => {
    const got = selectRecall(entries, "Mario AI tools delegation", new Set(["mem-1"]), opts());
    expect(got.map((e) => e.id)).not.toContain("mem-1");
  });

  it("returns [] when every match was already injected", () => {
    const got = selectRecall(entries, "Mario AI tools delegation", new Set(["mem-1", "mem-2"]), opts());
    expect(got).toEqual([]);
  });
});

describe("selectRecall — top-k cap", () => {
  const entries = Array.from({ length: 8 }, (_, i) =>
    entry({ id: `mem-${i}`, at: T + i, text: `Mario decision number ${i} about product strategy roadmap` })
  );

  it("returns at most k entries", () => {
    const got = selectRecall(entries, "Mario decision product strategy roadmap", new Set(), opts({ k: 3 }));
    expect(got).toHaveLength(3);
  });

  it("k=0 yields []", () => {
    const got = selectRecall(entries, "Mario decision product strategy roadmap", new Set(), opts({ k: 0 }));
    expect(got).toEqual([]);
  });
});

describe("selectRecall — cumulative char budget", () => {
  it("truncates the LIST, never an entry's text", () => {
    const long = "x".repeat(500);
    const entries = [
      entry({ id: "mem-1", at: T + 2, text: `alpha keyword ${long}` }),
      entry({ id: "mem-2", at: T + 1, text: `alpha keyword ${long}` }),
      entry({ id: "mem-3", at: T + 0, text: `alpha keyword ${long}` }),
    ];
    const got = selectRecall(entries, "alpha keyword recall test", new Set(), opts({ k: 3, maxChars: 800 }));
    // Each entry is ~514 chars, so only the first fits under 800; the list is cut,
    // and no returned entry has a truncated `text`.
    expect(got).toHaveLength(1);
    expect(got[0].text.length).toBeGreaterThan(500); // full, not sliced
  });

  it("keeps as many whole entries as fit the budget", () => {
    const entries = [
      entry({ id: "mem-1", at: T + 2, text: `alpha ${"a".repeat(300)}` }),
      entry({ id: "mem-2", at: T + 1, text: `alpha ${"b".repeat(300)}` }),
      entry({ id: "mem-3", at: T + 0, text: `alpha ${"c".repeat(300)}` }),
    ];
    const got = selectRecall(entries, "alpha keyword recall test", new Set(), opts({ k: 3, maxChars: 700 }));
    // ~306 chars each → two fit under 700, the third is dropped.
    expect(got).toHaveLength(2);
  });
});

describe("selectRecall — supersedence", () => {
  it("excludes an entry that a newer entry supersedes", () => {
    const entries = [
      entry({ id: "mem-old", at: T, text: "Mario uses Cursor as his main editor daily" }),
      entry({ id: "mem-new", at: T + 1000, supersedes: "mem-old", text: "Mario uses Claude Code as his main tool daily" }),
    ];
    const got = selectRecall(entries, "Mario main editor tool daily", new Set(), opts());
    expect(got.map((e) => e.id)).toContain("mem-new");
    expect(got.map((e) => e.id)).not.toContain("mem-old");
  });
});

describe("selectRecall — deterministic ordering", () => {
  it("is stable across calls (score desc, then newest first)", () => {
    const entries = [
      entry({ id: "mem-a", at: T + 1, text: "Mario product roadmap strategy planning session notes" }),
      entry({ id: "mem-b", at: T + 2, text: "Mario product roadmap strategy planning session notes" }),
    ];
    const q = "Mario product roadmap strategy";
    const a = selectRecall(entries, q, new Set(), opts({ k: 2 })).map((e) => e.id);
    const b = selectRecall(entries, q, new Set(), opts({ k: 2 })).map((e) => e.id);
    expect(a).toEqual(b);
    // Equal scores → newest (higher `at`) first.
    expect(a[0]).toBe("mem-b");
  });
});

describe("DEFAULT_RECALL_OPTS", () => {
  it("carries the spec defaults", () => {
    expect(DEFAULT_RECALL_OPTS.k).toBe(3);
    expect(DEFAULT_RECALL_OPTS.minQueryWords).toBe(3);
    expect(DEFAULT_RECALL_OPTS.maxChars).toBe(800);
    expect(DEFAULT_RECALL_OPTS.minScore).toBeGreaterThan(0); // stricter than the recall tool's >0
  });
});

describe("selectRecall — content-word guards (long dictated prompts)", () => {
  // Condensed real-world repro (2026-07-14): a long Italian voice-dictated prompt about a
  // Claude Code playbook recalled DeepAgent memories whose only overlap was stopwords + "uso".
  const offTopic = entry({
    id: "mem-deepagent",
    text: "Ogni agente vocale ha un obiettivo e ogni conversazione ha un esito binario; i casi d'uso principali sono cold calling e customer support",
  });
  const onTopic = entry({
    id: "mem-playbook",
    text: "Il playbook Claude Code per Alberto copre gestione del contesto, skill e integrazioni",
  });
  const LONG =
    "Fai un playbook pratico per un operator che deve usare Claude Code: come gestire il contesto, come usare le skill in base al tipo di caso d'uso, le integrazioni di front-end e di back-end, e per ogni capitolo definiamo un outline";

  it("does not recall an entry sharing only stopwords plus one content word with a long message", () => {
    const got = selectRecall([offTopic, onTopic], LONG, new Set(), opts());
    expect(got.map((e) => e.id)).not.toContain("mem-deepagent");
  });

  it("still recalls entries sharing several content words with the long message", () => {
    const got = selectRecall([offTopic, onTopic], LONG, new Set(), opts());
    expect(got.map((e) => e.id)).toContain("mem-playbook");
  });

  it("keeps single-content-word recall for short queries", () => {
    const got = selectRecall([offTopic, onTopic], "parliamo del cold outreach", new Set(), opts());
    expect(got.map((e) => e.id)).toContain("mem-deepagent");
  });
});
