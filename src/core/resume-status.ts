/**
 * Resume status — whether a conversation would pick up its full context or
 * start from nothing. Pure (no `obsidian`, no DOM, no filesystem) so the
 * classification and the path encoding are testable without touching a disk.
 *
 * Two stores back a conversation and they have independent lifecycles: Exo owns
 * the transcript you read, the Claude CLI owns the session that makes resuming
 * actually work. Deleting a chat here leaves the session behind; the session
 * expiring leaves the chat looking perfectly fine while resume has silently
 * died. This module makes the second case visible, which is the dangerous one:
 * nothing warns you today, you find out by writing.
 */

/** What would happen if the user wrote in this conversation right now. */
export type ResumeStatus =
  /** The session is on disk: it picks up with full context. */
  | "resumable"
  /** No session to resume: writing starts a fresh one with no memory of the turn. */
  | "restarts"
  /** The session store could not be read. NOT the same as "restarts" — see below. */
  | "unknown";

/**
 * The Claude CLI's per-project directory name, derived from the working
 * directory it was launched in: every non-alphanumeric character becomes a
 * dash. Verified against real directories for a path containing a space and a
 * path containing a dot before this was written.
 *
 * Deliberately NOT collapsing runs of dashes: `/a//b` is `-a--b` on disk, and
 * collapsing would point at a directory that does not exist — which would make
 * every conversation read as `restarts`, the exact false alarm this feature
 * must never produce.
 */
export function projectDirName(vaultPath: string): string {
  return vaultPath.replace(/[^a-zA-Z0-9]/g, "-");
}

/** The only field this needs from a conversation. Structural, so the module
 *  stays ignorant of the view's `Convo` type. */
export interface ResumableConvo {
  sessionId?: string;
}

/**
 * Classify one conversation against the set of session ids present on disk.
 *
 * `onDisk === null` means the read failed or the directory is absent, and it
 * returns `unknown` for everything. This is the load-bearing case: reporting a
 * failed read as `restarts` would put a false warning on every conversation in
 * the history at once, which is worse than showing nothing. Absence of evidence
 * is not evidence of absence, and the UI treats the two differently.
 */
export function resumeStatus(c: ResumableConvo, onDisk: ReadonlySet<string> | null): ResumeStatus {
  if (onDisk === null) return "unknown";
  if (!c.sessionId) return "restarts";
  return onDisk.has(c.sessionId) ? "resumable" : "restarts";
}
