import { describe, it, expect } from "vitest";
import {
  parseProposals,
  parseKnownFalse,
  runGate,
  proposalKey,
  summarizeProposals,
  formatDreamSummary,
  planLlmWrites,
  type Proposal,
  type GateContext,
} from "../src/core/dream-proposals";
import type { MemoryEntry } from "../src/core/memory-store";

/* ------------------------------- fixtures ------------------------------- */

const merge: Proposal = { kind: "merge", keepId: "mem-1", dropIds: ["mem-2", "mem-3"], reason: "dupes" };
const supersede: Proposal = { kind: "supersede", newText: "new truth", supersedesId: "mem-4", reason: "changed" };
const ruleDraft: Proposal = { kind: "rule_draft", slug: "ship-fridays", text: "Ship on Fridays.", evidenceIds: ["mem-5"], reason: "seen 3x" };
const imp: Proposal = { kind: "import", claudememId: 77, text: "durable observation", reason: "worth keeping" };

function entry(over: Partial<MemoryEntry>): MemoryEntry {
  return { id: "mem-x", kind: "fact", at: 1000, session: "s", tags: [], source: "generated", text: "t", ...over };
}

/* ------------------------------ parsing --------------------------------- */

describe("parseProposals", () => {
  it("parses a well-formed batch of all four kinds", () => {
    const raw = JSON.stringify({ proposals: [merge, supersede, ruleDraft, imp] });
    const res = parseProposals(raw);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.proposals).toEqual([merge, supersede, ruleDraft, imp]);
  });

  it("extracts the JSON object out of prose / code fences", () => {
    const raw = "Here you go:\n```json\n" + JSON.stringify({ proposals: [imp] }) + "\n```\nThanks!";
    const res = parseProposals(raw);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.proposals).toEqual([imp]);
  });

  it("accepts an empty proposals array (nothing to do)", () => {
    const res = parseProposals(JSON.stringify({ proposals: [] }));
    expect(res).toEqual({ ok: true, proposals: [] });
  });

  it("REJECTS THE WHOLE BATCH when any item has an unknown kind", () => {
    const raw = JSON.stringify({ proposals: [imp, { kind: "nuke", id: 1 }] });
    const res = parseProposals(raw);
    expect(res.ok).toBe(false);
  });

  it("rejects the whole batch when a merge is missing dropIds", () => {
    const raw = JSON.stringify({ proposals: [{ kind: "merge", keepId: "mem-1", reason: "x" }] });
    expect(parseProposals(raw).ok).toBe(false);
  });

  it("rejects the whole batch when a merge has an empty dropIds array", () => {
    const raw = JSON.stringify({ proposals: [{ kind: "merge", keepId: "mem-1", dropIds: [], reason: "x" }] });
    expect(parseProposals(raw).ok).toBe(false);
  });

  it("rejects the whole batch when supersede newText is blank", () => {
    const raw = JSON.stringify({ proposals: [{ kind: "supersede", newText: "  ", supersedesId: "mem-4", reason: "x" }] });
    expect(parseProposals(raw).ok).toBe(false);
  });

  it("rejects the whole batch when import claudememId is not a number", () => {
    const raw = JSON.stringify({ proposals: [{ kind: "import", claudememId: "77", text: "t", reason: "x" }] });
    expect(parseProposals(raw).ok).toBe(false);
  });

  it("rejects non-JSON output (never throws)", () => {
    expect(parseProposals("the model refused").ok).toBe(false);
    expect(parseProposals("").ok).toBe(false);
  });

  it("rejects a top-level object without a proposals array", () => {
    expect(parseProposals(JSON.stringify({ notProposals: [] })).ok).toBe(false);
  });
});

/* --------------------------- known-false parse -------------------------- */

