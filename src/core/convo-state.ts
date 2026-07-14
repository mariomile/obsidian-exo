/**
 * Plugin-level convo-state channel — the ONE synchronous, in-memory notification
 * bus by which ChatView tells the (optional) Orchestration Board how a
 * conversation's turn lifecycle is moving. Pure: no Obsidian imports, so it's
 * unit-testable in isolation.
 *
 * Design mirrors `noteVaultWrite()` (src/main.ts) exactly: emitting is
 * synchronous and side-effect-free for chat — it can NEVER block, delay, or
 * throw back into a turn. The board observes; chat never depends on the board
 * (one-way dependency, per the isolation contract in
 * docs/superpowers/specs/2026-07-08-orchestration-board-design.md).
 *
 * Two hard guarantees the ChatView hook sites rely on:
 *   1. **Flag guard.** When orchestration is disabled the channel is a strict
 *      no-op — `emit()` returns immediately and NO listener code runs at all.
 *      Runtime behavior is identical to a build without the board.
 *   2. **Listener isolation.** Every listener invocation is wrapped in its own
 *      try/catch, so a crashing subscriber (e.g. a board render bug) is
 *      completely invisible to chat and cannot stop sibling listeners.
 */

/** The turn-lifecycle states a conversation can report. Mirrors the orchestrator's
 *  `ConvoEvent` vocabulary (see src/core/orchestrator.ts). */
export type ConvoState = "turn-start" | "turn-end" | "needs-input" | "stopped" | "error";

/** Why a conversation entered `needs-input`/`stopped`, surfaced as a board badge.
 *  Free-form on this channel (chat-side vocabulary); the board driver maps it to
 *  the orchestrator's `InputReason`. */
export type ConvoStateReason = "perm" | "ask" | "error" | "stopped";

/** A single notification: which conversation, what state, and (optionally) why. */
export interface ConvoStateEvent {
  convoId: string;
  state: ConvoState;
  reason?: ConvoStateReason;
}

/** Fire-and-forget observer of convo-state notifications. It MUST NOT assume it
 *  can influence chat: throwing is caught and swallowed by the channel. */
export type ConvoStateListener = (event: ConvoStateEvent) => void;

/** Unsubscribe handle returned by `subscribe`. Idempotent. */
export type Unsubscribe = () => void;

/**
 * Pure mapping from a turn's terminal flags to the board vocabulary, single-
 * sourced so the ChatView `finally` hook and its tests can't drift:
 *   - user-stopped     → `stopped`      (reason `stopped`)
 *   - errored/poisoned → `needs-input`  (reason `error`)
 *   - clean            → `turn-end`     (→ Review, no reason)
 * `stopped` wins over `poisoned` (a turn the user stopped reads as a stop, not
 * an error).
 */
export function terminalConvoState(flags: {
  stopped: boolean;
  poisoned: boolean;
}): { state: ConvoState; reason?: ConvoStateReason } {
  if (flags.stopped) return { state: "stopped", reason: "stopped" };
  if (flags.poisoned) return { state: "needs-input", reason: "error" };
  return { state: "turn-end" };
}

export class ConvoStateChannel {
  private readonly listeners = new Set<ConvoStateListener>();

  /**
   * @param isEnabled Read live on every `emit()` — typically
   *   `() => settings.orchestrationEnabled`. When it returns false the channel
   *   is a strict no-op.
   */
  constructor(private readonly isEnabled: () => boolean) {}

  /** Register a listener. Returns an idempotent unsubscribe handle. */
  subscribe(listener: ConvoStateListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Notify listeners that `convoId` moved to `state`. Synchronous, in-memory,
   * and — like `noteVaultWrite()` — unable to block or delay a turn. Returns
   * immediately (running NO listener code) when orchestration is disabled. Each
   * listener runs in its own try/catch so one crashing observer is invisible to
   * chat and to sibling observers.
   */
  emit(convoId: string, state: ConvoState, detail?: { reason?: ConvoStateReason }): void {
    if (!this.isEnabled()) return;
    const event: ConvoStateEvent = detail?.reason
      ? { convoId, state, reason: detail.reason }
      : { convoId, state };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // A board-side crash must never surface in chat — but log it, so a
        // silently-throwing observer is debuggable rather than invisible.
        console.error("[exo] convo-state listener threw", err);
      }
    }
  }
}
