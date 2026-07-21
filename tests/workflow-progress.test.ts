import { describe, expect, it } from "vitest";
import {
  applyWorkflowProgress,
  createWorkflowRun,
  summarizeWorkflowRun,
  type WorkflowProgressEntry,
} from "../src/core/workflow-progress";

// Shapes lifted from the 2026-07-21 headless probe (stream.jsonl)
const FIRST_EVENT: WorkflowProgressEntry[] = [
  { type: "workflow_phase", index: 1, title: "P" },
  { type: "workflow_agent", index: 1, label: "a1", phaseTitle: "P", state: "start" },
  { type: "workflow_agent", index: 2, label: "a2", phaseTitle: "P", state: "start" },
];

describe("workflow progress reducer", () => {
  it("registers phase and agents from the first progress event", () => {
    const run = applyWorkflowProgress(createWorkflowRun("t1", "toolu_1", "probe"), FIRST_EVENT);
    expect(run.phase).toBe("P");
    expect(run.agents.size).toBe(2);
    expect(summarizeWorkflowRun(run)).toMatchObject({ running: 2, done: 0, total: 2 });
  });

  it("accumulates across incremental events — later state wins per index", () => {
    const run = applyWorkflowProgress(createWorkflowRun("t1", "toolu_1"), FIRST_EVENT);
    // Later event carries ONLY the agent that changed (observed behavior)
    applyWorkflowProgress(run, [{ type: "workflow_agent", index: 2, label: "a2", state: "done" }]);
    const s = summarizeWorkflowRun(run);
    expect(s).toMatchObject({ running: 1, done: 1, total: 2 });
    expect(s.label).toBe("1 agent running · 1 done · phase P");
  });

  it("counts error states as failed", () => {
    const run = applyWorkflowProgress(createWorkflowRun("t1", "toolu_1"), FIRST_EVENT);
    applyWorkflowProgress(run, [{ type: "workflow_agent", index: 1, label: "a1", state: "error" }]);
    expect(summarizeWorkflowRun(run)).toMatchObject({ running: 1, failed: 1 });
  });

  it("terminal status overrides the running label", () => {
    const run = applyWorkflowProgress(createWorkflowRun("t1", "toolu_1"), FIRST_EVENT);
    applyWorkflowProgress(run, [
      { type: "workflow_agent", index: 1, label: "a1", state: "done" },
      { type: "workflow_agent", index: 2, label: "a2", state: "done" },
    ]);
    run.status = "completed";
    expect(summarizeWorkflowRun(run).label).toBe("workflow done · 2 agents");
  });

  it("tolerates empty/undefined progress arrays", () => {
    const run = applyWorkflowProgress(createWorkflowRun("t1", "toolu_1"), undefined);
    expect(summarizeWorkflowRun(run)).toMatchObject({ running: 0, total: 0 });
  });

  it("pluralizes the running label correctly", () => {
    const run = applyWorkflowProgress(createWorkflowRun("t1", "toolu_1"), [
      { type: "workflow_agent", index: 1, label: "solo", state: "start" },
    ]);
    expect(summarizeWorkflowRun(run).label).toBe("1 agent running");
  });
});
