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
  /** Currently a tab in the strip. This is what makes a row part of the working
   *  set, not merely a highlight: an open tab is a chat you have deliberately
   *  kept to hand, so it earns a rich row whether or not a turn is running. */
  open: boolean;
  /** Kept to hand across sessions. Independent of `open` — a pin survives
   *  closing the tab, which is the entire point of pinning. */
  pinned: boolean;
  /** Last turn finished while the user was elsewhere — see `unseen` on ChatRow. */
  unseen: boolean;
  /** User turns, not total messages: it answers "how much of this is mine",
   *  which is what makes a conversation feel long or throwaway. */
  messageCount: number;
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
  pinned: boolean;
  messageCount: number;
  /** A turn completed here since the user last had this conversation in view.
   *  The live tier answers "what is happening"; this answers the question that
   *  actually matters more often — "what happened while I was not looking". */
  unseen: boolean;
  /** Present only while the conversation is running or blocked. */
  lane?: "running" | "needs-input";
  reason?: NeedsInputReason;
  badge?: SessionBadge;
}

export interface ChatListVM {
  /** The working set: anything running or blocked, plus every open tab. Rendered
   *  rich — title, preview, provider and model — because these are the rows you
   *  are choosing between right now, and a bare title is not enough to choose. */
  active: ChatRow[];
  /** Pinned but not currently in the working set. A pin that is also open shows
   *  up in `active` instead, with its pin marked, rather than in both places. */
  pinned: ChatRow[];
  /** Everything else, bucketed by day. Rendered compact. */
  groups: TimeGroup<ChatRow>[];
  /** Rows before the query filter. Distinguishes "no chats yet" from "no chats
   *  match" — different empty states, and collapsing them makes a search look
   *  like it deleted the user's data. */
  total: number;
  /** Rows after the query filter, across every tier. */
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

/**
 * Fold a string for matching: lowercase, and strip diacritics so `però` is
 * reachable by typing `pero`. Italian titles are full of accents nobody types
 * into a filter box, and an accent-sensitive search silently hides them.
 */
const fold = (s: string): string =>
  s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

/**
 * Does this conversation match the query? EVERY whitespace-separated token has
 * to appear somewhere in the title or the preview, in any order.
 *
 * Deliberately not a contiguous substring: typing `gbrain garry` should find
 * "GBrain di Garry Tan", and it does not under `includes(query)` because the
 * words are separated by a `di` the user did not remember. Word-order
 * independence is what makes a filter usable from memory rather than from
 * recall of the exact phrasing.
 */
export function matchesQuery(s: { title: string; preview: string }, query: string): boolean {
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = `${fold(s.title)} ${fold(s.preview)}`;
  return tokens.every((t) => hay.includes(t));
}

/** Families rendered as acronyms rather than title-cased words. */
const ACRONYMS = new Set(["gpt", "o1", "o3"]);

/**
 * A model id as a person would say it: `claude-opus-4-8` → `Opus 4.8`,
 * `gpt-5.6-luna` → `GPT 5.6 Luna`.
 *
 * The provider name is stripped when the id repeats it, because the row already
 * has a provider and "Claude · claude-opus-5" spends a third of a 216px sidebar
 * saying Claude twice. Hyphens BETWEEN DIGITS become dots — `4-8` is a version,
 * not two tokens — while hyphens between words stay word breaks.
 */
export function modelLabel(provider: string, model: string): string {
  const raw = model.trim();
  if (!raw) return "";
  const prefix = `${provider.trim().toLowerCase()}-`;
  const body = raw.toLowerCase().startsWith(prefix) ? raw.slice(prefix.length) : raw;
  const parts = body.split("-").filter(Boolean);
  const merged: string[] = [];
  for (const part of parts) {
    const prev = merged[merged.length - 1];
    // A numeric token following a numeric token continues the same version.
    if (prev !== undefined && /^[\d.]+$/.test(prev) && /^\d+$/.test(part)) {
      merged[merged.length - 1] = `${prev}.${part}`;
      continue;
    }
    merged.push(part);
  }
  return merged
    .map((p) => (ACRONYMS.has(p) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ");
}

/**
 * Ordering inside the working set. What blocks on a human outranks what is
 * merely busy, and both outrank a tab that is simply open — the list is read
 * top-down when something needs doing, so the rows that need doing come first.
 * An unseen result sits above an idle tab for the same reason: it is the one
 * row in that band carrying news.
 */
const ACTIVE_RANK = (r: ChatRow): number => {
  if (r.lane === "needs-input") return 0;
  if (r.lane === "running") return 1;
  return r.unseen ? 2 : 3;
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
    pinned: s.pinned,
    unseen: s.unseen,
    messageCount: s.messageCount,
  };
  if (s.updatedAt !== undefined) row.updatedAt = s.updatedAt;
  return row;
}

/**
 * Build the list. Order of operations matters: exclusions, then the query
 * filter, then tiering. Filtering before tiering is what lets a zero-match
 * search return every tier empty, so the view renders one "no matches" state
 * instead of three empty sections stacked on each other.
 *
 * Three tiers, and a row lands in exactly one:
 *   - `active` — running, blocked, or open as a tab. The working set.
 *   - `pinned` — pinned and NOT in the working set. A pin that is also open
 *     belongs in `active`, marked, rather than listed twice: duplicating it
 *     would make the same conversation look like two.
 *   - `groups`  — everything else, by day.
 */
export function buildChatList(
  sources: readonly ChatRowSource[],
  opts: { query: string; now: number },
): ChatListVM {
  const visible = sources.filter((s) => !s.archived && deriveLane(s).lane !== "idle");
  const matched = opts.query.trim() ? visible.filter((s) => matchesQuery(s, opts.query)) : visible;

  const active: ChatRow[] = [];
  const pinned: ChatRow[] = [];
  const history: ChatRow[] = [];

  for (const s of matched) {
    const d = deriveLane(s);
    const row = toRow(s);
    const isLive = d.lane === "running" || d.lane === "needs-input";
    if (isLive) {
      row.lane = d.lane as "running" | "needs-input";
      if (d.reason) row.reason = d.reason;
    }
    // The badge is independent of the lane and survives into any tier: a chat
    // whose last turn errored says so whether it is open, pinned or filed.
    if (d.badge) row.badge = d.badge;
    if (isLive || row.open) active.push(row);
    else if (row.pinned) pinned.push(row);
    else history.push(row);
  }

  active.sort((a, b) => {
    const rank = ACTIVE_RANK(a) - ACTIVE_RANK(b);
    return rank !== 0 ? rank : byRecency(a, b);
  });
  pinned.sort(byRecency);
  // groupByTime deliberately does not sort (history.ts:33-36) — the caller owns
  // the order, so sort before bucketing, not after.
  history.sort(byRecency);

  return {
    active,
    pinned,
    groups: groupByTime(history, opts.now),
    total: visible.length,
    matched: matched.length,
  };
}
