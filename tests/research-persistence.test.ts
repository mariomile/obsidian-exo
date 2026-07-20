import { describe, expect, it } from "vitest";
import {
  persistMessage,
  revivePersistedMessage,
  type Message,
  type PersistedMessage,
} from "../src/core/model";

describe("Research receipt persistence", () => {
  it("round-trips the receipt through the production message codec", () => {
    const receipt = {
      scope: "both" as const,
      depth: "deep" as const,
      startedAt: 10,
      completedAt: 20,
      status: "partial" as const,
      sources: [
        { kind: "vault" as const, label: "Notes/A.md", status: "consulted" as const },
        { kind: "web" as const, label: "Web sources", status: "unavailable" as const },
      ],
    };
    const runtime: Message = {
      role: "assistant",
      segments: [{ t: "tool", name: "Read", input: {}, ok: true, output: "abcdef" }],
      checkpoint: new Map([["small.md", "ok"], ["large.md", "too long"]]),
      researchReceipt: receipt,
    };

    const persisted = persistMessage(runtime, { maxToolOutput: 3, maxCheckpointFile: 3 });
    expect(persisted).toEqual({
      role: "assistant",
      segments: [{ t: "tool", name: "Read", input: {}, ok: true, output: "abc" }],
      checkpoint: [["small.md", "ok"]],
      researchReceipt: receipt,
    });

    const fromDisk = JSON.parse(JSON.stringify(persisted)) as PersistedMessage;
    expect(revivePersistedMessage(fromDisk)).toEqual({
      ...runtime,
      segments: [{ t: "tool", name: "Read", input: {}, ok: true, output: "abc" }],
      checkpoint: new Map([["small.md", "ok"]]),
    });
  });

  it("drops a malformed receipt while preserving the assistant message", () => {
    const malformed = {
      role: "assistant" as const,
      segments: [{ t: "text" as const, md: "Answer remains readable" }],
      researchReceipt: {
        scope: "everything",
        sources: "not-an-array",
      },
    } as unknown as PersistedMessage;

    expect(revivePersistedMessage(malformed)).toEqual({
      role: "assistant",
      segments: [{ t: "text", md: "Answer remains readable" }],
    });
  });
});
