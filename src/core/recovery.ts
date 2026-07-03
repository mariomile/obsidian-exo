/**
 * Session-recovery pure logic — extracted verbatim from `view.ts`.
 */
import type { Message } from "./model";

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
