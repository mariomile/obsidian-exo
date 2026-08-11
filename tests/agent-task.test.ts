import { describe, it, expect } from "vitest";
import { agentTaskRow, agentTaskStatus } from "../src/core/agent-task";
import type { LiveTask } from "../src/core/live-tasks";

describe("agentTaskStatus — patch status onto the chip vocabulary", () => {
  it("terminal patches map to done/error", () => {
    expect(agentTaskStatus("completed")).toBe("done");
    expect(agentTaskStatus("failed")).toBe("error");
    expect(agentTaskStatus("killed")).toBe("error");
  });

  it("no status (started/progress echoes) and unknown patches mean still running", () => {
    expect(agentTaskStatus(undefined)).toBe("running");
    expect(agentTaskStatus("paused")).toBe("running");
  });
});

describe("agentTaskRow — the row an agent-task event upserts", () => {
  it("first sighting builds a running backgrounded subagent from the event", () => {
    const row = agentTaskRow({ toolUseId: "toolu_1", description: "hook-bumper" }, undefined, 42);
    expect(row).toEqual({
      id: "toolu_1",
      kind: "subagent",
      backgrounded: true,
      label: "hook-bumper",
      status: "running",
      startedAt: 42,
    });
  });

  it("label and start time stick to the earliest sighting (launch card named it first)", () => {
    const prev: LiveTask = { id: "toolu_1", kind: "subagent", label: "hook-bumper", status: "done", startedAt: 7 };
    const row = agentTaskRow({ toolUseId: "toolu_1", description: "other" }, prev, 99);
    expect(row.label).toBe("hook-bumper");
    expect(row.startedAt).toBe(7);
    // The launch ack settled the row; a liveness echo resurrects it as running.
    expect(row.status).toBe("running");
    expect(row.backgrounded).toBe(true);
  });
});
