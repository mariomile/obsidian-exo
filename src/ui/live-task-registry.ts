/**
 * The live-task registry — the single owner of `Convo.liveTasks`.
 *
 * Extracted from `view.ts` because every bug this registry has produced came
 * from having more than one door onto the map: a completed Workflow that never
 * got a `doneAt` stamp (so it could never fade), a background Bash that no turn
 * could settle (so Stop left it spinning), a background tab whose rows were
 * wiped because "is the card in the document" was mistaken for "is the turn
 * over". Concentrating the mutations here is what makes those states
 * unreachable rather than merely fixed.
 *
 * Chrome stays in the view: this owns the DATA and calls `onChange` whenever it
 * moves. It holds `cardEl` references but never reads or writes the DOM, so it
 * is testable with plain objects.
 */

import { isSettled, type LiveTaskStatus } from "../core/live-tasks";
import { planLiveTaskSweep, planTurnEndTerminals, type TurnEndReason } from "../core/live-task-lifecycle";
import type { AssistantCtx, Convo, LiveTaskRecord } from "./convo-types";

/** Terminal rows linger this long before eviction, so a done/error/stopped
 *  entry is visible rather than vanishing instantly. */
export const LIVE_FADE_MS = 2000;

export class LiveTaskRegistry {
  /**
   * @param onChange Repaint hook — the count is a rendered fact, so every
   *   mutation has to announce itself. Called at most once per mutation.
   * @param schedule Deferred callback (`window.setTimeout` in the app; a stub
   *   in tests). Returned handle is ignored — but an id CAN be resurrected
   *   (a backgrounded agent's tool result settles the row, then a later
   *   `agent-task` echo re-registers it running), so the eviction re-checks
   *   the row is still settled before removing it.
   */
  constructor(
    private readonly onChange: () => void,
    private readonly schedule: (fn: () => void, ms: number) => void,
  ) {}

  /**
   * Insert or update a task. Stamps `doneAt` and schedules the fade eviction for
   * any non-running status, so every caller gets eviction for free instead of
   * only the ones that remember to ask for it.
   */
  upsert(c: Convo, rec: LiveTaskRecord): void {
    // Only an OUTCOME is stamped and faded. `detached` is neither running nor
    // finished: it must not vanish on a timer, because nothing was shown to the
    // user that two seconds would be enough to read.
    const settled = isSettled(rec.status);
    if (settled) rec.doneAt = Date.now();
    c.liveTasks.set(rec.id, rec);
    this.onChange();
    // Guarded eviction: if the row was resurrected to `running` in the fade
    // window (backgrounded agent — launch ack settled it, a live echo revived
    // it), this stale timer must not reap the living row.
    if (settled) {
      this.schedule(() => {
        const cur = c.liveTasks.get(rec.id);
        if (cur && isSettled(cur.status)) this.remove(c, rec.id);
      }, LIVE_FADE_MS);
    }
  }

  /**
   * Register a task a TURN just started: onto the conversation AND into that
   * turn's ledger. The only door for a NEW task — `upsert` alone puts work on
   * the convo that the turn cannot later settle.
   */
  register(ctx: AssistantCtx, rec: LiveTaskRecord): void {
    ctx.liveTaskIds.add(rec.id);
    this.upsert(ctx.convo, rec);
  }

  /** Move an existing task to a terminal status, keeping its label and card. */
  setStatus(c: Convo, id: string, status: LiveTaskStatus): void {
    const rec = c.liveTasks.get(id);
    if (rec) this.upsert(c, { ...rec, status });
  }

  remove(c: Convo, id: string): void {
    if (c.liveTasks.delete(id)) this.onChange();
  }

  /** Settle everything `ctx` started and can no longer speak for. */
  settleTurn(ctx: AssistantCtx, reason: TurnEndReason): void {
    for (const { id, status } of planTurnEndTerminals(
      [...ctx.convo.liveTasks.values()],
      ctx.liveTaskIds,
      reason,
    )) {
      this.setStatus(ctx.convo, id, status);
    }
  }

  /**
   * Drop faded rows, and rows whose card has left the transcript.
   *
   * `isOrphan` is supplied by the caller because only the view knows which
   * cards are gone — and it must be asked of the CONVERSATION's transcript, not
   * of the document: `switchTo` detaches the whole list of a background tab, so
   * `isConnected` reports every one of its cards as orphaned.
   */
  reconcile(c: Convo, isOrphan: (rec: LiveTaskRecord) => boolean): void {
    const orphans = new Set<string>();
    for (const [id, rec] of c.liveTasks) if (isOrphan(rec)) orphans.add(id);
    const doomed = planLiveTaskSweep([...c.liveTasks.values()], orphans, Date.now(), LIVE_FADE_MS);
    for (const id of doomed) c.liveTasks.delete(id);
    if (doomed.length) this.onChange();
  }
}
