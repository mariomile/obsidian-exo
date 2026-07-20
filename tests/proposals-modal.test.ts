import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ Modal: class {}, setIcon: vi.fn() }));
import { proposalPayloadDetails, proposalTargetLabel } from "../src/ui/proposals-modal";

describe("proposal inbox presentation", () => {
  it("describes every explicit acceptance target", () => {
    expect(proposalTargetLabel({ kind: "task", title: "T", prompt: "P" })).toBe("Orchestration backlog");
    expect(proposalTargetLabel({ kind: "loop", title: "L", note: "N" })).toBe("Open Loops");
    expect(proposalTargetLabel({ kind: "decision", title: "D", context: "C", decision: "Yes" })).toBe("Decision record");
    expect(proposalTargetLabel({ kind: "playbook", name: "P", prompt: "Run" })).toBe("Custom prompts");
  });

  it("renders the complete typed loop payload", () => {
    expect(proposalPayloadDetails({
      kind: "loop",
      title: "Follow up",
      note: "Call next week",
      resurface: "2026-07-27",
      tags: ["work", "follow-up"],
    })).toEqual([
      { label: "Note", value: "Call next week" },
      { label: "Resurface", value: "2026-07-27" },
      { label: "Tags", value: "work, follow-up" },
    ]);
  });

  it("does not invent empty optional fields", () => {
    expect(proposalPayloadDetails({ kind: "task", title: "Ship", prompt: "Build it" }))
      .toEqual([{ label: "Prompt", value: "Build it" }]);
  });
});
