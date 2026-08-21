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

  // Auth first: an auth failure can also mention "error"/"exited"/"session
  // ended", so it must win over the generic crash + recovery patterns below.
  // Split into two shapes because they call for different UI: an EXPIRED session
  // (was logged in, token lapsed) just needs a re-login, whereas never-logged-in
  // needs first-time setup. `isAuthFailure` unifies detection for the caller.
  if (isAuthExpired(m)) {
    return {
      message: "Your Claude session expired — log back in to continue.",
      hint: "Retrying won't help until you re-authenticate; use the Log in button.",
    };
  }
  if (isAuthMissing(m)) {
    return { message: "The CLI isn't authenticated — log in to continue." };
  }

  // Claude-plan usage limit (claude.ai subscription). Distinct from an API-key
  // "rate limit exceeded" 429 (left to surface raw): these phrasings only appear
  // when a plan's rolling window is exhausted. When the raw text carries a reset
  // clock (HH:MM) or an ISO timestamp, thread it into the hint.
  if (/usage limit|session limit|hit your (session|usage|plan|weekly) limit|reached your (usage|session|weekly) limit/.test(m)) {
    const clock = raw.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
    const iso = raw.match(/\d{4}-\d\d-\d\dT[0-9:.+Z-]+/);
    const when = clock?.[0] ?? iso?.[0];
    return {
      message: "You've hit your Claude plan's usage limit.",
      hint: when
        ? `It resets around ${when}.`
        : "It resets on a rolling window — try again later.",
    };
  }

  // Binary can't be found / launched.
  if (/enoent|command not found|not found|no such file/.test(m)) {
    return { message: "Claude CLI not found — set the binary path in Settings." };
  }

  // The SDK stream disappeared without a final result. Exo has already kept the
  // local transcript and will rebuild the provider process through the recovery
  // ladder, so the useful action is a retry — not a wall of transport detail.
  if (isEndedSessionFailure(m)) {
    return {
      message: "The Claude CLI session ended unexpectedly — retry to resume.",
      hint: "Your conversation is safe; Exo will reconnect with its saved context.",
    };
  }

  // Exo itself reloaded mid-turn (plugin update/reload) — the CLI session is
  // untouched on disk, so this reads exactly like a dropped connection: retry
  // resumes it, nothing was lost.
  if (/session disposed \(view-unload\)/.test(m)) {
    return {
      message: "Exo reloaded mid-response — retry to resume.",
      hint: "Your conversation is safe; Exo will reconnect with its saved context.",
    };
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

/** Exact provider-stream failures that the session recovery ladder can heal. */
export function isEndedSessionFailure(raw: string): boolean {
  return /claude session ended|session stream ended/.test((raw || "").toLowerCase());
}

/** An OAuth/token credential that lapsed while previously authenticated. The CLI
 *  phrases this as "Failed to authenticate: OAuth session expired and could not
 *  be refreshed", "token expired", or "credentials expired". Requires an AUTH
 *  signal (oauth / token / credential / authenticate / refresh) alongside the
 *  expiry — a bare "session expired, start a new one" is a recoverable CLI
 *  session, NOT an auth failure, and must fall through to the recovery ladder. */
export function isAuthExpired(raw: string): boolean {
  const m = (raw || "").toLowerCase();
  const authSignal = /oauth|token|credential|authenticate|authentication|refresh/.test(m);
  return authSignal && /expired|could not be refreshed|couldn't be refreshed|refresh failed/.test(m);
}

/** No usable credentials at all — never logged in, or they were cleared. */
export function isAuthMissing(raw: string): boolean {
  const m = (raw || "").toLowerCase();
  return /not logged in|invalid api key|please run \/login|\/login\b|unauthorized|not authenticated/.test(m);
}

/** Any authentication problem — expired OR missing. The turn runner uses this to
 *  divert an auth failure OUT of the retry/recovery ladder (retrying with dead
 *  credentials just re-fails) and into an actionable re-login card. */
export function isAuthFailure(raw: string): boolean {
  return isAuthExpired(raw) || isAuthMissing(raw);
}
