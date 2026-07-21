/**
 * Session-cards — the pure projection that turns the open ChatView's live
 * conversations into cards for the Orchestration Board's "Session Cockpit"
 * surface. UI-free and Obsidian-free so it's unit-testable in isolation (same
 * discipline as `persistence.ts` / `recap.ts`): the board's impure enumerator
 * (`ChatView.listSessionSnapshots`) feeds `SessionSnapshot`s in, this decides
 * lanes/badges/dedup, and `board-view.ts` only renders the result.
 *
 * Decision B (see docs/plans/2026-07-21-session-cockpit.md): a session-card is a
 * live projection over `view.convos[]`, NEVER a row in `tasks.md`. A convo a task
 * already owns is rendered once as the task-card; here it is deduped out.
 */
import type { Recap } from "./recap";

/** The board columns a session-card can occupy. A session-card is always live,
 *  so it never sits in backlog/queued, and "done" stays task-only. */
export type SessionLane = "running" | "needs-input" | "review";

/** Why a card is in `needs-input` — surfaced as the reason badge, mirroring the
 *  task-card `inputReason` chip. */
export type NeedsInputReason = "perm" | "ask";

/** A non-lane annotation shown on a `review` card: the turn was user-stopped or
 *  it errored/poisoned. Distinct from the lane so the 3-column model is intact
 *  (per product decision: stopped/error are badges, not their own lanes). */
export type SessionBadge = "stopped" | "error";

/**
 * The raw per-convo signals the board reads off a live `Convo`. The lane is NOT
 * pre-computed here — `deriveLane` owns the precedence so the streaming+pending
 * coexistence rule lives in ONE tested place.
 */
export interface SessionSnapshot {
  id: string;
  title: string;
  /** A turn is in flight. NOTE: stays true while a permission/ask prompt is
   *  pending mid-turn — which is exactly why pending is checked before it. */
  streaming: boolean;
  pendingPerm: boolean;
  pendingAsk: boolean;
  /** The convo's last turn errored (adapter/poisoned). */
  poisoned: boolean;
  /** The user stopped the last turn (Esc / Stop). */
  stopped: boolean;
  hasMessages: boolean;
  archived: boolean;
  updatedAt?: number;
  /** Optional recap rollup, attached lazily by the board only for rendered cards. */
  recap?: Recap;
}

/** The view-model the board renders. */
export interface SessionCardVM {
  id: string;
  title: string;
  lane: SessionLane;
  reason?: NeedsInputReason;
  badge?: SessionBadge;
  updatedAt?: number;
  recap?: Recap;
}

/** `deriveLane`'s result — includes the `idle` sentinel (no card is rendered). */
export type DerivedLane =
  | { lane: "idle" }
  | { lane: "running" }
  | { lane: "needs-input"; reason: NeedsInputReason }
  | { lane: "review"; badge?: SessionBadge };

/** Anything with an optional owning-convo pointer — the board passes `TaskEntry`s
 *  here, but only `.convo` matters for dedup, so the contract stays minimal. */
export interface TaskLike {
  convo?: string;
}

/**
 * Map a convo's raw signals to a board lane. Precedence is the correctness core:
 *
 *   1. `pendingPerm` / `pendingAsk` → needs-input. This MUST precede `streaming`
 *      because a convo blocked on a permission prompt is still `streaming:true`
 *      (the turn's `finally` hasn't run) — checking streaming first would
 *      mislabel "waiting for you" as Running, defeating the whole cockpit.
 *   2. terminal signals precede streaming (a stopped/errored turn is not
 *      "running"). `stopped` wins over `poisoned`, matching
 *      `terminalConvoState` (a user-stopped turn reads as a stop, not an error).
 *   3. streaming → running; else has-messages → review; else idle (no card).
 */
export function deriveLane(s: SessionSnapshot): DerivedLane {
  if (s.pendingPerm) return { lane: "needs-input", reason: "perm" };
  if (s.pendingAsk) return { lane: "needs-input", reason: "ask" };
  if (s.stopped) return { lane: "review", badge: "stopped" };
  if (s.poisoned) return { lane: "review", badge: "error" };
  if (s.streaming) return { lane: "running" };
  if (s.hasMessages) return { lane: "review" };
  return { lane: "idle" };
}

/**
 * Project live convo snapshots into session-cards, excluding:
 *   - convos a task already owns (dedup by `task.convo === snapshot.id`),
 *   - archived convos (hidden from the board; retrievable via "Show archived"),
 *   - idle convos (empty "New chat" husks — no card until they have a turn).
 * Order is preserved from `snapshots`; the board groups by `lane`.
 */
export function projectSessionCards(
  snapshots: SessionSnapshot[],
  tasks: TaskLike[],
): SessionCardVM[] {
  const claimed = new Set(
    tasks.map((t) => t.convo).filter((c): c is string => typeof c === "string" && c.length > 0),
  );
  const cards: SessionCardVM[] = [];
  for (const s of snapshots) {
    if (s.archived) continue;
    if (claimed.has(s.id)) continue;
    const d = deriveLane(s);
    if (d.lane === "idle") continue;
    cards.push({
      id: s.id,
      title: s.title,
      lane: d.lane,
      ...(d.lane === "needs-input" ? { reason: d.reason } : {}),
      ...(d.lane === "review" && d.badge ? { badge: d.badge } : {}),
      ...(s.updatedAt !== undefined ? { updatedAt: s.updatedAt } : {}),
      ...(s.recap ? { recap: s.recap } : {}),
    });
  }
  return cards;
}

/**
 * Whether a session-card in `lane` may be archived. Only a `review` (turn-ended,
 * idle) card is archivable; archiving a `running`/`needs-input` convo would drop
 * a live turn off the board (and risks the CLI-interrupt-looks-like-crash edge),
 * so it's disabled. Extracted here so the guard is pure and tested.
 */
export function canArchive(lane: SessionLane): boolean {
  return lane === "review";
}
