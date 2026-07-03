import { describe, it, expect } from "vitest";
import { buildRecap, isRecoverableSessionError } from "../src/core/recovery";
import type { Message, Segment } from "../src/core/model";

const user = (text: string): Message => ({ role: "user", text });
const assistant = (segments: Segment[]): Message => ({ role: "assistant", segments });

describe("buildRecap", () => {
  it("wraps the recap in a <conversation-recap> envelope", () => {
    const recap = buildRecap([user("hello")]);
    expect(recap.startsWith("<conversation-recap>\n")).toBe(true);
    expect(recap.endsWith("\n</conversation-recap>")).toBe(true);
    expect(recap).toContain("[user] hello");
  });

  it("includes at most the last 8 messages", () => {
    const msgs: Message[] = Array.from({ length: 12 }, (_, i) => user(`msg${i}`));
    const recap = buildRecap(msgs);
    // msg0..msg3 dropped (only last 8 kept: msg4..msg11).
    expect(recap).not.toContain("[user] msg3");
    expect(recap).toContain("[user] msg4");
    expect(recap).toContain("[user] msg11");
    expect((recap.match(/\[user\]/g) ?? []).length).toBe(8);
  });

  it("truncates user messages to 400 chars", () => {
    const long = "u".repeat(1000);
    const recap = buildRecap([user(long)]);
    expect(recap).toContain(`[user] ${"u".repeat(400)}\n`);
    expect(recap).not.toContain("u".repeat(401));
  });

  it("truncates assistant text to 600 chars", () => {
    const long = "a".repeat(1000);
    const recap = buildRecap([assistant([{ t: "text", md: long }])]);
    expect(recap).toContain(`[assistant] ${"a".repeat(600)}`);
    expect(recap).not.toContain("a".repeat(601));
  });

  it("summarizes tool segments as [N tool calls] rather than inlining them", () => {
    const recap = buildRecap([
      assistant([
        { t: "text", md: "working on it" },
        { t: "tool", name: "Read", input: {}, ok: true, output: "SECRET FILE CONTENTS" },
        { t: "tool", name: "Edit", input: {}, ok: true, output: "more output" },
      ]),
    ]);
    expect(recap).toContain("[assistant] working on it [2 tool calls]");
    // Raw tool output must NOT leak into the recap.
    expect(recap).not.toContain("SECRET FILE CONTENTS");
  });

  it("appends the tool-count with no leading space when there is no text", () => {
    const recap = buildRecap([assistant([{ t: "tool", name: "Read", input: {}, ok: true, output: "x" }])]);
    expect(recap).toContain("[assistant] [1 tool calls]");
  });

  it("caps the body at ~5000 chars, dropping the OLDEST lines first", () => {
    // 8 assistant lines, each a full 600-char text + a tool-call suffix:
    // "[assistant] " (12) + 600 + " [1 tool calls]" (15) = 627 chars/line.
    // 8 lines joined = ~5023 > 5000 → the oldest line (L0) must be dropped.
    const msgs: Message[] = Array.from({ length: 8 }, (_, i) =>
      assistant([
        { t: "text", md: `L${i}-` + "x".repeat(597) }, // 3 + 597 = 600 chars exactly
        { t: "tool", name: "Read", input: {}, ok: true, output: "z" },
      ]),
    );
    const recap = buildRecap(msgs);
    const body = recap.split("transcript (oldest first):\n")[1].replace("\n</conversation-recap>", "");
    expect(body.length).toBeLessThanOrEqual(5000);
    // Oldest surviving lines kept, the earliest dropped: L0 gone, later ones present.
    expect(recap).not.toContain("L0-");
    expect(recap).toContain("L7-");
  });
});

describe("isRecoverableSessionError", () => {
  it.each([
    "Session expired, please start a new one",
    "SESSION NOT FOUND",
    "Error: invalid session id abc123",
    "the session invalid — reauthenticate",
    "process exited with code 1",
    "Process exited with code 143 (SIGTERM)",
    "Failed to resume session",
    "resume attempt returned an error",
  ])("matches recoverable session death: %s", (msg) => {
    expect(isRecoverableSessionError(msg)).toBe(true);
  });

  it.each([
    "API error 400: bad request",
    "Invalid request: missing field 'model'",
    "rate limit exceeded",
    "ENOENT: no such file or directory",
    "you are not logged in",
    "resume", // "resume" alone (no failed/error) must not match
    "",
  ])("does NOT match a generic/non-session error: %s", (msg) => {
    expect(isRecoverableSessionError(msg)).toBe(false);
  });

  it("requires 'session' adjacency — a bare 'invalid' does not match", () => {
    expect(isRecoverableSessionError("invalid model name")).toBe(false);
    expect(isRecoverableSessionError("invalid session")).toBe(true);
  });
});
