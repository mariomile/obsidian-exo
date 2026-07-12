/**
 * Pure token parsing for the composer autocomplete. Given the text before the
 * caret, find the trigger token to complete (`/cmd`, `$skill`, `@path`).
 *
 * Space-allowing triggers (the `@` file picker — vault file names use spaces)
 * keep matching past whitespace so a multi-word query can refine the search;
 * the token is bounded by the line start/newline and by the trigger char
 * itself (so the LAST `@` on the line wins). When both a space-allowing and a
 * word-bound trigger match, the one closer to the caret wins.
 */

export interface AcTriggerSpec {
  trigger: string; // single char, e.g. "/" or "@"
  allowSpaces?: boolean;
}

export interface AcToken {
  trigger: string;
  query: string;
  /** Index of the trigger char in the text before the caret. */
  start: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parseAcToken(before: string, specs: AcTriggerSpec[]): AcToken | null {
  let best: AcToken | null = null;
  for (const s of specs) {
    const t = escapeRe(s.trigger);
    const re = s.allowSpaces
      ? new RegExp(`(^|\\s)${t}([^${t}\\n]*)$`)
      : new RegExp(`(^|\\s)${t}([^\\s]*)$`);
    const m = before.match(re);
    if (!m) continue;
    const query = m[2];
    const start = before.length - query.length - 1;
    if (!best || start > best.start) best = { trigger: s.trigger, query, start };
  }
  return best;
}

/** Split a query into lowercase words for AND-matching ("mario mil" → both must match). */
export function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** True when every word appears somewhere in `haystack` (case-insensitive). */
export function matchesWords(haystack: string, words: string[]): boolean {
  if (words.length === 0) return true;
  const lc = haystack.toLowerCase();
  return words.every((w) => lc.includes(w));
}