describe("parseKnownFalse", () => {
  it("parses one tolerant regex per non-blank, non-comment line", () => {
    const md = `# Truth firewall patterns\n\nfounded ExampleCo\ntwo exits?\n\n# comment ignored`;
    const pats = parseKnownFalse(md);
    expect(pats.some((r) => r.test("The user founded ExampleCo in 2020"))).toBe(true);
    expect(pats.some((r) => r.test("he had two exit events"))).toBe(true);
  });

  it("skips malformed regex lines instead of crashing", () => {
    const md = `valid pattern\n[unclosed(group\nanother valid`;
    const pats = parseKnownFalse(md);
    // The two valid lines compile; the malformed one is dropped.
    expect(pats).toHaveLength(2);
  });

  it("returns [] for empty/whitespace content", () => {
    expect(parseKnownFalse("")).toEqual([]);
    expect(parseKnownFalse("\n\n  \n")).toEqual([]);
  });

  it("is case-insensitive", () => {
    const pats = parseKnownFalse("cofounded sampleco");
    expect(pats[0].test("The user COFOUNDED SAMPLECO")).toBe(true);
  });
});

/* -------------------------------- gate ---------------------------------- */

function ctx(over: Partial<GateContext> = {}): GateContext {
  return { userEntryIds: new Set(), knownFalse: [], appliedKeys: new Set(), ...over };
}

describe("runGate — negative selection", () => {
  it("keeps clean proposals untouched", () => {
    const res = runGate([merge, supersede, ruleDraft, imp], ctx());
    expect(res.kept).toEqual([merge, supersede, ruleDraft, imp]);
    expect(res.culled).toEqual([]);
  });

  it("(a) culls a merge that would merge away a @user entry (dropId)", () => {
    const res = runGate([merge], ctx({ userEntryIds: new Set(["mem-2"]) }));
    expect(res.kept).toEqual([]);
    expect(res.culled).toHaveLength(1);
    expect(res.culled[0].reason).toMatch(/user/i);
  });

  it("(a) culls a merge whose keepId is a @user entry", () => {
    const res = runGate([merge], ctx({ userEntryIds: new Set(["mem-1"]) }));
    expect(res.kept).toEqual([]);
  });

  it("(a) culls a supersede that supersedes a @user entry", () => {
    const res = runGate([supersede], ctx({ userEntryIds: new Set(["mem-4"]) }));
    expect(res.kept).toEqual([]);
    expect(res.culled[0].reason).toMatch(/user/i);
  });

  it("(a) does NOT cull import/rule_draft for user ids (they never supersede)", () => {
    const res = runGate([imp, ruleDraft], ctx({ userEntryIds: new Set(["mem-5", "mem-77"]) }));
    expect(res.kept).toEqual([imp, ruleDraft]);
  });

  it("(b) culls a proposal whose text matches a known-false pattern", () => {
    const bad: Proposal = { kind: "import", claudememId: 9, text: "The user founded ExampleCo", reason: "x" };
    const res = runGate([bad, imp], ctx({ knownFalse: parseKnownFalse("founded ExampleCo") }));
    expect(res.kept).toEqual([imp]);
    expect(res.culled).toHaveLength(1);
    expect(res.culled[0].reason).toMatch(/known-false/i);
  });

  it("(b) culls a supersede whose newText matches a known-false pattern", () => {
    const bad: Proposal = { kind: "supersede", newText: "he had two exits", supersedesId: "mem-8", reason: "x" };
    const res = runGate([bad], ctx({ knownFalse: parseKnownFalse("two exits") }));
    expect(res.kept).toEqual([]);
  });

  it("(c) culls a proposal whose key duplicates an already-applied one", () => {
    const res = runGate([imp], ctx({ appliedKeys: new Set([proposalKey(imp)]) }));
    expect(res.kept).toEqual([]);
    expect(res.culled[0].reason).toMatch(/already applied/i);
  });

  it("culls each bad proposal for its own reason in one pass", () => {
    const bad: Proposal = { kind: "import", claudememId: 9, text: "founded ExampleCo", reason: "x" };
    const res = runGate([merge, supersede, bad, imp], ctx({
      userEntryIds: new Set(["mem-2"]),
      knownFalse: parseKnownFalse("founded ExampleCo"),
      appliedKeys: new Set([proposalKey(supersede)]),
    }));
    expect(res.kept).toEqual([imp]);
    expect(res.culled.map((c) => c.proposal)).toEqual([merge, supersede, bad]);
  });
});

/* ------------------------------ summary --------------------------------- */

