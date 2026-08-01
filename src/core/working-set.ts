/**
 * Working-set core — decides which conversations stay in the tab strip, and how
 * each one looks. Pure (no `obsidian`, no DOM) so both policies are testable in
 * isolation, same discipline as `retention.ts` and `session-cards.ts`.
 *
 * Why a strip cap at all: opening a tab has an immediate motive, closing one has
 * none, so the strip converges on the maximum. The cap is the counter-pressure.
 * It is deliberately count-based and not time-based: retiring only ever happens
 * as a consequence of the user opening something, never while they are away.
 *
 * Retiring is NOT deleting. Since the retention split (see `retention.ts`),
 * leaving the strip has no bearing on whether a conversation survives on disk.
 */
import type { NeedsInputReason } from "./session-cards";

// ---------------------------------------------------------------------------
// Working set
// ---------------------------------------------------------------------------

/** One tab's inputs to the retire decision. */
export interface TabCandidate {
  id: string;
  /** Last time this tab was the focused one. The LRU key — deliberately NOT
   *  `updatedAt`, which only moves on a turn: looking at a tab without typing
   *  must protect it from being retired a moment later. */
  lastActiveAt: number;
  /** Explicit user protection: never retired, and does not count against the cap. */
  pinned: boolean;
  streaming: boolean;
  /** Blocked on a permission or ask prompt. */
  needsInput: boolean;
  /** Unsent composer text or attachments. */
  hasDraft: boolean;
  /** Messages queued behind the current turn. */
  hasQueue: boolean;
}

export interface WorkingSetPlan {
  /** Ids that stay in the strip, in the input's original order. */
  visible: string[];
  /** Ids to retire now, least-recently-active first. */
  retire: string[];
}

/**
 * Decide the strip's contents. `cap` counts only NON-pinned tabs: pinning is how
 * the user opts a tab out of the budget entirely.
 *
 * Exempt tabs are never retired even when over cap — a turn in flight, a blocked
 * prompt, an unsent draft or a queued message all represent work the user has
 * not finished. When every over-cap tab is exempt the strip simply grows; that
 * is correct, and preferable to tearing away live work to satisfy a number.
 */
export function planWorkingSet(
  tabs: TabCandidate[],
  opts: { activeId: string; cap: number },
): WorkingSetPlan {
  const isExempt = (t: TabCandidate): boolean =>
    t.pinned || t.streaming || t.needsInput || t.hasDraft || t.hasQueue || t.id === opts.activeId;

  const overBy = tabs.filter((t) => !t.pinned).length - opts.cap;
  if (overBy <= 0) return { visible: tabs.map((t) => t.id), retire: [] };

  const retire = new Set<string>();
  const byAge = tabs.filter((t) => !isExempt(t)).sort((a, b) => a.lastActiveAt - b.lastActiveAt);
  for (const t of byAge) {
    if (retire.size >= overBy) break;
    retire.add(t.id);
  }

  return {
    // Order is preserved: retiring removes entries, it never reshuffles the
    // strip under the user's cursor.
    visible: tabs.filter((t) => !retire.has(t.id)).map((t) => t.id),
    retire: byAge.filter((t) => retire.has(t.id)).map((t) => t.id),
  };
}

/** Clamp the configured cap. Mirrors `retentionBudgetBytes` in retention.ts:
 *  settings come from a hand-editable data.json, and a 0 / negative / NaN cap
 *  would retire every non-exempt tab in the strip in one go. */
export function stripCap(cap: unknown, fallback: number): number {
  const usable = typeof cap === "number" && Number.isFinite(cap) && cap > 0;
  return Math.floor(usable ? (cap as number) : fallback);
}

/** The slice of a live conversation the strip's decision reads. Structural on
 *  purpose: the real `Convo` carries DOM and sessions, and this file stays free
 *  of both — it only needs to satisfy this shape. */
export interface TabCandidateSource {
  id: string;
  lastActiveAt?: number;
  updatedAt?: number;
  pinned?: boolean;
  streaming: boolean;
  /** Cancel handles for an open permission / ask card — non-null means blocked. */
  pendingPerm: unknown;
  pendingAsk: unknown;
  /** The stashed composer draft, if any. `text` is "" on a pristine composer, so
   *  presence of the object is not evidence of unsent content. */
  draft?: { text: string; images: readonly unknown[]; attached: readonly string[] };
  queue: readonly unknown[];
}

/**
 * Project a conversation onto the retire decision's inputs. Lives here, next to
 * the policy, because this mapping is where a wrong field silently disables an
 * exemption — and an exemption that fails open costs the user their place in a
 * tab that still had work in it.
 *
 * `lastActiveAt` falls back to `updatedAt` (then 0) so conversations restored
 * from a store written before the field existed sort by their last turn instead
 * of all tying at 0 and retiring in arbitrary order.
 */
export function toTabCandidate(c: TabCandidateSource): TabCandidate {
  return {
    id: c.id,
    lastActiveAt: c.lastActiveAt ?? c.updatedAt ?? 0,
    // Strict `=== true`, matching every other site that reads `pinned`.
    pinned: c.pinned === true,
    streaming: c.streaming,
    needsInput: c.pendingPerm != null || c.pendingAsk != null,
    // "Unsent content" is text, attachments OR manually attached context — each
    // of the three is something the user put there and has not sent yet.
    hasDraft:
      !!c.draft && (c.draft.text.trim().length > 0 || c.draft.images.length > 0 || c.draft.attached.length > 0),
    hasQueue: c.queue.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Tab state
// ---------------------------------------------------------------------------

/** The mark's state. `needsInput` is deliberately NOT a member here: it rides a
 *  different visual channel (the whole tab lifts) precisely so it can coexist
 *  with any of these instead of competing for the same slot. */
export type TabState = "idle" | "streaming" | "unread" | "stopped" | "error";

/** The runtime signals a tab renders from. Same shape as the fields
 *  `SessionSnapshot` carries, so the board and the strip read one vocabulary of
 *  signals even though they render different vocabularies of output. */
export interface TabSignals {
  streaming: boolean;
  pendingPerm: boolean;
  pendingAsk: boolean;
  /** A turn completed on this conversation while it was not the active one. */
  unread: boolean;
  stopped: boolean;
  poisoned: boolean;
}

export interface TabVM {
  state: TabState;
  /** The turn is blocked on the user. Composes with `state` rather than
   *  replacing it: "running, but waiting on you" is one tab, two facts. */
  needsInput: boolean;
  reason?: NeedsInputReason;
}

/**
 * Translate runtime signals into the tab's view-model.
 *
 * `needsInput` is computed independently of `state` on purpose. A conversation
 * blocked on a permission prompt is still `streaming: true` — the turn's
 * `finally` has not run (see the same note on `deriveLane`, session-cards.ts).
 * A single enum would have to pick a winner and lose the other fact; two
 * channels report both.
 *
 * State precedence: streaming (it is happening now) > unread (it finished and
 * you have not seen it) > stopped > error. `stopped` beating `error` mirrors
 * `deriveLane`: a user-stopped turn reads as a stop, not a failure.
 */
export function deriveTabState(s: TabSignals): TabVM {
  const reason: NeedsInputReason | undefined = s.pendingPerm ? "perm" : s.pendingAsk ? "ask" : undefined;
  const needsInput = reason !== undefined;

  const state: TabState = s.streaming
    ? "streaming"
    : s.unread
      ? "unread"
      : s.stopped
        ? "stopped"
        : s.poisoned
          ? "error"
          : "idle";

  return reason ? { state, needsInput, reason } : { state, needsInput };
}
