import { describe, expect, it } from "vitest";
import { revivePersistedMessage, type PersistedMessage } from "../src/core/model";

describe("Research field tolerance in the message codec", () => {
  it("drops an orphan researchReceipt from old persisted messages", () => {
    const persisted = {
      role: "assistant",
      segments: [{ t: "text", md: "Older research answer." }],
      researchReceipt: {
        scope: "both",
        depth: "standard",
        startedAt: 1,
        completedAt: 2,
        status: "complete",
        sources: [{ kind: "web", label: "example.com", status: "consulted" }],
      },
    } as unknown as PersistedMessage;
    const revived = revivePersistedMessage(persisted);
    expect(revived.role).toBe("assistant");
    expect("researchReceipt" in revived).toBe(false);
    expect(revived.role === "assistant" && revived.segments[0]).toEqual({
      t: "text",
      md: "Older research answer.",
    });
  });
});
