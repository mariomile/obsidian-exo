/** Clean a raw model reply into a usable chat title.
 *
 *  Haiku is asked for a bare 3-6 word title, but models still occasionally wrap
 *  it in quotes/backticks, add a "Title:" preamble, spill onto extra lines, or
 *  end with punctuation. This normalizes all of that deterministically so the
 *  tab label is always tidy — and caps the length so a runaway reply can never
 *  blow out the tab bar. Returns "" when nothing usable remains (caller then
 *  keeps the truncated placeholder). */
export function sanitizeTitle(raw: string, maxLen = 60): string {
  if (!raw) return "";
  // First non-empty line only — ignore any trailing explanation.
  let s = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  // Drop a leading "Title:" / "Chat:" style preamble if the model added one.
  s = s.replace(/^(?:title|chat|topic)\s*[:\-–]\s*/i, "");
  // Strip matched surrounding quotes/backticks, possibly nested/repeated. Handles
  // straight pairs ("" '' ``) and smart pairs with distinct open/close (“ ” ‘ ’).
  let prev: string;
  do {
    prev = s;
    s = s.trim();
    const m = s.match(/^(["'`])([\s\S]*)\1$/) || s.match(/^“([\s\S]*)”$/) || s.match(/^‘([\s\S]*)’$/);
    if (m) s = m[m.length - 1];
  } while (s !== prev);
  // Collapse internal whitespace and trim trailing punctuation.
  s = s.replace(/\s+/g, " ").trim().replace(/[\s.,;:!?…]+$/u, "").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s;
}

/** How a `generateTitle` attempt ended — see main.ts for the instrumentation
 *  that computes these. Distinguishes the internal 90s ceiling firing ("timeout",
 *  confirmed by direct measurement to track cold-spawn cost, not model latency —
 *  see main.ts) from the caller's own signal aborting ("caller-abort", e.g. the
 *  view tearing down) and from any other thrown error ("error", e.g. the CLI
 *  binary can't be resolved) — and, on the non-throwing path, a real reply from
 *  one that survived `sanitizeTitle` as empty. */
export type TitleOutcome = "ok" | "ok-empty" | "timeout" | "caller-abort" | "error";

/** Pure classifier — no I/O, so the four failure modes above can be exercised
 *  directly without spinning up a session. `threw` is whether the attempt's
 *  try block threw/rejected; `timedOut` and `callerAborted` are only meaningful
 *  when `threw` is true; `title` is the sanitized result on the non-throwing
 *  path. */
export function classifyTitleOutcome(opts: {
  threw: boolean;
  timedOut: boolean;
  callerAborted: boolean;
  title: string;
}): TitleOutcome {
  if (opts.threw) {
    if (opts.timedOut) return "timeout";
    if (opts.callerAborted) return "caller-abort";
    return "error";
  }
  return opts.title ? "ok" : "ok-empty";
}

/** Whether a conversation is due for a(nother) AI-title attempt, given its
 *  current retitle state. The original guard was one-shot ("fire once, even
 *  if the call later fails"); this generalizes it to at most `maxAttempts`
 *  (default 2) — if the first attempt timed out or errored and a later
 *  assistant turn lands while the title is still unconfirmed, one more try
 *  is allowed.
 *
 *  `attempts` counts *fires*, not successes — a call that times out still
 *  consumes one, preserving the "fire once, even if the call later fails"
 *  discipline the original guard had, just extended to twice. `applied` is
 *  an explicit flag, set only when a real AI title actually landed and was
 *  swapped in; once true, no further attempt is ever due regardless of
 *  `attempts`. This is deliberately NOT derived by comparing `c.title`
 *  against the shape of a derived placeholder — a user's own text can
 *  coincidentally look exactly like a finished title, and guessing from the
 *  string would either block a legitimate first attempt or, worse, fire an
 *  unwanted retry over a title that is already real. */
export function isAiTitleDue(state: { attempts: number; applied: boolean }, maxAttempts = 2): boolean {
  if (state.applied) return false;
  return state.attempts < maxAttempts;
}
