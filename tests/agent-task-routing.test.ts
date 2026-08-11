import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentEvent, SessionOpts } from "../src/providers/types";

/** Same controllable fake as claude-session.test.ts: tests push CLI messages
 *  and the session's pump drains them, exactly like streaming-input mode. */
function makeFakeQuery() {
  const pending: unknown[] = [];
  let wake: (() => void) | null = null;
  return {
    interrupt: vi.fn(() => Promise.resolve()),
    getContextUsage: vi.fn(async (): Promise<unknown> => undefined),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async (): Promise<unknown> => undefined),
    push(msg: unknown) {
      pending.push(msg);
      const w = wake;
      wake = null;
      w?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (pending.length === 0) await new Promise<void>((r) => (wake = r));
        yield pending.shift();
      }
    },
  };
}

let fake: ReturnType<typeof makeFakeQuery>;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => fake),
}));

import { claudeAdapter } from "../src/providers/claude";

const OPTS: SessionOpts = {
  cli: { bin: "claude", pathEnv: "" },
  model: "default",
  effort: "default",
  cwd: "/tmp",
  permissionMode: "default",
  toolsEnabled: false,
  fastStartup: true,
};

const okResult = { type: "result", subtype: "success", result: "done" };

/** Run one turn: send, feed `msgs`, close with a clean result, return events. */
async function turnWith(msgs: unknown[]): Promise<AgentEvent[]> {
  const session = claudeAdapter.createSession(OPTS);
  const events: AgentEvent[] = [];
  const turn = session.send("hi", (e) => events.push(e));
  for (const m of msgs) fake.push(m);
  fake.push(okResult);
  await turn;
  session.dispose();
  return events;
}

/** The Agent tool backgrounds by default on recent CLIs: its tool result is a
 *  launch ack, and the agent's real lifecycle arrives as `system/task_*`
 *  events carrying `subagent_type`. The router must forward those as
 *  `agent-task` — previously they were dropped by the `local_workflow` gate,
 *  so the chip settled at the launch ack and the user had no signal that the
 *  agents were still running. */
describe("routeTaskEvent — backgrounded subagent tasks", () => {
  beforeEach(() => {
    fake = makeFakeQuery();
  });

  test("task_started with subagent_type emits agent-task bound to the launching tool_use", async () => {
    const events = await turnWith([
      {
        type: "system",
        subtype: "task_started",
        task_id: "t1",
        tool_use_id: "toolu_1",
        subagent_type: "general-purpose",
        description: "hook-bumper",
      },
    ]);
    expect(events.filter((e) => e.kind === "agent-task")).toEqual([
      { kind: "agent-task", toolUseId: "toolu_1", taskId: "t1", description: "hook-bumper" },
    ]);
  });

  test("task_updated resolves through the binding and carries the terminal status", async () => {
    const events = await turnWith([
      { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_1", subagent_type: "x", description: "d" },
      { type: "system", subtype: "task_updated", task_id: "t1", patch: { status: "completed" } },
    ]);
    const terminal = events.filter((e) => e.kind === "agent-task" && e.status);
    expect(terminal).toEqual([{ kind: "agent-task", toolUseId: "toolu_1", taskId: "t1", status: "completed" }]);
  });

  test("a missed task_started doesn't mute the run: task_progress lazily binds for task_updated", async () => {
    const events = await turnWith([
      { type: "system", subtype: "task_progress", task_id: "t2", tool_use_id: "toolu_2", subagent_type: "x", description: "d" },
      { type: "system", subtype: "task_updated", task_id: "t2", patch: { status: "failed" } },
    ]);
    const kinds = events.filter((e) => e.kind === "agent-task");
    expect(kinds).toHaveLength(2);
    expect(kinds[1]).toEqual({ kind: "agent-task", toolUseId: "toolu_2", taskId: "t2", status: "failed" });
  });

  test("skip_transcript (ambient housekeeping) tasks are dropped", async () => {
    const events = await turnWith([
      {
        type: "system",
        subtype: "task_started",
        task_id: "t3",
        tool_use_id: "toolu_3",
        subagent_type: "x",
        skip_transcript: true,
      },
    ]);
    expect(events.filter((e) => e.kind === "agent-task")).toEqual([]);
  });

  test("workflow tasks still route as workflow-progress, never as agent-task", async () => {
    const events = await turnWith([
      {
        type: "system",
        subtype: "task_started",
        task_id: "w1",
        tool_use_id: "toolu_w",
        task_type: "local_workflow",
        workflow_name: "spec",
      },
      { type: "system", subtype: "task_updated", task_id: "w1", patch: { status: "completed" } },
    ]);
    expect(events.filter((e) => e.kind === "agent-task")).toEqual([]);
    const wf = events.filter((e) => e.kind === "workflow-progress");
    expect(wf).toHaveLength(2);
    expect(wf[1]).toMatchObject({ toolUseId: "toolu_w", status: "completed" });
  });

  test("shell background tasks (no subagent_type) pass through untouched", async () => {
    const events = await turnWith([
      { type: "system", subtype: "task_started", task_id: "s1", tool_use_id: "toolu_s" },
      { type: "system", subtype: "task_updated", task_id: "s1", patch: { status: "completed" } },
    ]);
    expect(events.filter((e) => e.kind === "agent-task" || e.kind === "workflow-progress")).toEqual([]);
  });
});
