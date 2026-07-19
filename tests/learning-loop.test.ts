import { describe, it, expect } from "vitest";
import {
  turnQualifies,
  buildDistillPrompt,
  parseDistillReply,
  uniquePlaybookName,
  topicKeywords,
  anchors,
  recordTurnSignal,
  signalLabel,
  EMPTY_LEDGER,
  type SignalLedger,
} from "../src/core/learning-loop";

const base = { ok: true, toolCount: 8, distinctTools: 3, durationMs: 120_000, userText: "prepara il digest" };

describe("turnQualifies", () => {
  it("qualifies a substantial healthy turn", () => {
    expect(turnQualifies(base)).toBe(true);
  });

  it("rejects unhealthy, small, single-tool, or fast turns", () => {
    expect(turnQualifies({ ...base, ok: false })).toBe(false);
    expect(turnQualifies({ ...base, toolCount: 4 })).toBe(false);
    expect(turnQualifies({ ...base, distinctTools: 1 })).toBe(false);
    expect(turnQualifies({ ...base, durationMs: 10_000 })).toBe(false);
  });

  it("rejects turns that were already a command/playbook run", () => {
    expect(turnQualifies({ ...base, userText: "/morning-digest" })).toBe(false);
    expect(turnQualifies({ ...base, userText: "  /compact keep decisions" })).toBe(false);
  });
});

describe("buildDistillPrompt", () => {
  it("embeds user text, tool lines, and final text, capped", () => {
    const p = buildDistillPrompt({
      userText: "u".repeat(2000),
      toolLines: ["search_vault: gtm", "read_note: Captoo"],
      finalText: "f".repeat(2000),
    });
    expect(p).toContain("search_vault: gtm");
    expect(p).toContain("u".repeat(1200));
    expect(p).not.toContain("u".repeat(1201));
    expect(p).toContain('{"name"');
  });
});

describe("parseDistillReply", () => {
  const good = `{"name": "Vault GTM recon", "prompt": "${"Search the vault for GTM notes, read the project context, then synthesize a plan. ".repeat(2).trim()}"}`;

  it("parses a clean reply", () => {
    const r = parseDistillReply(good);
    expect(r?.name).toBe("Vault GTM recon");
    expect(r?.prompt).toContain("Search the vault");
  });

  it("parses JSON wrapped in prose or fences", () => {
    expect(parseDistillReply("Here you go:\n```json\n" + good + "\n```")).not.toBeNull();
  });

  it("rejects malformed, non-string, too-short, and oversized replies", () => {
    expect(parseDistillReply("no json here")).toBeNull();
    expect(parseDistillReply('{"name": 3, "prompt": "x".repeat}')).toBeNull();
    expect(parseDistillReply('{"name": "x", "prompt": "too short"}')).toBeNull();
    expect(parseDistillReply(`{"name": "x", "prompt": "${"a".repeat(4001)}"}`)).toBeNull();
  });

  it("trims and caps the name", () => {
    const r = parseDistillReply(`{"name": "  ${"n".repeat(80)}  ", "prompt": "${"p".repeat(60)}"}`);
    expect(r?.name.length).toBe(60);
  });
});

describe("uniquePlaybookName", () => {
  it("keeps a free name, suffixes a taken one (case-insensitive)", () => {
    expect(uniquePlaybookName("Digest", ["Other"])).toBe("Digest");
    expect(uniquePlaybookName("Digest", ["digest"])).toBe("Digest 2");
    expect(uniquePlaybookName("Digest", ["digest", "Digest 2"])).toBe("Digest 3");
  });
});

describe("topicKeywords / anchors", () => {
  it("folds, drops stopwords, stems, and keeps salient words", () => {
    const kw = topicKeywords("Scrivi un post LinkedIn su Captoo");
    expect(kw).toContain("linkedin");
    expect(kw).toContain("captoo");
    expect(kw).not.toContain("un");
    expect(kw).not.toContain("su");
  });

  it("anchors are the entity-length (≥5) keywords", () => {
    expect(anchors(["post", "linkedin", "captoo"])).toEqual(["linkedin", "captoo"]);
  });
});

describe("recordTurnSignal — recurrence (rule of three)", () => {
  const now = 1_000_000;

  it("proposes only on the 3rd recurrence of a topic", () => {
    let ledger: SignalLedger = EMPTY_LEDGER;
    let r = recordTurnSignal(ledger, "Scrivi un post LinkedIn su Captoo", now);
    expect(r.proposal).toBeNull();
    ledger = r.ledger;
    r = recordTurnSignal(ledger, "Draft di un post LinkedIn su DeepAgent", now + 1);
    expect(r.proposal).toBeNull();
    ledger = r.ledger;
    r = recordTurnSignal(ledger, "Prepara un post LinkedIn sul pricing", now + 2);
    expect(r.proposal).not.toBeNull();
    expect(r.proposal!.count).toBe(3);
    expect(r.proposal!.examples.length).toBe(3);
    expect(signalLabel(r.proposal!)).toContain("linkedin");
  });

  it("never proposes the same topic twice", () => {
    let ledger: SignalLedger = EMPTY_LEDGER;
    for (let i = 0; i < 3; i++) {
      ledger = recordTurnSignal(ledger, "post LinkedIn nuovo", now + i).ledger;
    }
    const again = recordTurnSignal(ledger, "post LinkedIn ancora", now + 9);
    expect(again.proposal).toBeNull();
  });

  it("keeps distinct topics in separate clusters", () => {
    let ledger: SignalLedger = EMPTY_LEDGER;
    ledger = recordTurnSignal(ledger, "post LinkedIn su Captoo", now).ledger;
    ledger = recordTurnSignal(ledger, "analizza il pricing di Coverzen", now + 1).ledger;
    expect(ledger.signals.length).toBe(2);
  });

  it("ignores anchor-less (too thin) requests", () => {
    const r = recordTurnSignal(EMPTY_LEDGER, "fai la cosa", now);
    expect(r.proposal).toBeNull();
    expect(r.ledger.signals.length).toBe(0);
  });

  it("does not mutate the input ledger", () => {
    const before: SignalLedger = { signals: [] };
    recordTurnSignal(before, "post LinkedIn su Captoo", now);
    expect(before.signals.length).toBe(0);
  });
});
