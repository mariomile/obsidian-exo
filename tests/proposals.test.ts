import { describe, expect, it } from "vitest";
import {
  evaluateProposal,
  fingerprintProposal,
  formatProposalPreview,
  parseProposalCandidates,
  pruneProposalRecords,
  type ProposalCandidate,
  type ProposalRecord,
} from "../src/core/proposals";

const NOW = Date.UTC(2026, 6, 20, 12);
const DAY = 24 * 60 * 60 * 1000;

function candidate(overrides: Partial<ProposalCandidate> = {}): ProposalCandidate {
  return {
    kind: "task",
    title: "Write release notes",
    payload: { kind: "task", title: "Write release notes", prompt: "Summarize the shipped changes." },
    rationale: "Mario committed to publishing them.",
    ...overrides,
  };
}

function record(
  status: ProposalRecord["status"],
  createdAt: number,
  overrides: Partial<ProposalRecord> = {}
): ProposalRecord {
  const value = candidate();
  return {
    id: `proposal-${status}-${createdAt}`,
    kind: value.kind,
    status,
    title: value.title,
    payload: value.payload,
    rationale: value.rationale,
    fingerprint: fingerprintProposal(value.payload),
    source: { convoId: "convo-1", turnId: "turn-1", createdAt },
    ...(status === "pending" ? {} : { resolvedAt: createdAt }),
    ...overrides,
  };
}

describe("parseProposalCandidates", () => {
  it("parses all four kinds and discards unknown LLM fields", () => {
    const result = parseProposalCandidates(JSON.stringify([
      { kind: "task", title: "Task", prompt: "Do it", model: "sonnet", rationale: "Explicit action", ignored: true },
      { kind: "loop", title: "Follow up", note: "Ask again", resurface: "2028-02-29", tags: ["work"], rationale: "Deferred" },
      { kind: "decision", title: "Choose A", context: "Options", decision: "A", rationale: "Decided", extra: "drop" },
      { kind: "playbook", name: "Weekly review", prompt: "Review the week", rationale: "Reusable" },
    ]));

    // The limit is intentionally exercised separately: this batch is invalid.
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") expect(result.errors[0]).toMatchObject({ code: "too_many", path: "$" });

    const valid = parseProposalCandidates(JSON.stringify([
      { kind: "task", title: "Task", prompt: "Do it", model: "sonnet", rationale: "Explicit action", ignored: true },
      { kind: "loop", title: "Follow up", note: "Ask again", resurface: "2028-02-29", tags: ["work"], rationale: "Deferred" },
      { kind: "decision", title: "Choose A", context: "Options", decision: "A", rationale: "Decided", extra: "drop" },
    ]));
    expect(valid.status).toBe("ok");
    if (valid.status !== "ok") return;
    expect(valid.value).toHaveLength(3);
    expect(valid.value[0]).toEqual({
      kind: "task",
      title: "Task",
      payload: { kind: "task", title: "Task", prompt: "Do it", model: "sonnet" },
      rationale: "Explicit action",
    });
    expect(valid.value[1].payload).toEqual({ kind: "loop", title: "Follow up", note: "Ask again", resurface: "2028-02-29", tags: ["work"] });
    expect(valid.value[2].payload).toEqual({ kind: "decision", title: "Choose A", context: "Options", decision: "A", rationale: "Decided" });

    const playbook = parseProposalCandidates(JSON.stringify([
      { kind: "playbook", name: "Weekly review", prompt: "Review the week", rationale: "Reusable", extra: 1 },
    ]));
    expect(playbook).toEqual({
      status: "ok",
      value: [{
        kind: "playbook",
        title: "Weekly review",
        payload: { kind: "playbook", name: "Weekly review", prompt: "Review the week" },
        rationale: "Reusable",
      }],
    });
  });

  it("accepts one optional markdown fence, but rejects prose or trailing text", () => {
    const json = JSON.stringify([{ kind: "task", title: "T", prompt: "P", rationale: "R" }]);
    expect(parseProposalCandidates(`\n\`\`\`json\n${json}\n\`\`\`\n`).status).toBe("ok");
    expect(parseProposalCandidates(`Here you go:\n${json}`).status).toBe("invalid");
    expect(parseProposalCandidates(`${json}\nthanks`).status).toBe("invalid");
  });

  it("accepts an empty array and rejects malformed JSON or more than 3 candidates without throwing", () => {
    expect(parseProposalCandidates("[]")).toEqual({ status: "ok", value: [] });
    expect(() => parseProposalCandidates("[oops")).not.toThrow();
    expect(parseProposalCandidates("[oops")).toMatchObject({ status: "invalid" });
    const four = Array.from({ length: 4 }, (_, index) => ({ kind: "task", title: `T${index}`, prompt: "P", rationale: "R" }));
    expect(parseProposalCandidates(JSON.stringify(four))).toMatchObject({ status: "invalid", errors: [{ code: "too_many" }] });
  });

  it("returns typed validation errors for every kind and exact string limits", () => {
    const cases = [
      { raw: [{ kind: "task", title: "x".repeat(121), prompt: "P", rationale: "R" }], code: "too_long", path: "$[0].title" },
      { raw: [{ kind: "task", title: "T", prompt: "x".repeat(4001), rationale: "R" }], code: "too_long", path: "$[0].prompt" },
      { raw: [{ kind: "loop", title: "T", note: "", rationale: "R" }], code: "required", path: "$[0].note" },
      { raw: [{ kind: "decision", title: "T", context: 4, decision: "D", rationale: "R" }], code: "invalid_type", path: "$[0].context" },
      { raw: [{ kind: "playbook", name: "x".repeat(121), prompt: "P", rationale: "R" }], code: "too_long", path: "$[0].name" },
      { raw: [{ kind: "task", title: "T", prompt: "P", rationale: "x".repeat(501) }], code: "too_long", path: "$[0].rationale" },
    ];
    for (const testCase of cases) {
      const result = parseProposalCandidates(JSON.stringify(testCase.raw));
      expect(result.status).toBe("invalid");
      if (result.status === "invalid") expect(result.errors[0]).toMatchObject({ code: testCase.code, path: testCase.path });
    }

    const exact = parseProposalCandidates(JSON.stringify([{ kind: "decision", title: "x".repeat(120), context: "x".repeat(4000), decision: "x".repeat(4000), rationale: "x".repeat(500) }]));
    expect(exact.status).toBe("ok");
  });

  it("validates local YYYY-MM-DD calendar dates", () => {
    const loop = (resurface: string) => JSON.stringify([{ kind: "loop", title: "T", note: "N", resurface, rationale: "R" }]);
    expect(parseProposalCandidates(loop("2028-02-29")).status).toBe("ok");
    for (const date of ["2027-02-29", "2026-04-31", "2026-13-01", "20-01-01", "2026-1-01"]) {
      expect(parseProposalCandidates(loop(date))).toMatchObject({ status: "invalid", errors: [{ code: "invalid_date" }] });
    }
  });
});

