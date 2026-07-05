import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentEvent, SessionOpts } from "../src/providers/types";

/** Controllable fake for the SDK's `query()` stream: tests push CLI messages and
 *  the session's pump drains them, exactly like the real streaming-input mode. */
function makeFakeQuery() {
  const pending: unknown[] = [];
  let wake: (() => void) | null = null;
  return {
    interrupt: vi.fn(() => Promise.resolve()),
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

/** The CLI reports a locally-initiated interrupt as an error_during_execution
 *  result even though the process and session survive (verified against CLI
 *  2.1.195–2.1.201). The session must classify it by whether WE interrupted. */
describe("ClaudeSession interrupt vs error_during_execution", () => {
  beforeEach(() => {
    fake = makeFakeQuery();
  });

  const edeResult = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "",
  };

  test("suppresses the error event when the turn was interrupted locally", async () => {
    const session = claudeAdapter.createSession(OPTS);
    const events: AgentEvent[] = [];
    const turn = session.send("hi", (e) => events.push(e));
    session.interrupt();
    fake.push(edeResult);
    await expect(turn).resolves.toBeUndefined();
    expect(events.filter((e) => e.kind === "error")).toEqual([]);
    expect(events.some((e) => e.kind === "turn-end")).toBe(true);
    session.dispose();
  });

  test("still reports error_during_execution when nothing interrupted the turn", async () => {
    const session = claudeAdapter.createSession(OPTS);
    const events: AgentEvent[] = [];
    const turn = session.send("hi", (e) => events.push(e));
    fake.push(edeResult);
    await turn;
    expect(events.some((e) => e.kind === "error")).toBe(true);
    session.dispose();
  });

  test("an interrupted turn does not mask a genuine error on the next turn", async () => {
    const session = claudeAdapter.createSession(OPTS);
    const first = session.send("hi", () => {});
    session.interrupt();
    fake.push(edeResult);
    await first;

    const events: AgentEvent[] = [];
    const second = session.send("again", (e) => events.push(e));
    fake.push(edeResult);
    await second;
    expect(events.some((e) => e.kind === "error")).toBe(true);
    session.dispose();
  });
});