describe("summarizeProposals + formatDreamSummary", () => {
  it("counts by kind", () => {
    expect(summarizeProposals([merge, merge, supersede, imp, imp, imp, ruleDraft])).toEqual({
      merged: 2,
      superseded: 1,
      ruleDrafts: 1,
      imported: 3,
    });
  });

  it("formats a descriptive commit summary, omitting zero parts", () => {
    expect(formatDreamSummary({ merged: 3, superseded: 1, ruleDrafts: 0, imported: 12 })).toBe(
      "dream — merged 3, superseded 1, imported 12 from claude-mem"
    );
  });

  it("formats a rule-draft-only summary", () => {
    expect(formatDreamSummary({ merged: 0, superseded: 0, ruleDrafts: 2, imported: 0 })).toBe(
      "dream — drafted 2 rule candidates"
    );
  });

  it("falls back to a generic phrase when nothing was applied", () => {
    expect(formatDreamSummary({ merged: 0, superseded: 0, ruleDrafts: 0, imported: 0 })).toBe("dream — no changes");
  });
});

/* ---------------------------- planLlmWrites ----------------------------- */

describe("planLlmWrites", () => {
  const storeEntries: MemoryEntry[] = [
    entry({ id: "mem-1", kind: "preference", tags: ["a"], text: "keep this", source: "user" }),
    entry({ id: "mem-2", text: "dupe" }),
    entry({ id: "mem-4", kind: "decision", tags: ["b"], text: "old decision" }),
  ];

  it("maps a merge to one consolidated @generated entry superseding the whole group", () => {
    const plan = planLlmWrites([merge], { now: 5000, session: "sx", storeEntries });
    expect(plan.storeEntries).toHaveLength(1);
    const e = plan.storeEntries[0];
    expect(e.source).toBe("generated");
    expect(e.supersedes).toBe("mem-1, mem-2, mem-3");
    expect(e.text).toBe("keep this"); // survivor's verbatim text
    expect(e.kind).toBe("preference"); // survivor's kind
    expect(plan.summary.merged).toBe(1);
  });

  it("maps a supersede to a @generated entry inheriting the target's kind/tags", () => {
    const plan = planLlmWrites([supersede], { now: 5000, session: "sx", storeEntries });
    const e = plan.storeEntries[0];
    expect(e).toMatchObject({ source: "generated", supersedes: "mem-4", text: "new truth", kind: "decision" });
    expect(e.tags).toEqual(["b"]);
  });

  it("maps an import to a @generated entry carrying claude-mem provenance", () => {
    const plan = planLlmWrites([imp], { now: 5000, session: "sx", storeEntries });
    const e = plan.storeEntries[0];
    expect(e).toMatchObject({ source: "generated", origin: "claude-mem:77", text: "durable observation" });
    expect(e.supersedes).toBeUndefined();
    expect(plan.importedIds).toEqual([77]);
  });

  it("maps a rule_draft to a learnings file, not a store entry", () => {
    const plan = planLlmWrites([ruleDraft], { now: 5000, session: "sx", storeEntries });
    expect(plan.storeEntries).toEqual([]);
    expect(plan.ruleDrafts).toEqual([{ slug: "ship-fridays", text: "Ship on Fridays.", evidenceIds: ["mem-5"] }]);
  });

  it("assigns unique, ordered ids to store entries in one batch", () => {
    const plan = planLlmWrites([supersede, imp], { now: 5000, session: "sx", storeEntries });
    const ids = plan.storeEntries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("records a proposalKey for every applied proposal (for dedup on the next run)", () => {
    const plan = planLlmWrites([merge, imp], { now: 5000, session: "sx", storeEntries });
    expect(plan.keys).toEqual([proposalKey(merge), proposalKey(imp)]);
  });

  it("skips a merge whose survivor is missing from the store (defensive)", () => {
    const plan = planLlmWrites(
      [{ kind: "merge", keepId: "mem-gone", dropIds: ["mem-2"], reason: "x" }],
      { now: 5000, session: "sx", storeEntries }
    );
    expect(plan.storeEntries).toEqual([]);
    expect(plan.summary.merged).toBe(0);
  });
});
