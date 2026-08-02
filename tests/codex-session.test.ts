import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexSession, type CodexSessionRuntime } from "../src/providers/codex";
import type { AgentEvent, SessionOpts } from "../src/providers/types";

type RpcMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
};

class FakeCodexProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: Writable;
  killed = false;
  messages: RpcMessage[] = [];
  private consumed = new Set<RpcMessage>();
  private waiters: (() => void)[] = [];

  constructor() {
    super();
    let input = "";
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        input += chunk.toString();
        let nl: number;
        while ((nl = input.indexOf("\n")) >= 0) {
          const line = input.slice(0, nl).trim();
          input = input.slice(nl + 1);
          if (line) this.messages.push(JSON.parse(line) as RpcMessage);
          for (const wake of this.waiters.splice(0)) wake();
        }
        callback();
      },
    });
  }

  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });

  async next(method: string, timeoutMs = 1_000): Promise<RpcMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find((m) => m.method === method && !this.consumed.has(m));
      if (found) {
        this.consumed.add(found);
        return found;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${method}`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  reply(request: RpcMessage, result: unknown): void {
    this.push({ id: request.id, result });
  }

  push(message: RpcMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

const OPTS: SessionOpts = {
  cli: { bin: "codex", pathEnv: "/usr/bin" },
  model: "gpt-5.6-sol",
  effort: "medium",
  cwd: "/vault",
  permissionMode: "default",
  toolsEnabled: true,
  fastStartup: true,
  sandboxMode: "workspace-write",
  approvalPolicy: "on-request",
};

async function readySession(
  overrides: Partial<SessionOpts> = {},
  runtimeOverrides: Partial<CodexSessionRuntime> = {},
): Promise<{ session: CodexSession; child: FakeCodexProcess }> {
  const child = new FakeCodexProcess();
  const runtime: CodexSessionRuntime = {
    spawn: vi.fn(() => child as never),
    requestTimeoutMs: 500,
    turnStartTimeoutMs: 500,
    ...runtimeOverrides,
  };
  const session = new CodexSession({ ...OPTS, ...overrides }, runtime);
  const init = await child.next("initialize");
  child.reply(init, { userAgent: "codex-test" });
  await child.next("initialized");
  const thread = await child.next(overrides.resumeSessionId ? "thread/resume" : "thread/start");
  child.reply(thread, { thread: { id: overrides.resumeSessionId ?? "thread-1" } });
  return { session, child };
}

async function startTurn(
  session: CodexSession,
  child: FakeCodexProcess,
  events: AgentEvent[],
): Promise<{ turn: Promise<void> }> {
  const turn = session.send("hello", (event) => events.push(event));
  const start = await child.next("turn/start");
  child.reply(start, { turn: { id: "turn-1" } });
  child.push({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
  return { turn };
}

describe("CodexSession app-server lifecycle", () => {
  it("keeps one process and thread warm across turns while streaming real deltas", async () => {
    const { session, child } = await readySession();
    const firstEvents: AgentEvent[] = [];
    const { turn: first } = await startTurn(session, child, firstEvents);
    child.push({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello" },
    });
    child.push({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          last: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 0 },
          total: { totalTokens: 120, inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 0 },
          modelContextWindow: 258_400,
        },
      },
    });
    child.push({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });
    await first;

    expect(firstEvents).toContainEqual({ kind: "text-delta", text: "hello" });
    expect(firstEvents).toContainEqual({ kind: "usage", usage: { used: 120, total: 258_400 } });
    expect(session.lastTurnTokens()).toBe(120);

    const secondEvents: AgentEvent[] = [];
    const second = session.send("again", (event) => secondEvents.push(event));
    const secondStart = (await child.next("turn/start"));
    const turnStarts = child.messages.filter((message) => message.method === "turn/start");
    expect(turnStarts).toHaveLength(2);
    child.reply(secondStart, { turn: { id: "turn-2" } });
    child.push({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-2" } } });
    child.push({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-2", status: "completed", items: [] } },
    });
    await second;
    expect(secondEvents).toContainEqual({ kind: "turn-end", sessionId: "thread-1" });
    session.dispose();
  });

  it("interrupts only the active turn and can send again on the same session", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const { turn } = await startTurn(session, child, events);
    session.interrupt();
    const interrupt = await child.next("turn/interrupt");
    expect(interrupt.params).toMatchObject({ threadId: "thread-1", turnId: "turn-1" });
    child.reply(interrupt, {});
    child.push({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", items: [] } },
    });
    await turn;
    expect(events.some((event) => event.kind === "error")).toBe(false);

    const next = session.send("next", () => {});
    const request = await child.next("turn/start");
    child.reply(request, { turn: { id: "turn-2" } });
    child.push({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-2" } } });
    child.push({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-2", status: "completed", items: [] } },
    });
    await next;
    session.dispose();
  });

  it("routes command approvals through Exo permission decisions", async () => {
    const { session, child } = await readySession();
    const events: AgentEvent[] = [];
    const { turn } = await startTurn(session, child, events);
    child.push({
      id: 88,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "git status",
        cwd: "/vault",
        startedAtMs: Date.now(),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const approval = events.find((event) => event.kind === "permission-request");
    expect(approval).toBeDefined();
    if (approval?.kind === "permission-request") approval.resolve({ behavior: "allow", remember: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(child.messages).toContainEqual({ id: 88, result: { decision: "acceptForSession" } });

    child.push({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });
    await turn;
    session.dispose();
  });

  it("supports steer and native compact on the live thread", async () => {
    const { session, child } = await readySession();
    const { turn } = await startTurn(session, child, []);
    expect(session.steer("change course")).toBe(true);
    const steer = await child.next("turn/steer");
    expect(steer.params).toMatchObject({ threadId: "thread-1", expectedTurnId: "turn-1" });
    child.reply(steer, {});

    child.push({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
    });
    await turn;
    session.compact("keep decisions");
    const compact = await child.next("thread/compact/start");
    expect(compact.params).toEqual({ threadId: "thread-1" });
    session.dispose();
  });

  it("fails a silent initialization instead of leaving the UI on Thinking forever", async () => {
    const child = new FakeCodexProcess();
    const session = new CodexSession(OPTS, {
      spawn: vi.fn(() => child as never),
      requestTimeoutMs: 20,
      turnStartTimeoutMs: 20,
    });
    await expect(session.send("hello", () => {})).rejects.toThrow(/initialize.*timed out/i);
    expect(child.kill).toHaveBeenCalled();
  });
});
