/**
 * Text folding + word tokenization for unlinked-mention matching.
 *
 * `fold` is copied verbatim from obsidian-sonar's tokenizer (TOKENIZER_VERSION 1)
 * so accent/case normalization is identical to the search index. `wordTokens` is
 * an adapted, leaner variant of Sonar's `tokenize`: it emits ONLY the linear
 * segment tokens (no whole-run compound duplicates), which is what phrase
 * matching over a note body needs — every token carries its exact char offset in
 * the ORIGINAL source text so an inline decoration lands on the right span.
 *
 * No Obsidian imports — pure, unit-testable.
 */

const COMBINING_MARKS = /\p{M}/gu;
const WORD_RUN = /[\p{L}\p{N}]+/gu;

export interface Token {
  /** Folded (diacritics-stripped, lowercased) term used for matching. */
  text: string;
  /** Inclusive start char offset in the ORIGINAL source text. */
  start: number;
  /** Exclusive end char offset in the ORIGINAL source text. */
  end: number;
}

/**
 * Normalize a term for matching: NFKD-decompose, drop combining marks
 * (`perché` → `perche`, `naïve` → `naive`), then lowercase. Applied identically
 * to indexed body tokens and to alias tokens so they compare equal.
 */
export function fold(term: string): string {
  return term.normalize("NFKD").replace(COMBINING_MARKS, "").toLowerCase();
}

function isUpper(ch: string): boolean {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}
function isLower(ch: string): boolean {
  return ch !== ch.toUpperCase() && ch === ch.toLowerCase();
}

/**
 * Split a word run into case-boundary segments as [start, end) offsets relative
 * to the run. Splits only on case transitions, never on letter/digit boundaries
 * (keeps `utf8`, `mp3`, `ES2021` intact):
 *  - lower/digit → Upper            : `chatGpt` → chat | Gpt
 *  - Upper → Upper followed by lower : `HTTPServer` → HTTP | Server
 */
function caseSegments(run: string): Array<[number, number]> {
  const bounds: number[] = [0];
  for (let i = 1; i < run.length; i++) {
    const prev = run[i - 1]!;
    const cur = run[i]!;
    const next = i + 1 < run.length ? run[i + 1]! : "";
    const camel = !isUpper(prev) && isUpper(cur);
    const acronym = isUpper(prev) && isUpper(cur) && isLower(next);
    if (camel || acronym) bounds.push(i);
  }
  bounds.push(run.length);
  const segments: Array<[number, number]> = [];
  for (let i = 0; i < bounds.length - 1; i++) segments.push([bounds[i]!, bounds[i + 1]!]);
  return segments;
}

/**
 * Tokenize source text into a linear stream of folded segment tokens with source
 * offsets. `chatGPT` → `chat`, `gpt`; `Product` → `product`. Tokens whose folded
 * form is empty are dropped. Order matches the source so consecutive tokens can
 * be phrase-matched against a multi-word note title.
 */
export function wordTokens(text: string): Token[] {
  const tokens: Token[] = [];
  let match: RegExpExecArray | null;
  WORD_RUN.lastIndex = 0;
  while ((match = WORD_RUN.exec(text)) !== null) {
    const runStart = match.index;
    const run = match[0];
    for (const [s, e] of caseSegments(run)) {
      const folded = fold(run.slice(s, e));
      if (folded.length > 0) {
        tokens.push({ text: folded, start: runStart + s, end: runStart + e });
      }
    }
  }
  return tokens;
}
