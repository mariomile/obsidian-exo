/**
 * Chat-rows — the pure model behind the `exo-chats` sidebar list. UI-free and
 * Obsidian-free so the tiering, search and grouping rules are testable without
 * mounting a view, same discipline as `history.ts` and `session-cards.ts`.
 *
 * Two tiers, one rule each:
 *   - LIVE: `deriveLane` says running or needs-input. Reused verbatim rather
 *     than re-derived, because its precedence (perm → ask → streaming) is the
 *     correctness core: a conversation blocked on a permission prompt is STILL
 *     `streaming: true`, so any local re-implementation that reads streaming
 *     first would label "waiting for you" as "working".
 *   - HISTORY: everything else, bucketed by `groupByTime`.
 *
 * A row never appears in both. `now` is a parameter, never read internally —
 * same rule, and same reason, as `history.ts`.
 */
import { deriveLane, type NeedsInputReason, type SessionBadge } from "./session-cards";
import { groupByTime, type TimeGroup } from "./history";

/** The per-conversation facts the list needs. Structural, not `Convo` — this
 *  module stays ignorant of the view's types, the enumerator adapts. */
export interface ChatRowSource {
  id: string;
  title: string;
  preview: string;
  provider: string;
  model: string;
  updatedAt?: number;
  archived: boolean;
  /** Currently a tab in the strip — drives the active-row highlight. */
  open: boolean;
  // Live signals, consumed by deriveLane.
  streaming: boolean;
  pendingPerm: boolean;
  pendingAsk: boolean;
  poisoned: boolean;
  stopped: boolean;
  hasMessages: boolean;
}

export interface ChatRow {
  id: string;
  title: string;
  preview: string;
  provider: string;
  model: string;
  updatedAt?: number;
  open: boolean;
  /** Present only on live-tier rows. */
  lane?: "running" | "needs-input";
  reason?: NeedsInputReason;
  badge?: SessionBadge;
}

export interface ChatListVM {
  live: ChatRow[];
  groups: TimeGroup<ChatRow>[];
  /** Rows before the query filter. Distinguishes "no chats yet" from "no chats
   *  match" — different empty states, and collapsing them makes a search look
   *  like it deleted the user's data. */
  total: number;
  /** Rows after the query filter, across both tiers. */
  matched: number;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Compact age label for a list row: `now` / `30m` / `19h` / `4d`. Clamped at
 * zero so a clock skew (or a timestamp written a tick into the future) reads as
 * `now` rather than a negative age.
 */
export function relativeTime(ts: number, now: number): string {
  const age = Math.max(0, now - ts);
  if (age < MINUTE) return "now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h`;
  return `${Math.floor(age / DAY)}d`;
}

/** Lane ordering inside the live tier: what blocks on the user outranks what is
 *  merely busy, because only one of the two is waiting on a human. */
const LANE_RANK: Record<"needs-input" | "running", number> = {
  "needs-input": 0,
  running: 1,
};

const byRecency = (a: ChatRow, b: ChatRow): number => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);

function toRow(s: ChatRowSource): ChatRow {
  const row: ChatRow = {
    id: s.id,
    title: s.title,
    preview: s.preview,
    provider: s.provider,
    model: s.model,
    open: s.open,
  };
  if (s.updatedAt !== undefined) row.updatedAt = s.updatedAt;
  return row;
}

/**
 * Build the two-tier list. Order of operations matters: exclusions, then the
 * query filter, then tiering. Filtering before tiering is what lets a
 * zero-match search return `live: []` AND `groups: []`, so the view renders one
 * "no matches" state instead of an empty live tier stacked on empty groups.
 */
export function buildChatList(
  sources: readonly ChatRowSource[],
  opts: { query: string; now: number },
): ChatListVM {
  const visible = sources.filter((s) => !s.archived && deriveLane(s).lane !== "idle");
  const q = opts.query.trim().toLowerCase();
  const matched = q
    ? visible.filter(
        (s) => s.title.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q),
      )
    : visible;

  const live: ChatRow[] = [];
  const history: ChatRow[] = [];

  for (const s of matched) {
    const d = deriveLane(s);
    const row = toRow(s);
    if (d.lane === "running" || d.lane === "needs-input") {
      row.lane = d.lane;
      if (d.reason) row.reason = d.reason;
      live.push(row);
    } else {
      if (d.badge) row.badge = d.badge;
      history.push(row);
    }
  }

  live.sort((a, b) => {
    const rank = LANE_RANK[a.lane as "running" | "needs-input"] - LANE_RANK[b.lane as "running" | "needs-input"];
    return rank !== 0 ? rank : byRecency(a, b);
  });
  // groupByTime deliberately does not sort (history.ts:33-36) — the caller owns
  // the order, so sort before bucketing, not after.
  history.sort(byRecency);

  return {
    live,
    groups: groupByTime(history, opts.now),
    total: visible.length,
    matched: matched.length,
  };
}
