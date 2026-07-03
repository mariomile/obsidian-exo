/**
 * Find runs of ≥ `min` consecutive `true` entries in a sequence.
 * Returns [start, end] index pairs (inclusive). Pure helper behind the
 * transcript's progressive-disclosure grouping: at turn end, runs of ≥3
 * consecutive generic tool rows collapse into a closed "N steps" accordion
 * (2026-07-03 feedback — a stack of 4+ "Run command" rows is noise).
 */
export function groupRuns(flags: boolean[], min: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    const on = i < flags.length && flags[i];
    if (on && start === -1) start = i;
    if (!on && start !== -1) {
      if (i - start >= min) out.push([start, i - 1]);
      start = -1;
    }
  }
  return out;
}
