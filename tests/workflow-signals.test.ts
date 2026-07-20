import { describe, expect, it } from "vitest";
import {
  classifyWorkflowIntent,
  createWorkflowSignal,
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
