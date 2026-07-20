import { describe, expect, it } from "vitest";
import {
  buildFoundryDistillPrompt,
  parseFoundryDistillation,
  type FoundryDistillInput,
} from "../src/core/foundry-distill";

const input: FoundryDistillInput = {
  intent: "research",
  tools: ["vault.search", "web.search"],
  outputType: "markdown",
  occurrences: 3,
  workflowSignature: "research|vault.search>web.search|markdown",
  userText: "Ricerca competitor su GEO e riassumi",
  responseText: "Ecco una sintesi dei competitor...",
};

const reply = JSON.stringify({
  name: "GEO competitor scan",
  outcome: "A cited competitor summary",
  prompt: "Research {{topic}} across the vault first, then the web, and produce a cited summary with sources and gaps.",
  inputs: ["topic"],
  capabilities: ["vault.search", "web.search"],
  why: "This workflow recurred three times in the last month.",
});

describe("buildFoundryDistillPrompt", () => {
  it("states the detected signal, caps evidence, and demands a bare JSON object", () => {
    const long = "x".repeat(5000);
    const prompt = buildFoundryDistillPrompt({ ...input, userText: long, responseText: long });
    expect(prompt).toContain("intent: research");
    expect(prompt).toContain("vault.search > web.search");
    expect(prompt).toContain("observed 3 times");
    expect(prompt).toContain("ONLY a JSON object");
    // Evidence is capped well below the raw 5000 chars.
    expect(prompt.length).toBeLessThan(3500);
    expect(prompt).toContain("…");
  });
});

describe("parseFoundryDistillation", () => {
  const context = { workflowSignature: input.workflowSignature, occurrences: 3 };

  it("builds a typed playbook candidate carrying the workflow signature and metadata", () => {
    const result = parseFoundryDistillation(reply, context);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.candidate.kind).toBe("playbook");
    expect(result.candidate.title).toBe("GEO competitor scan");
    expect(result.candidate.payload).toMatchObject({
      kind: "playbook",
      name: "GEO competitor scan",
      outcome: "A cited competitor summary",
      inputs: ["topic"],
      capabilities: ["vault.search", "web.search"],
      workflowSignature: "research|vault.search>web.search|markdown",
    });
    expect(result.candidate.rationale).toBe("This workflow recurred three times in the last month.");
  });

  it("accepts a fenced object and tolerates leading prose around the JSON", () => {
    expect(parseFoundryDistillation("```json\n" + reply + "\n```", context).status).toBe("ok");
    expect(parseFoundryDistillation("Here it is: " + reply, context).status).toBe("ok");
  });

  it("falls back to an occurrence-based rationale when why is absent", () => {
    const noWhy = JSON.stringify({ name: "N", prompt: "A reusable prompt that is clearly long enough to pass validation." });
    const result = parseFoundryDistillation(noWhy, context);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.candidate.rationale).toBe("Detected 3 equivalent runs of this workflow.");
    expect(result.candidate.payload).not.toHaveProperty("why");
  });

  it("rejects malformed, empty, or over-limit distillations without throwing", () => {
    expect(parseFoundryDistillation("not json at all", context).status).toBe("invalid");
    expect(parseFoundryDistillation("{}", context).status).toBe("invalid");
    expect(() => parseFoundryDistillation("{ broken", context)).not.toThrow();
    const overLong = JSON.stringify({ name: "N", prompt: "x".repeat(4001) });
    expect(parseFoundryDistillation(overLong, context).status).toBe("invalid");
    const badInputs = JSON.stringify({ name: "N", prompt: "A valid reusable prompt long enough to pass.", inputs: "topic" });
    expect(parseFoundryDistillation(badInputs, context).status).toBe("invalid");
  });
});
