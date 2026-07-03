/**
 * Session-recovery pure logic — extracted verbatim from `view.ts`.
 */
import type { Message } from "./model";

/**
 * True when an error message signals a *recoverable* session death — the kind
 * the two-stage resume/fresh+recap machine can heal, as opposed to a generic
 * API/usage error that should just surface.
 *
 * Matches (case-insensitive): an expired / missing / invalid session, a crashed
 * CLI process ("process exited with code …"), and a failed/errored resume
 * attempt. A plain API error (e.g. "API error 400: bad request") must NOT match.
 */
export function isRecoverableSessionError(msg: string): boolean {
  const m = (msg || "").toLowerCase();
  if (/session expired|session not found|invalid session|session invalid|process exited with code/.test(m)) {
    return true;
  }
  // A resume that itself failed/errored is recoverable (escalates to fresh+recap).
  if (m.includes("resume") && (m.includes("failed") || m.includes("error"))) return true;
  return false;
}

/** Build a compact plaintext recap of the recent transcript, used to re-seed a
 *  FRESH session after a resume also failed (Stage 2 recovery). Threaded to the
 *  provider only — never rendered, queued, or persisted. Takes the last ≤8
 *  entries: user messages truncated to 400 chars, assistant messages as their
 *  concatenated text (≤600 chars) with tool activity summarized as [N tool
 *  calls]. The whole recap is capped at ~5000 chars, dropping oldest first. */
export function buildRecap(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages.slice(-8)) {
    if (m.role === "user") {
      lines.push(`[user] ${m.text.slice(0, 400)}`);
    } else {
      let toolCount = 0;
      const texts: string[] = [];
      for (const seg of m.segments) {
        if (seg.t === "text") texts.push(seg.md);
        else if (seg.t === "tool") toolCount++;
      }
      let body = texts.join("").slice(0, 600);
      if (toolCount > 0) body += (body ? " " : "") + `[${toolCount} tool calls]`;
      lines.push(`[assistant] ${body}`);
    }
  }
  // Cap the body at ~5000 chars, dropping the oldest lines first.
  let body = lines.join("\n");
  while (body.length > 5000 && lines.length > 1) {
    lines.shift();
    body = lines.join("\n");
  }
  return (
    "<conversation-recap>\n" +
    "The previous session process crashed (error_during_execution); this fresh " +
    "session continues an ongoing conversation. Recent transcript (oldest first):\n" +
    body +
    "\n</conversation-recap>"
  );
}
