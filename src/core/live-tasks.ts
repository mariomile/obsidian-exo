/**
 * Live-tasks core — the pure, Obsidian-free projection behind the expandable
 * "background tasks" chip above the composer. UI-free and DOM-free so it's
 * unit-testable in isolation (same discipline as `session-cards.ts` /
 * `workflow-progress.ts`): `view.ts` keeps the impure map (with card elements)
 * on each `Convo`, feeds the DOM-free `LiveTask[]` in, and this decides the chip
 * summary, dot classes, and which faded rows to evict.
 *
 * Design: docs/plans/2026-07-22-background-tasks-inline.md
 */

export type LiveTaskKind = "subagent" | "bash" | "workflow";
/**
 * `detached` is the honest resting state for work Exo cannot poll. A background
 * Bash or a Workflow may genuinely outlive the turn that started it, but once
 * that turn's stream closes nothing will ever report back — so the chip must
 * stop claiming "running", which is knowledge Exo does not have. Neither
 * running nor settled: started, outcome unknown.
 */
export type LiveTaskStatus = "running" | "detached" | "done" | "error" | "stopped";

/** Has this task reached an OUTCOME? `detached` deliberately has not: it never
 *  gets a `doneAt` stamp and never fades on a timer, because there is nothing
 *  to show the user for two seconds and then hide. */
export function isSettled(status: LiveTaskStatus): boolean {
  return status === "done" || status === "error" || status === "stopped";
}

/** A single live background task, DOM-free. The view-side record extends this
 *  with a `cardEl` (the scroll-to target) — kept out of here to stay testable. */
export interface LiveTask {
  id: string;
  kind: LiveTaskKind;
  label: string;
  status: LiveTaskStatus;
  /** A subagent the Agent tool BACKGROUNDED: its tool result is a launch ack,
   *  not an outcome — the real lifecycle arrives via `agent-task` events. Set
   *  the moment the first such event lands. Changes two rules: the tool-result
   *  no longer settles the row, and a clean turn end detaches it (like a
   *  workflow) instead of declaring it an error. */
  backgrounded?: boolean;
  startedAt: number;
  /** Wall-clock ms when it reached an outcome (done/error/stopped) — drives the
   *  fade. Never set for `detached`, which has no outcome. */
  doneAt?: number;
}

export interface LiveTasksSummary {
  count: number;
  running: number;
  /** Animate the chip's loader icon while any task is still running. */
  spinner: boolean;
  /** Chip label, e.g. "2 agents running" · "1 running · 1 background" ·
   *  "1 background task" · "3 done". */
  chipLabel: string;
}

export function summarizeLiveTasks(tasks: LiveTask[]): LiveTasksSummary {
  let running = 0;
  let detached = 0;
  for (const t of tasks) {
    if (t.status === "running") running++;
    else if (t.status === "detached") detached++;
  }
  const count = tasks.length;
  const settled = count - running - detached;
  // Each state gets its own word when they are mixed; a single state gets the
  // fuller phrasing, because that is the common case and it reads better.
  let chipLabel = "";
  if (running && !detached && !settled) {
    chipLabel = running === 1 ? "1 agent running" : `${running} agents running`;
  } else if (detached && !running && !settled) {
    chipLabel = detached === 1 ? "1 background task" : `${detached} background tasks`;
  } else if (settled && !running && !detached) {
    chipLabel = `${settled} done`;
  } else if (count) {
    const parts: string[] = [];
    if (running) parts.push(`${running} running`);
    if (detached) parts.push(`${detached} background`);
    if (settled) parts.push(`${settled} done`);
    chipLabel = parts.join(" · ");
  }
  // Only genuinely live work spins. Detached work is not known to be running.
  return { count, running, spinner: running > 0, chipLabel };
}

export function liveTaskDotClass(status: LiveTaskStatus): "" | "is-ok" | "is-error" {
  if (status === "error") return "is-error";
  if (status === "done" || status === "stopped") return "is-ok";
  return ""; // running and detached are both "no outcome yet"
}

export function liveTaskStatusText(status: LiveTaskStatus): string {
  // The one status whose bare name would mislead: say what Exo actually knows.
  return status === "detached" ? "in background" : status;
}