describe("fingerprint and dedup", () => {
  it("is deterministic and case/whitespace insensitive across kind, target and content", () => {
    const a = { kind: "task" as const, title: " Release   Notes ", prompt: "Summarize\n the CHANGES" };
    const b = { kind: "task" as const, title: "release notes", prompt: " summarize the changes " };
    expect(fingerprintProposal(a)).toBe(fingerprintProposal(a));
    expect(fingerprintProposal(a)).toBe(fingerprintProposal(b));
    expect(fingerprintProposal({ ...b, prompt: "Different" })).not.toBe(fingerprintProposal(b));
  });

  it("deduplicates pending and recently accepted records, but not dismissed or expired accepted ones", () => {
    const value = candidate();
    expect(evaluateProposal(value, [record("pending", NOW - 100 * DAY)], NOW).status).toBe("duplicate");
    expect(evaluateProposal(value, [record("accepted", NOW - 30 * DAY)], NOW).status).toBe("duplicate");
    expect(evaluateProposal(value, [record("accepted", NOW - 30 * DAY - 1)], NOW).status).toBe("ok");
    expect(evaluateProposal(value, [record("dismissed", NOW - DAY)], NOW).status).toBe("ok");
  });
});

describe("pruneProposalRecords", () => {
  it("preserves every pending record, prunes resolved records older than 30 days, and keeps at most 200 resolved", () => {
    const pending = Array.from({ length: 205 }, (_, index) => record("pending", NOW - (100 + index) * DAY, { id: `pending-${index}` }));
    const recent = Array.from({ length: 205 }, (_, index) => record(index % 2 ? "accepted" : "dismissed", NOW - index * 1000, { id: `resolved-${index}`, resolvedAt: NOW - index * 1000 }));
    const old = record("accepted", NOW - 31 * DAY, { id: "old", resolvedAt: NOW - 31 * DAY });
    const result = pruneProposalRecords([...pending, ...recent, old], NOW);
    expect(result.filter((item) => item.status === "pending")).toHaveLength(205);
    expect(result.filter((item) => item.status !== "pending")).toHaveLength(200);
    expect(result.some((item) => item.id === "old")).toBe(false);
    expect(result.some((item) => item.id === "resolved-204")).toBe(false);
  });
});

describe("formatProposalPreview", () => {
  it("formats a compact, single-line, quiet preview", () => {
    expect(formatProposalPreview(candidate({ rationale: "Explicit\ncommitment   from Mario." }))).toBe(
      "Task · Write release notes — Explicit commitment from Mario."
    );
    const long = formatProposalPreview(candidate({ rationale: "x".repeat(500) }));
    expect(long).toHaveLength(180);
    expect(long.endsWith("…")).toBe(true);
  });
});
