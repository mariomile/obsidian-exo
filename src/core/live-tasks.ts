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
export type LiveTaskStatus = "running" | "done" | "error" | "stopped";

/** A single live background task, DOM-free. The view-side record extends this
 *  with a `cardEl` (the scroll-to target) — kept out of here to stay testable. */
export interface LiveTask {
  id: string;
  kind: LiveTaskKind;
  label: string;
  status: LiveTaskStatus;
  startedAt: number;
  /** Wall-clock ms when it went terminal (done/error/stopped) — drives the fade. */
  doneAt?: number;
}

export interface LiveTasksSummary {
  count: number;
  running: number;
  /** Animate the chip's loader icon while any task is still running. */
  spinner: boolean;
  /** Chip label, e.g. "2 agents running" · "1 running · 2 done" · "3 done". */
  chipLabel: string;
}

const isTerminal = (s: LiveTaskStatus): boolean => s !== "running";

export function summarizeLiveTasks(tasks: LiveTask[]): LiveTasksSummary {
  let running = 0;
  for (const t of tasks) if (t.status === "running") running++;
  const count = tasks.length;
  const doneish = count - running;
  let chipLabel = "";
  if (running > 0 && doneish === 0) {
    chipLabel = running === 1 ? "1 agent running" : `${running} agents running`;
  } else if (running > 0) {
    chipLabel = `${running} running · ${doneish} done`;
  } else if (count > 0) {
    chipLabel = `${count} done`;
  }
  return { count, running, spinner: running > 0, chipLabel };
}

export function liveTaskDotClass(status: LiveTaskStatus): "" | "is-ok" | "is-error" {
  if (status === "error") return "is-error";
  if (status === "done" || status === "stopped") return "is-ok";
  return "";
}

export function liveTaskStatusText(status: LiveTaskStatus): string {
  return status;
}

/** Ids of terminal tasks whose `doneAt` is older than `fadeMs` — safe to evict.
 *  Terminal tasks without a `doneAt` stamp are kept (grace until stamped). */
export function fadedTaskIds(tasks: LiveTask[], now: number, fadeMs: number): string[] {
  const out: string[] = [];
  for (const t of tasks) {
    if (isTerminal(t.status) && t.doneAt != null && now - t.doneAt >= fadeMs) out.push(t.id);
  }
  return out;
}
