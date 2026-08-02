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

export type TimeGroupLabel = "Oggi" | "Ieri" | "Questa settimana" | "Questo mese" | "Più vecchie";

export interface TimeGroup<T> {
  label: TimeGroupLabel;
  items: T[];
}

const DAY_MS = 86_400_000;

function startOfDay(ts: number): number {
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
    Oggi: [],
    Ieri: [],
    "Questa settimana": [],
    "Questo mese": [],
    "Più vecchie": [],
  };

  for (const item of items) {
    const t = item.updatedAt;
    // A missing updatedAt sorts into "Older" rather than crashing or floating
    // to the top — it is the least-informative bucket, matching the least
    // information the item carries.
    if (t === undefined || t < monthStart) buckets["Più vecchie"].push(item);
    else if (t >= todayStart) buckets["Oggi"].push(item);
    else if (t >= yesterdayStart) buckets["Ieri"].push(item);
    else if (t >= weekStart) buckets["Questa settimana"].push(item);
    else buckets["Questo mese"].push(item);
  }

  const order: TimeGroupLabel[] = ["Oggi", "Ieri", "Questa settimana", "Questo mese", "Più vecchie"];
  return order.filter((label) => buckets[label].length > 0).map((label) => ({ label, items: buckets[label] }));
}

export type HistoryFilter = "open" | "retired" | "archived" | "olderThan30" | "shortConvo";

/** Shape `matchesFilters` needs from a conversation. Structural, not `Convo` —
 *  keeps this module ignorant of the view's types. */
export interface FilterableConvo {
  id: string;
  updatedAt?: number;
  retiredAt?: number;
  archived?: boolean;
  openTabIds: ReadonlySet<string>;
  messages: readonly unknown[];
}

const PREDICATES: Record<HistoryFilter, (c: FilterableConvo, now: number) => boolean> = {
  open: (c) => c.openTabIds.has(c.id),
  // Mirrors retiredFromStrip's contract exactly (Piano 2): retired, not
  // archived, not currently open. Deliberately NOT windowed here — this
  // filter answers "has it ever left the strip", the group in view.ts applies
  // the shared time window via retiredFromStrip itself (R3).
  retired: (c) => !!c.retiredAt && c.archived !== true && !c.openTabIds.has(c.id),
  archived: (c) => c.archived === true,
  olderThan30: (c, now) => (c.updatedAt ?? 0) < now - 30 * DAY_MS,
  shortConvo: (c) => c.messages.length < 3,
};

/** A conversation matches when it satisfies EVERY active filter (AND). No
 *  active filters — everything matches, which is today's unfiltered behaviour. */
export function matchesFilters(c: FilterableConvo, active: readonly HistoryFilter[], now: number): boolean {
  return active.every((f) => PREDICATES[f](c, now));
}
