import { describe, it, expect } from "vitest";
import {
  ledgerFileName,
  agentRunId,
  serializeAgentRun,
  parseAgentLedger,
  sortRuns,
  runsForAgent,
  attributionChain,
  agentMemoryPath,
  initialAgentMemory,
  agentMemoryExcerpt,
  type AgentRunRecord,
} from "../src/core/agent-ledger";

const iso = (s: string) => Date.parse(s);

const record = (over: Partial<AgentRunRecord> = {}): AgentRunRecord => ({
  id: "2026-08-01T09:00:00.000Z·ghostwriter",
  slug: "ghostwriter",
  name: "Ghostwriter",
  startedAt: iso("2026-08-01T09:00:00.000Z"),
  durationMs: 42_000,
  outcome: "ok",
  trigger: "daily 08:00",
  tier: "act",
  report: "_system/reports/run.md",
  writes: ["Posts/a.md", "Posts/b.md"],
  by: "exo",
  ...over,
});

describe("ledgerFileName", () => {
  it("buckets by UTC month, zero-padded", () => {
    expect(ledgerFileName(iso("2026-08-01T00:00:00Z"))).toBe("2026-08.md");
    expect(ledgerFileName(iso("2026-12-31T23:59:59Z"))).toBe("2026-12.md");
  });
});

describe("agentRunId", () => {
  it("is sortable and carries the agent", () => {
    expect(agentRunId("gw", iso("2026-08-01T09:00:00Z"))).toBe("2026-08-01T09:00:00.000Z·gw");
  });
});

describe("serialize → parse round trip", () => {
  it("preserves every field", () => {
    const original = record();
    const [back] = parseAgentLedger(serializeAgentRun(original));
    expect(back).toEqual(original);
  });

  it("round-trips a summary", () => {
    const original = record({ summary: "Drafted 2 posts, nothing else needed doing." });
    const [back] = parseAgentLedger(serializeAgentRun(original));
    expect(back.summary).toBe("Drafted 2 posts, nothing else needed doing.");
  });

  it("round-trips an empty write list", () => {
    const [back] = parseAgentLedger(serializeAgentRun(record({ writes: [] })));
    expect(back.writes).toEqual([]);
  });

  it("round-trips a run with no report", () => {
    const original = record({ report: undefined });
    const [back] = parseAgentLedger(serializeAgentRun(original));
    expect(back.report).toBeUndefined();
  });

  it("flattens newlines in free-text fields so a block never breaks the format", () => {
    const out = serializeAgentRun(record({ trigger: "line one\nline two" }));
    expect(out).toContain("- trigger: line one line two");
    expect(parseAgentLedger(out)[0].trigger).toBe("line one line two");
  });

  it("appends cleanly — two serialized records concatenate into two parsed ones", () => {
    const a = serializeAgentRun(record());
    const b = serializeAgentRun(record({ id: "2026-08-01T10:00:00.000Z·crm", slug: "crm", startedAt: iso("2026-08-01T10:00:00Z") }));
    expect(parseAgentLedger(a + b)).toHaveLength(2);
  });
});

describe("parseAgentLedger — resilience", () => {
  it("returns [] for an empty or heading-less file", () => {
    expect(parseAgentLedger("")).toEqual([]);
    expect(parseAgentLedger("just prose\n")).toEqual([]);
  });

  it("skips blocks missing the required fields instead of throwing", () => {
    const raw = ["## broken", "- name: X", "", serializeAgentRun(record())].join("\n");
    const parsed = parseAgentLedger(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].slug).toBe("ghostwriter");
  });

  it("skips a block with an unparseable timestamp", () => {
    expect(parseAgentLedger(["## x", "- agent: a", "- started: not-a-date", ""].join("\n"))).toEqual([]);
  });

  it("defaults an unknown outcome to failed rather than trusting it", () => {
    const raw = ["## x", "- agent: a", "- started: 2026-08-01T09:00:00.000Z", "- outcome: wonderful", ""].join("\n");
    expect(parseAgentLedger(raw)[0].outcome).toBe("failed");
  });

  it("survives a file a human reordered and commented", () => {
    const raw = ["# August runs", "", serializeAgentRun(record()), "some note I typed", ""].join("\n");
    expect(parseAgentLedger(raw)).toHaveLength(1);
  });
});

describe("sorting and filtering", () => {
  const runs = [
    record({ id: "a", startedAt: iso("2026-08-01T09:00:00Z"), slug: "gw" }),
    record({ id: "b", startedAt: iso("2026-08-02T09:00:00Z"), slug: "crm" }),
    record({ id: "c", startedAt: iso("2026-08-03T09:00:00Z"), slug: "gw" }),
  ];

  it("sortRuns is newest first and does not mutate", () => {
    const copy = [...runs];
    expect(sortRuns(runs).map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(runs).toEqual(copy);
  });

  it("runsForAgent filters and sorts", () => {
    expect(runsForAgent(runs, "gw").map((r) => r.id)).toEqual(["c", "a"]);
    expect(runsForAgent(runs, "nobody")).toEqual([]);
  });
});

describe("attributionChain", () => {
  it("is a single hop for a run Exo triggered", () => {
    const runs = [record({ id: "x", slug: "gw", by: "exo" })];
    expect(attributionChain(runs, "x")).toEqual(["gw"]);
  });

  it("walks back through a delegating agent", () => {
    const runs = [
      record({ id: "parent", slug: "strategy", by: "exo", startedAt: iso("2026-08-01T09:00:00Z") }),
      record({ id: "child", slug: "research", by: "strategy", startedAt: iso("2026-08-01T09:01:00Z") }),
    ];
    expect(attributionChain(runs, "child")).toEqual(["strategy", "research"]);
  });

  it("returns [] for an unknown id", () => {
    expect(attributionChain([record()], "nope")).toEqual([]);
  });

  it("terminates on a self-referential record instead of looping", () => {
    const runs = [record({ id: "loop", slug: "a", by: "a" })];
    expect(attributionChain(runs, "loop").length).toBeLessThanOrEqual(2);
  });
});

describe("agent memory", () => {
  it("paths live under the memory root", () => {
    expect(agentMemoryPath("_system/memory/agents", "gw")).toBe("_system/memory/agents/gw.md");
  });

  it("the seed is a valid vault note with a Learnings section", () => {
    const seed = initialAgentMemory("Ghostwriter", "ghostwriter", "2026-08-01");
    expect(seed).toContain("type: memory");
    expect(seed).toContain("agent: ghostwriter");
    expect(seed).toContain("last_updated: 2026-08-01");
    expect(seed).toContain("## Learnings");
  });

  it("the excerpt strips frontmatter and passes short memories through", () => {
    const raw = initialAgentMemory("X", "x") + "\n- learned a thing\n";
    const out = agentMemoryExcerpt(raw);
    expect(out).not.toContain("type: memory");
    expect(out).toContain("learned a thing");
  });

  it("keeps the TAIL when memory outgrows the budget — recent learnings win", () => {
    const body = Array.from({ length: 500 }, (_, i) => `- learning ${i}`).join("\n");
    const out = agentMemoryExcerpt(`---\ntype: memory\n---\n${body}`, 200);
    expect(out.length).toBeLessThan(260);
    expect(out).toContain("learning 499");
    expect(out).not.toContain("learning 0\n");
    expect(out.startsWith("…")).toBe(true);
  });
});
