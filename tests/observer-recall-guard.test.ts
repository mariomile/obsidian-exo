import { describe, it, expect } from "vitest";
import {
  stripRecalledMemory,
  buildObserverPrompt,
  shouldSkipTurn,
  RECALLED_MEMORY_OPEN,
  RECALLED_MEMORY_CLOSE,
} from "../src/core/observer";

/** Wrap `body` in the injection delimiters the send path uses. */
const block = (body: string) => `${RECALLED_MEMORY_OPEN}\n${body}\n${RECALLED_MEMORY_CLOSE}`;

describe("stripRecalledMemory", () => {
  it("removes a single injected block, keeping the surrounding user text", () => {
    const input = `${block("- (fact, 2026-07-06) Mario prefers Sonnet")}\n\nWhat should I ship next?`;
    const out = stripRecalledMemory(input);
    expect(out).not.toContain(RECALLED_MEMORY_OPEN);
    expect(out).not.toContain("Mario prefers Sonnet");
    expect(out.trim()).toBe("What should I ship next?");
  });

  it("removes multiple blocks in one message", () => {
    const input = `${block("- a")}\nmiddle\n${block("- b")}\nend`;
    const out = stripRecalledMemory(input);
    expect(out).not.toContain("- a");
    expect(out).not.toContain("- b");
    expect(out).toContain("middle");
    expect(out).toContain("end");
  });

  it("is a no-op on text with no injected block", () => {
    const input = "Just a normal question about the roadmap.";
    expect(stripRecalledMemory(input)).toBe(input);
  });

  it("strips an unterminated block to end-of-string (defensive)", () => {
    const input = `real question\n${RECALLED_MEMORY_OPEN}\n- (fact) leaked`;
    const out = stripRecalledMemory(input);
    expect(out).not.toContain("leaked");
    expect(out.trim()).toBe("real question");
  });
});

describe("observer feedback-loop guard", () => {
  it("buildObserverPrompt never contains the injected block", () => {
    const injected = block("- (decision, 2026-07-08) We chose proactive recall");
    const prompt = buildObserverPrompt({
      user: `${injected}\n\nremind me what we decided`,
      assistant: "We decided to auto-inject memories.",
    });
    expect(prompt).not.toContain(RECALLED_MEMORY_OPEN);
    expect(prompt).not.toContain("We chose proactive recall");
    expect(prompt).toContain("remind me what we decided");
  });

  it("a turn whose ONLY novel user content is an injected block is skipped (zero re-capture)", () => {
    // The assistant side is short/empty enough that, once the block is stripped
    // from the user side, the turn falls below the trivial-turn threshold.
    const digest = {
      user: block("- (fact, 2026-07-06) " + "Mario ".repeat(30)),
      assistant: "ok",
    };
    expect(shouldSkipTurn(digest)).toBe(true);
  });

  it("still observes a turn that has real content alongside an injected block", () => {
    const digest = {
      user:
        block("- (fact) old memory") +
        "\n\nI just decided we are moving the launch to next quarter for real this time",
      assistant:
        "Got it — I'll note the launch is now next quarter and update the roadmap accordingly for you.",
    };
    expect(shouldSkipTurn(digest)).toBe(false);
  });
});
