import { describe, expect, it } from "vitest";
import {
  EMPTY_WORKFLOW_SIGNAL_LEDGER,
  classifyWorkflowIntent,
  createWorkflowSignal,
  evaluateWorkflowEligibility,
  recordWorkflowOccurrence,
  significantToolSequence,
  workflowSignature,
} from "../src/core/workflow-signals";

describe("workflow signals — privacy-safe signature", () => {
  it("normalizes equivalent intents without storing their entities or free text", () => {
    const first = createWorkflowSignal({
      userText: "Research Acme pricing for mario@example.com",
      tools: [
        { name: "mcp__obsidian__search_vault", input: { query: "Acme secret" } },
        { name: "WebSearch", input: { query: "https://acme.example/pricing" } },
      ],
      outputType: "markdown",
      createdAt: 100,
      convoId: "c1",
      turnId: "t1",
      succeeded: true,
    });
    const second = createWorkflowSignal({
      userText: "Research Beta pricing for another person",
      tools: [
        { name: "mcp__obsidian__search_vault", input: { query: "Beta private" } },
        { name: "WebSearch", input: { query: "https://beta.example/pricing" } },
      ],
      outputType: "markdown",
      createdAt: 101,
      convoId: "c2",
      turnId: "t2",
      succeeded: true,
    });

    expect(first.intent).toBe("research");
    expect(first.signature).toBe(second.signature);
    expect(JSON.stringify(first)).not.toMatch(/Acme|mario@example|https:|secret/i);
  });

  it("keeps materially different tool sequences distinct", () => {
    const shared = { intent: "research" as const, outputType: "markdown" as const };
    const readThenWeb = workflowSignature({ ...shared, tools: ["vault.search", "web.search"] });
    const webThenRead = workflowSignature({ ...shared, tools: ["web.search", "vault.search"] });
    const readThenWrite = workflowSignature({ ...shared, tools: ["vault.search", "vault.write"] });

    expect(readThenWeb).not.toBe(webThenRead);
    expect(readThenWeb).not.toBe(readThenWrite);
  });

  it("includes output type in the signature", () => {
    const base = { intent: "analysis" as const, tools: ["vault.read"] };
    expect(workflowSignature({ ...base, outputType: "markdown" })).not.toBe(
      workflowSignature({ ...base, outputType: "artifact" })
    );
  });

  it("maps raw tools to stable capability classes and drops UI noise", () => {
    expect(significantToolSequence([
      "TodoWrite",
      "Read",
      "Read",
      "mcp__obsidian__search_vault",
      "WebFetch",
      "mcp__claude_ai_Gmail__search_threads",
      "AskUserQuestion",
    ])).toEqual([
      "vault.read",
      "vault.search",
      "web.fetch",
      "external.mcp",
    ]);
  });

  it("classifies only into bounded intent categories", () => {
    expect(classifyWorkflowIntent("Summarize these notes")).toBe("summarize");
    expect(classifyWorkflowIntent("Create a launch plan")).toBe("plan");
    expect(classifyWorkflowIntent("Please handle this unusual thing")).toBe("other");
  });

  it("creates opaque unique ids while retaining only safe metadata", () => {
    const base = {
      userText: "Analyze the launch",
      tools: [{ name: "Read", input: { file_path: "Private/Launch.md" } }],
      outputType: "message" as const,
      createdAt: 100,
      convoId: "c1",
      succeeded: false,
    };
    const first = createWorkflowSignal({ ...base, turnId: "t1" });
    const second = createWorkflowSignal({ ...base, turnId: "t2" });

    expect(first.id).not.toBe(second.id);
    expect(first).toMatchObject({
      intent: "analysis",
      tools: ["vault.read"],
      createdAt: 100,
      convoId: "c1",
      turnId: "t1",
      succeeded: false,
    });
    expect(JSON.stringify(first)).not.toContain("Private/Launch.md");
  });
});

