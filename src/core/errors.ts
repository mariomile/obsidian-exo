/**
 * Human-readable mapping for known raw CLI failure strings. Turns opaque engine
 * output into a one-line explanation (plus an optional hint) the user can act
 * on, while the caller keeps the raw text as a secondary detail for debugging.
 *
 * Returns `null` for anything unrecognized — the caller then shows the raw text
 * unchanged. All matching is case-insensitive.
 */
export function describeCliFailure(raw: string): { message: string; hint?: string } | null {
  const m = (raw || "").toLowerCase();

  // Auth first: an auth failure can also mention "error"/"exited", so it must win
  // over the generic crash patterns below.
  if (/not logged in|invalid api key|please run \/login|\/login\b|unauthorized|not authenticated/.test(m)) {
    return { message: "The CLI isn't authenticated — run `claude` once in a terminal to log in." };
  }

  // Binary can't be found / launched.
  if (/enoent|command not found|not found|no such file/.test(m)) {
    return { message: "Claude CLI not found — set the binary path in Settings." };
  }

  // Mid-turn engine crash — recoverable, the session resumes on the next message.
  if (/error_during_execution|\[ede_diagnostic\]/.test(m)) {
    return {
      message:
        "The Claude CLI crashed mid-turn — usually transient; your next message resumes the session.",
      hint: "If it keeps happening, update the CLI from Settings.",
    };
  }
  if (/process exited with code/.test(m)) {
    return {
      message:
        "The Claude CLI process exited unexpectedly — usually transient; your next message resumes the session.",
      hint: "If it keeps happening, update the CLI from Settings.",
    };
  }

  return null;
}
