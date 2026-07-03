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

/**
 * Inputs to the two-stage session-recovery reducer, read straight off the turn.
 * `poisoned` — an in-band error_during_execution or a thrown recoverable session
 * error marked the live session dead. `stopped` — the user pressed Stop.
 * `isRecoveryRetry` — this turn was itself the stage-2 recap retry. `resumeRisky`
 * — a prior crash already put the convo on the resume-first ladder.
 */
export type RecoveryInput = {
  poisoned: boolean;
  stopped: boolean;
  isRecoveryRetry: boolean;
  resumeRisky: boolean;
};

/**
 * The decision, single-sourced so the four call sites in view.ts (in-band error,
 * catch path, finally ladder, footer text) can never drift apart again.
 *
 * `footer` — exact text rendered under a poisoned turn (null ⇒ no recovery footer).
 * `session` — how to treat the live session at turn end: "none" (leave it),
 * "drop-keep-id" (drop the crashed live object but keep the sessionId so the next
 * message resumes the transcript), "drop-clear-id" (nuclear — drop everything,
 * next message is fresh). `nextResumeRisky` — the value to assign to the convo's
 * resumeRisky flag. `enqueueRecapRetry` — stage-2 only: auto-retry the same user
 * message once with a private recap threaded to the provider.
 */
export type RecoveryPlan = {
  footer: string | null;
  session: "none" | "drop-keep-id" | "drop-clear-id";
  nextResumeRisky: boolean;
  enqueueRecapRetry: boolean;
};

/**
 * Pure reducer for the two-stage (resume-first → fresh+recap → nuclear) session
 * recovery. Mirrors the original hand-synchronized logic in `view.ts` exactly:
 *
 * - `poisoned && !stopped` enters the ladder:
 *   - `isRecoveryRetry` → nuclear reset (drop + clear id, footer promises a fresh
 *     session next message).
 *   - else `resumeRisky` → stage 2: fresh + clear id + enqueue a recap retry.
 *   - else → stage 1: drop the live object but KEEP the id (next message resumes),
 *     arm resumeRisky so a second consecutive poison escalates.
 * - `!poisoned` → healthy/user-stopped-without-poison turn: clear resumeRisky so a
 *   future isolated crash starts from stage 1. No session action, no footer.
 * - `poisoned && stopped` → the ladder is NOT entered (gated `poisoned && !stopped`
 *   in the original); resumeRisky is left as-is. No session action, no footer.
 */
export function resolveRecovery(s: RecoveryInput): RecoveryPlan {
  const { poisoned, stopped, isRecoveryRetry, resumeRisky } = s;
  if (poisoned && !stopped) {
    if (isRecoveryRetry) {
      // The stage-2 recap retry itself poisoned — nuclear reset (loop guard).
      return {
        footer: "The next message starts a fresh session.",
        session: "drop-clear-id",
        nextResumeRisky: false,
        enqueueRecapRetry: false,
      };
    }
    if (resumeRisky) {
      // Stage 2: a prior resume re-errored — go fully fresh AND auto-retry with a recap.
      return {
        footer: "Resume failed — restarting fresh with a recap of this conversation.",
        session: "drop-clear-id",
        nextResumeRisky: false,
        enqueueRecapRetry: true,
      };
    }
    // Stage 1 (resume-first): drop the live object, keep the id, arm the ladder.
    return {
      footer: "Session process crashed — your next message resumes it.",
      session: "drop-keep-id",
      nextResumeRisky: true,
      enqueueRecapRetry: false,
    };
  }
  if (!poisoned) {
    // Healthy (or user-stopped without a poison) — reset the recovery ladder.
    return { footer: null, session: "none", nextResumeRisky: false, enqueueRecapRetry: false };
  }
  // poisoned && stopped — ladder not entered; resumeRisky untouched.
  return { footer: null, session: "none", nextResumeRisky: resumeRisky, enqueueRecapRetry: false };
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
