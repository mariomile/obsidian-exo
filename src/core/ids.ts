/**
 * Conversation-id seeding and duplicate repair — extracted verbatim from
 * `view.ts`'s `restore()`.
 *
 * The production bug this pins: the id counter must seed from the highest
 * numeric id suffix present, NOT the conversation count. Ids climb past the
 * count after deletions and MAX_CONVOS trimming, so a count-based seed produces
 * colliding ids (the real incident: five conversations all sharing id "c31").
 */

/** Highest N across ids shaped `c<N>` (ignores anything else). 0 if none. */
export function maxIdSuffix(ids: (string | undefined | null)[]): number {
  let max = 0;
  for (const id of ids) {
    const m = typeof id === "string" ? /^c(\d+)$/.exec(id) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** A stateful id allocator that mints monotonically increasing `c<N>` ids and
 *  repairs duplicates. Mirrors the module-global `convoSeed` counter semantics
 *  in `view.ts`: `assign` keeps the first occurrence's id and reassigns a fresh
 *  unique id on collision or when missing; `next` mints a brand-new id. */
export interface IdAllocator {
  /** De-duplicated id for a stored convo. First occurrence keeps its id; a
   *  collision (or a missing id) gets a fresh minted id. `seen` is caller-owned
   *  so it can span exactly one restore pass. */
  assign(id: string | undefined, seen: Set<string>): string;
  /** Mint a fresh, never-before-used id. */
  next(): string;
  /** Current counter value (sync back into the module-global seed). */
  readonly seed: number;
}

export function makeIdAllocator(seed: number): IdAllocator {
  let counter = seed;
  return {
    assign(id: string | undefined, seen: Set<string>): string {
      let out = id || `c${++counter}`;
      if (seen.has(out)) out = `c${++counter}`;
      seen.add(out);
      return out;
    },
    next(): string {
      return `c${++counter}`;
    },
    get seed() {
      return counter;
    },
  };
}
