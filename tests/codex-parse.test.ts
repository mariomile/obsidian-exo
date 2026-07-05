import { describe, expect, it } from "vitest";
import { handleCodexLine, type CodexParseState } from "../src/providers/codex";
import type { AgentEvent } from "../src/providers/types";

function run(lines: string[]): { events: AgentEvent[]; state: CodexParseState } {
  const events: AgentEvent[] = [];
  const state: CodexParseState = { streamed: false, finalText: "" };
  for (const line of lines) handleCodexLine(line, state, (e) => events.push(e));
  return { events, state };
}

describe("handleCodexLine — new codex exec --json schema (0.142.x)", () => {
  it("captures thread id as session id", () => {
    const { state } = run(['{"type":"thread.started","thread_id":"019f31cf-ec54-7fd3-9256-b7cbbd02c168"}']);
    expect(state.sessionId).toBe("019f31cf-ec54-7fd3-9256-b7cbbd02c168");
  });

  it("emits text for completed agent messages, separating multiple messages", () => {
    const { events, state } = run([
      '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Eseguo il comando."}}',
      '{"type":"item.completed","item":{"id":"item_5","type":"agent_message","text":"```text\\nhello-exo\\n```"}}',
    ]);
    const texts = events.filter((e) => e.kind === "text-delta").map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["Eseguo il comando.", "\n\n```text\nhello-exo\n```"]);
    expect(state.streamed).toBe(true);
  });

  it("maps command_execution start/end to Bash tool events", () => {
    const { events } = run([
      '{"type":"item.started","item":{"id":"item_4","type":"command_execution","command":"echo hi","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_4","type":"command_execution","command":"echo hi","aggregated_output":"hi\\n","exit_code":0,"status":"completed"}}',
    ]);
    expect(events[0]).toEqual({ kind: "tool-call-start", id: "item_4", name: "Bash", input: { command: "echo hi" } });
    expect(events[1]).toEqual({ kind: "tool-call-result", id: "item_4", ok: true, output: "hi\n" });
  });

  it("flags failed commands", () => {
    const { events } = run([
      '{"type":"item.completed","item":{"id":"item_9","type":"command_execution","command":"false","aggregated_output":"","exit_code":1,"status":"completed"}}',
    ]);
    expect(events[0]).toMatchObject({ kind: "tool-call-result", ok: false });
  });

  it("maps file_change items to Edit tool events", () => {
    const { events } = run([
      '{"type":"item.started","item":{"id":"item_6","type":"file_change","changes":[{"path":"a.md","kind":"add"}],"status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_6","type":"file_change","changes":[{"path":"a.md","kind":"add"}],"status":"completed"}}',
    ]);
    expect(events[0]).toEqual({ kind: "tool-call-start", id: "item_6:a.md", name: "Edit", input: { file_path: "a.md" } });
    expect(events[1]).toEqual({ kind: "tool-call-result", id: "item_6:a.md", ok: true, output: "" });
  });

  it("emits reasoning as thinking-delta", () => {
    const { events } = run(['{"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"pondering"}}']);
    expect(events[0]).toEqual({ kind: "thinking-delta", text: "pondering" });
  });

  it("surfaces error items", () => {
    const { events } = run(['{"type":"item.completed","item":{"id":"item_0","type":"error","message":"boom"}}']);
    expect(events[0]).toEqual({ kind: "error", message: "boom" });
  });

  it("surfaces turn.failed errors", () => {
    const { events } = run(['{"type":"turn.failed","error":{"message":"model exploded"}}']);
    expect(events[0]).toEqual({ kind: "error", message: "model exploded" });
  });

  it("ignores noise lines without crashing", () => {
    const { events } = run(["not json", '{"type":"turn.started"}', '{"type":"turn.completed","usage":{"input_tokens":1}}']);
    expect(events).toEqual([]);
  });
});

describe("handleCodexLine — legacy msg schema", () => {
  it("still handles agent_message_delta and session_id", () => {
    const { events, state } = run(['{"session_id":"abc","msg":{"type":"agent_message_delta","delta":"hi"}}']);
    expect(events[0]).toEqual({ kind: "text-delta", text: "hi" });
    expect(state.sessionId).toBe("abc");
    expect(state.streamed).toBe(true);
  });

  it("still buffers final agent_message for close-time fallback", () => {
    const { state } = run(['{"msg":{"type":"agent_message","message":"final"}}']);
    expect(state.finalText).toBe("final");
  });

  it("still maps exec_command begin/end", () => {
    const { events } = run([
      '{"msg":{"type":"exec_command_begin","call_id":"c1","command":["echo","hi"]}}',
      '{"msg":{"type":"exec_command_end","call_id":"c1","exit_code":0,"aggregated_output":"hi"}}',
    ]);
    expect(events[0]).toMatchObject({ kind: "tool-call-start", id: "c1", name: "Bash" });
    expect(events[1]).toMatchObject({ kind: "tool-call-result", id: "c1", ok: true, output: "hi" });
  });
});