describe("workflow signals — eligibility", () => {
  const base = {
    succeeded: true,
    stopped: false,
    errored: false,
    recoveryRetry: false,
    sideThread: false,
    playbookRun: false,
    sensitive: false,
    assistantChars: 500,
    toolNames: ["Read", "WebSearch"],
    structuredOutput: false,
  };

  it("accepts a substantial successful multi-step workflow", () => {
    expect(evaluateWorkflowEligibility(base)).toEqual({ eligible: true });
  });

  it.each([
    ["stopped", { stopped: true }, "stopped"],
    ["errored", { errored: true }, "error"],
    ["retry", { recoveryRetry: true }, "recovery-retry"],
    ["btw", { sideThread: true }, "side-thread"],
    ["playbook", { playbookRun: true }, "playbook-run"],
    ["sensitive", { sensitive: true }, "sensitive"],
  ] as const)("rejects %s turns", (_label, patch, reason) => {
    expect(evaluateWorkflowEligibility({ ...base, ...patch })).toEqual({ eligible: false, reason });
  });

  it("requires either two significant steps or a recognized structured output", () => {
    expect(evaluateWorkflowEligibility({ ...base, toolNames: ["Read"] })).toEqual({
      eligible: false,
      reason: "insufficient-structure",
    });
    expect(evaluateWorkflowEligibility({
      ...base,
      toolNames: [],
      structuredOutput: true,
    })).toEqual({ eligible: true });
  });
});

describe("workflow signals — 30-day threshold", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.parse("2026-07-20T10:00:00Z");
  const signal = (turnId: string, createdAt: number, signature = "research|vault.read>web.search|markdown") => ({
    id: `wf-${turnId}`,
    signature,
    intent: "research" as const,
    tools: ["vault.read", "web.search"],
    createdAt,
    convoId: "c1",
    turnId,
    succeeded: true,
  });

  it("emits one candidate only when the third occurrence enters the window", () => {
    let ledger = EMPTY_WORKFLOW_SIGNAL_LEDGER;
    let result = recordWorkflowOccurrence(ledger, signal("t1", NOW - DAY), NOW);
    expect(result.candidate).toBeNull();
    ledger = result.ledger;
    result = recordWorkflowOccurrence(ledger, signal("t2", NOW - 1), NOW);
    expect(result.candidate).toBeNull();
    ledger = result.ledger;
    result = recordWorkflowOccurrence(ledger, signal("t3", NOW), NOW);
    expect(result.candidate).toEqual({
      signature: "research|vault.read>web.search|markdown",
      occurrences: 3,
    });
  });

  it("drops occurrences older than 30 days before counting", () => {
    let ledger = EMPTY_WORKFLOW_SIGNAL_LEDGER;
    ledger = recordWorkflowOccurrence(ledger, signal("old", NOW - 31 * DAY), NOW).ledger;
    ledger = recordWorkflowOccurrence(ledger, signal("t2", NOW - DAY), NOW).ledger;
    const result = recordWorkflowOccurrence(ledger, signal("t3", NOW), NOW);

    expect(result.candidate).toBeNull();
    expect(result.ledger.signals.map((item) => item.turnId)).toEqual(["t2", "t3"]);
  });

  it("does not count the same turn twice after retry or reload", () => {
    const first = recordWorkflowOccurrence(EMPTY_WORKFLOW_SIGNAL_LEDGER, signal("t1", NOW), NOW);
    const retry = recordWorkflowOccurrence(first.ledger, signal("t1", NOW), NOW);

    expect(retry.ledger.signals).toHaveLength(1);
    expect(retry.candidate).toBeNull();
  });

  it("suppresses candidates with pending or accepted proposal signatures", () => {
    let ledger = EMPTY_WORKFLOW_SIGNAL_LEDGER;
    ledger = recordWorkflowOccurrence(ledger, signal("t1", NOW - 2), NOW).ledger;
    ledger = recordWorkflowOccurrence(ledger, signal("t2", NOW - 1), NOW).ledger;
    const result = recordWorkflowOccurrence(ledger, signal("t3", NOW), NOW, {
      blockedSignatures: new Set(["research|vault.read>web.search|markdown"]),
    });

    expect(result.candidate).toBeNull();
    expect(result.ledger.signals).toHaveLength(3);
  });
});
