/**
 * Observer cadence — pure core (NO `obsidian` imports).
 *
 * Wave 2-3: lets a long-running session flush the Self-Writing Memory observer
 * every N tool-call steps (Letta-style sleep-time cadence) instead of only at
 * the end of the turn. Two independent pieces of state per conversation:
 *
 *   - `stepCount` — cumulative tool-call steps seen this conversation. Never
 *     resets mid-session; fires at N, 2N, 3N, … for interval N.
 *   - `watermark` — a monotonic position into the conversation's transcript up
 *     to which an observer pass (step OR end-of-turn) has already run. Every
 *     pass covers only the DELTA since the watermark, then advances it — so
 *     content is never handed to the model twice.
 *
 * The "position" unit is opaque to this module — the Obsidian-side wiring
 * picks one (e.g. the step count itself, or a char/turn index) and just needs
 * it to be monotonically increasing; everything here is comparison/ordering
 * on plain numbers.
 */

/** Per-conversation cadence state. Immutable — every function here returns a
 *  NEW state; inputs are never mutated. */
export interface CadenceState {
  readonly stepCount: number;
  readonly watermark: number;
}

/** A fresh conversation's cadence state — no steps seen, nothing covered yet. */
export function initialCadenceState(): CadenceState {
  return { stepCount: 0, watermark: 0 };
}

export interface StepResult {
  state: CadenceState;
  /** True iff this step just crossed an interval boundary — stepCount is now
   *  a positive multiple of `interval` (fires at N, 2N, 3N, …). */
  fired: boolean;
}

/**
 * Record one tool-call step for a conversation. A non-positive or non-finite
 * `interval` never fires (defensive default — callers should validate the
 * setting upstream, but this must never throw or loop).
 */
export function recordStep(state: CadenceState, interval: number): StepResult {
  const stepCount = state.stepCount + 1;
  const n = Number.isFinite(interval) ? Math.floor(interval) : 0;
  const fired = n > 0 && stepCount % n === 0;
  return { state: { stepCount, watermark: state.watermark }, fired };
}

export interface Delta {
  from: number;
  to: number;
}

/**
 * The delta an observer pass should cover: everything from the current
 * watermark up to `position`. `null` when there is nothing new (`position` is
 * not finite, or already at/behind the watermark) — the caller should skip
 * running a pass in that case.
 */
export function pendingDelta(state: CadenceState, position: number): Delta | null {
  if (!Number.isFinite(position) || position <= state.watermark) return null;
  return { from: state.watermark, to: position };
}

/**
 * Advance the watermark to `position` after an observer pass (step or
 * end-of-turn) ran. Monotonic — never moves it backwards even if called with
 * a stale/smaller value — and ignores a non-finite position defensively.
 */
export function advanceWatermark(state: CadenceState, position: number): CadenceState {
  if (!Number.isFinite(position)) return state;
  return { stepCount: state.stepCount, watermark: Math.max(state.watermark, position) };
}

/** What the end-of-turn ("session-end") pass needs to skip content already
 *  covered by step passes: the final watermark reached so far. */
export function finalWatermark(state: CadenceState): number {
  return state.watermark;
}

/**
 * Per-conversation registry keyed by an opaque conversation id. A thin,
 * stateful convenience wrapper the Obsidian-side wiring can hold one instance
 * of for the plugin's lifetime — everything it does is Map bookkeeping over
 * {@link CadenceState}; still no `obsidian` imports.
 */
export class CadenceTracker {
  private byConvo = new Map<string, CadenceState>();

  private stateFor(conversationId: string): CadenceState {
    return this.byConvo.get(conversationId) ?? initialCadenceState();
  }

  /** Record one tool-call step for `conversationId`; returns whether it fired
   *  an interval boundary (N, 2N, 3N, …). */
  step(conversationId: string, interval: number): boolean {
    const { state, fired } = recordStep(this.stateFor(conversationId), interval);
    this.byConvo.set(conversationId, state);
    return fired;
  }

  /** The pending delta for `conversationId` up to `position`, or `null` when
   *  there's nothing new since its watermark. */
  delta(conversationId: string, position: number): Delta | null {
    return pendingDelta(this.stateFor(conversationId), position);
  }

  /** Advance `conversationId`'s watermark to `position` (monotonic). */
  advance(conversationId: string, position: number): void {
    this.byConvo.set(conversationId, advanceWatermark(this.stateFor(conversationId), position));
  }

  /** `conversationId`'s current watermark — what an end-of-turn pass needs. */
  watermarkOf(conversationId: string): number {
    return finalWatermark(this.stateFor(conversationId));
  }

  /** Explicitly restart `conversationId`'s cadence state from zero (e.g. a
   *  conversation id being reused for a brand new conversation). A never-seen
   *  id already starts fresh, so this is only needed to force a restart. */
  reset(conversationId: string): void {
    this.byConvo.delete(conversationId);
  }
}
