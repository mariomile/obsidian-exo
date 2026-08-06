/**
 * Live-task lifecycle policy — pure, Obsidian-free.
 *
 * `live-tasks.ts` owns the PROJECTION (what the chip reads); this owns the
 * TRANSITIONS (what settles, and what gets evicted). Both were previously
 * inline in `view.ts`, which has no behavioural tests, and both were wrong:
 *
 *  - Turn end swept only `ctx.runningTasks`, which `isSubagentTool` populates
 *    for Task/Agent alone. A background Bash or a Workflow killed by Stop had
 *    no terminal path at all and span forever.
 *  - Eviction treated `cardEl.isConnected` as "the turn is over". But
 *    `switchTo` does `listHost.empty()`, so EVERY card of a background tab is
 *    disconnected — the sweep wiped the live tasks of any conversation the user
 *    wasn't looking at, defeating the keep-alive it was written to protect.
 *    Orphan-ness is now an input the caller computes against the conversation's
 *    own transcript, never inferred from document attachment.
 */

import type { LiveTask, LiveTaskStatus } from "./live-tasks";

/** How a turn ended. `disposed` covers the session going away under it (tab
 *  close, new session in tab, provider switch) — indistinguishable from an
 *  interrupt as far as the work it spawned is concerned. */
export type TurnEndReason = "completed" | "interrupted" | "disposed";

/**
 * Which of a turn's live tasks must be forced terminal now that it has ended.
 *
 * The rule is "settle only what this turn can still speak for":
 *
 *  - Tasks this turn never registered are untouched, whatever the reason. Work
 *    started by an EARLIER turn is exactly what keep-alive L1 exists to
 *    preserve; a later turn ending must not reap it.
 *  - On a clean finish, only subagents are orphaned: a Task/Agent resolves
 *    inside its own turn by definition, so one still running here will never
 *    report back. Background Bash and Workflow runs legitimately outlive the
 *    turn — settling them would be a lie in the other direction.
 *  - On an interrupt or a disposal, everything the turn registered is settled:
 *    the session that owned the work is gone, so nothing can ever report back.
 */
export function planTurnEndTerminals(
  tasks: readonly LiveTask[],
  registeredThisTurn: ReadonlySet<string>,
  reason: TurnEndReason,
): { id: string; status: LiveTaskStatus }[] {
  const out: { id: string; status: LiveTaskStatus }[] = [];
  for (const t of tasks) {
    if (t.status !== "running") continue; // already settled — never re-settle
    if (!registeredThisTurn.has(t.id)) continue; // not this turn's to settle
    if (reason === "completed") {
      if (t.kind !== "subagent") continue; // bash/workflow may still be running
      out.push({ id: t.id, status: "error" }); // never got its result
    } else {
      out.push({ id: t.id, status: "stopped" }); // session gone with the work
    }
  }
  return out;
}

/**
 * Which live tasks to drop from the registry.
 *
 * Two independent reasons, and a task needs only one:
 *
 *  - It is orphaned: its card is gone from the conversation's transcript, so
 *    the row could never be jumped to again. `orphanIds` is supplied by the
 *    caller, which owns the DOM — see the note above on why this must not be
 *    re-derived from `isConnected`.
 *  - It is terminal and its fade window has elapsed, so the user has had time
 *    to see the outcome.
 *
 * A terminal task with no `doneAt` is deliberately KEPT. `liveUpsert` stamps it
 * on every terminal transition, so an unstamped terminal row means something
 * upstream is broken; evicting it on a guessed age would hide that.
 */
export function planLiveTaskSweep(
  tasks: readonly LiveTask[],
  orphanIds: ReadonlySet<string>,
  now: number,
  fadeMs: number,
): string[] {
  const out: string[] = [];
  for (const t of tasks) {
    if (orphanIds.has(t.id)) {
      out.push(t.id);
      continue; // one reason is enough — never report an id twice
    }
    if (t.status !== "running" && t.doneAt != null && now - t.doneAt >= fadeMs) out.push(t.id);
  }
  return out;
}
