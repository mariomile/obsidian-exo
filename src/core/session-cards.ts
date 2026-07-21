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
 *
 * Lane model (hybrid): running / needs-input are AUTO-derived from runtime state
 * (you always see what needs attention); when the chat is idle the card sits in
 * its manually-assigned column (`boardStatus`, default review), so you can drag a
 * chat to Review/Done to organize it. A stopped/error badge is independent of the
 * lane.
 */
import type { Recap } from "./recap";
import type { TaskStatus } from "./tasks";

/** Columns a session-card can occupy. `running`/`needs-input` are auto-derived
 *  from runtime; the others are assigned manually by dragging. Excludes the
 *  hidden `archived` status — archiving is a separate flag + the × action. */
export type SessionLane = Exclude<TaskStatus, "archived">;

/** Why a card is in `needs-input` — surfaced as the reason badge, mirroring the
 *  task-card `inputReason` chip. */
export type NeedsInputReason = "perm" | "ask";

/** A non-lane annotation shown on an idle card: the last turn was user-stopped or
 *  it errored/poisoned. Independent of the lane, so a stopped chat can still sit
 *  in whatever column you dragged it to. */
export type SessionBadge = "stopped" | "error";

/**
 * The raw per-convo signals the board reads off a live `Convo`. The lane is NOT
 * pre-computed here — `deriveLane` owns the precedence so the streaming+pending
 * coexistence rule and the manual-vs-auto hybrid live in ONE tested place.
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
  /** Manually-assigned column (persisted). When set and the chat is idle, the
   *  card sits here instead of the default `review` lane. */
  boardStatus?: SessionLane;
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

/** `deriveLane`'s result — `lane` is `"idle"` when no card should be rendered. */
export interface DerivedLane {
  lane: SessionLane | "idle";
  reason?: NeedsInputReason;
  badge?: SessionBadge;
}

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
 *   2. `streaming` → running. (1) and (2) are the AUTO lanes: they always win, so
 *      a chat that starts working jumps into view regardless of where you parked
 *      it.
 *   3. Otherwise the chat is idle: it sits in its manually-assigned column
 *      (`boardStatus`, default `review`), with an independent stopped/error
 *      badge. `stopped` wins over `poisoned` (a user-stopped turn reads as a
 *      stop, not an error — matches `terminalConvoState`). Empty "New chat"
 *      husks (no messages) produce no card.
 */
export function deriveLane(s: SessionSnapshot): DerivedLane {
  if (s.pendingPerm) return { lane: "needs-input", reason: "perm" };
  if (s.pendingAsk) return { lane: "needs-input", reason: "ask" };
  if (s.streaming) return { lane: "running" };
  if (!s.hasMessages) return { lane: "idle" };
  const badge: SessionBadge | undefined = s.stopped ? "stopped" : s.poisoned ? "error" : undefined;
  return badge ? { lane: s.boardStatus ?? "review", badge } : { lane: s.boardStatus ?? "review" };
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
    const card: SessionCardVM = { id: s.id, title: s.title, lane: d.lane };
    if (d.reason) card.reason = d.reason;
    if (d.badge) card.badge = d.badge;
    if (s.updatedAt !== undefined) card.updatedAt = s.updatedAt;
    if (s.recap) card.recap = s.recap;
    cards.push(card);
  }
  return cards;
}

/**
 * Whether a session-card in `lane` may be archived from its context menu — only a
 * `review` card (a running/needs-input chat shouldn't be archived out of a live
 * turn). Pure so the guard is tested.
 */
export function canArchive(lane: SessionLane): boolean {
  return lane === "review";
}
