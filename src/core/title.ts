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
