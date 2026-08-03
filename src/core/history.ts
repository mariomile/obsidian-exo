/**
 * History core — temporal grouping and filter evaluation for the conversation
 * gallery. Pure (no `obsidian`, no DOM) so both policies are testable without
 * mounting the view, same discipline as `retention.ts` and `working-set.ts`.
 *
 * `now` is always a parameter, never read internally: `Date.now()` is banned in
 * this codebase's test-adjacent pure cores (it would make grouping results
 * nondeterministic and untestable), and the caller already has `Date.now()` at
 * the one call site that matters (opening the gallery).
 */

export type TimeGroupLabel = "Today" | "Yesterday" | "This week" | "This month" | "Older";

export interface TimeGroup<T> {
  label: TimeGroupLabel;
  items: T[];
}

export const DAY_MS = 86_400_000;

/** Midnight of the calendar day `ts` falls in, in the local timezone. Exported
 *  because the view's relative-time label has to speak the same date vocabulary
 *  as `groupByTime`: flooring raw 24-hour periods instead would call a chat
 *  retired yesterday at 23:00 "retired today" when read this morning. */
export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Bucket `items` by `updatedAt` relative to `now`, in five fixed buckets, each
 * emitted only when non-empty. Ordering within a bucket is NOT touched — the
 * caller controls it (today: recency-sorted) and re-sorting here would be a
 * silent surprise for a caller that sorted for a reason.
 */
export function groupByTime<T extends { updatedAt?: number }>(items: T[], now: number): TimeGroup<T>[] {
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - DAY_MS;
  const weekStart = todayStart - 7 * DAY_MS;
  const monthStart = todayStart - 30 * DAY_MS;

  const buckets: Record<TimeGroupLabel, T[]> = {
    Today: [],
    Yesterday: [],
    "This week": [],
    "This month": [],
    Older: [],
  };

  for (const item of items) {
    const t = item.updatedAt;
    // A missing updatedAt sorts into "Older" rather than crashing or floating
    // to the top — it is the least-informative bucket, matching the least
    // information the item carries.
    if (t === undefined || t < monthStart) buckets.Older.push(item);
    else if (t >= todayStart) buckets.Today.push(item);
    else if (t >= yesterdayStart) buckets.Yesterday.push(item);
    else if (t >= weekStart) buckets["This week"].push(item);
    else buckets["This month"].push(item);
  }

  const order: TimeGroupLabel[] = ["Today", "Yesterday", "This week", "This month", "Older"];
  return order.filter((label) => buckets[label].length > 0).map((label) => ({ label, items: buckets[label] }));
}

export type HistoryFilter = "open" | "retired" | "archived" | "olderThan30" | "shortConvo" | "restarts";

/** Shape `matchesFilters` needs from a conversation. Structural, not `Convo` —
 *  keeps this module ignorant of the view's types. */
export interface FilterableConvo {
  id: string;
  updatedAt?: number;
  retiredAt?: number;
  archived?: boolean;
  openTabIds: ReadonlySet<string>;
  messages: readonly unknown[];
  /** Precomputed by the caller: writing in this conversation would start from
   *  nothing. Resolved in the view (it needs the filesystem) and passed in as a
   *  fact. Required, not optional: an absent field would silently read as "no",
   *  and the caller that owns the answer must be the one to state it. */
  restarts: boolean;
}

const PREDICATES: Record<HistoryFilter, (c: FilterableConvo, now: number) => boolean> = {
  open: (c) => c.openTabIds.has(c.id),
  // Mirrors retiredFromStrip's contract exactly (Piano 2): retired, not
  // archived, has at least one message, not currently open. The
  // messages.length > 0 clause matters — retiredFromStrip excludes zero-message
  // husks because "counting one would promise a card that does not exist"
  // (working-set.ts); this predicate answers the same "will it show up in the
  // history" question, so it must not drift from that contract. Deliberately
  // NOT windowed here — this filter answers "has it ever left the strip", the
  // group in view.ts applies the shared time window via retiredFromStrip
  // itself (R3).
  retired: (c) => !!c.retiredAt && c.archived !== true && c.messages.length > 0 && !c.openTabIds.has(c.id),
  archived: (c) => c.archived === true,
  // Treats a missing updatedAt as epoch-0 — i.e. always older-than-30 — the
  // same "least information, oldest bucket" convention groupByTime uses for a
  // missing updatedAt. Kept deliberately consistent between the two.
  olderThan30: (c, now) => (c.updatedAt ?? 0) < now - 30 * DAY_MS,
  shortConvo: (c) => c.messages.length < 3,
  // Precomputed rather than derived here: the answer needs the filesystem (the
  // CLI's session store), and this module is pure. The view resolves it once per
  // card per render, with the same call the badge makes, and passes it in — so
  // the chip selects exactly the set the badge marks, by construction rather
  // than by two expressions that happen to agree.
  restarts: (c) => c.restarts,
};

/** A conversation matches when it satisfies EVERY active filter (AND). No
 *  active filters — everything matches, which is today's unfiltered behaviour. */
export function matchesFilters(c: FilterableConvo, active: readonly HistoryFilter[], now: number): boolean {
  return active.every((f) => PREDICATES[f](c, now));
}
