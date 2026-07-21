/**
 * Workflow progress tracking — reduces the CLI's `system/task_*` events into a
 * per-run agent roster Exo can render live.
 *
 * When the model launches a Workflow, the tool returns immediately and the
 * run continues in the background. The ONLY window into it is the stream's
 * `system` events: `task_started` (run created, carries tool_use_id),
 * `task_progress` (carries a `workflow_progress` array), `task_updated`
 * (terminal status patch). Empirically (probe 2026-07-21) the
 * `workflow_progress` array is INCREMENTAL — an event may carry only the
 * agents that changed since the last one — so state must be accumulated,
 * keyed by agent index, with the latest entry winning.
 */

export interface WorkflowProgressEntry {
  type: string; // "workflow_phase" | "workflow_agent"
  index: number;
  title?: string; // phase title
  label?: string; // agent label
  phaseTitle?: string;
  state?: string; // "start" | "done" | "error" (agent lifecycle)
  error?: string | null;
}

export interface WorkflowAgent {
  index: number;
  label: string;
  phaseTitle?: string;
  state: string;
}

export interface WorkflowRun {
  taskId: string;
  toolUseId: string;
  name?: string;
  /** keyed by agent index — latest event wins */
  agents: Map<number, WorkflowAgent>;
  phase?: string;
  status?: string; // from task_updated patch: "completed" | "failed" | …
}

export function createWorkflowRun(taskId: string, toolUseId: string, name?: string): WorkflowRun {
  return { taskId, toolUseId, name, agents: new Map() };
}

/** Merge a `workflow_progress` array into the run (mutates and returns it). */
export function applyWorkflowProgress(run: WorkflowRun, entries: WorkflowProgressEntry[] | undefined): WorkflowRun {
  for (const e of entries ?? []) {
    if (e.type === "workflow_phase" && e.title) {
      run.phase = e.title;
    } else if (e.type === "workflow_agent" && typeof e.index === "number") {
      run.agents.set(e.index, {
        index: e.index,
        label: e.label ?? `agent ${e.index}`,
        phaseTitle: e.phaseTitle,
        state: e.state ?? "start",
      });
      if (e.phaseTitle) run.phase = e.phaseTitle;
    }
  }
  return run;
}

export interface WorkflowSummary {
  running: number;
  done: number;
  failed: number;
  total: number;
  /** compact status line for the tool card, e.g. "2 agents running · 1 done · phase Verify" */
  label: string;
}

export function summarizeWorkflowRun(run: WorkflowRun): WorkflowSummary {
  let running = 0,
    done = 0,
    failed = 0;
  for (const a of run.agents.values()) {
    if (a.state === "done") done++;
    else if (a.state === "error") failed++;
    else running++;
  }
  const total = run.agents.size;
  const parts: string[] = [];
  if (run.status === "completed") parts.push(`workflow done · ${total} agent${total === 1 ? "" : "s"}`);
  else if (run.status && run.status !== "running") parts.push(`workflow ${run.status}`);
  else {
    parts.push(`${running} agent${running === 1 ? "" : "s"} running`);
    if (done) parts.push(`${done} done`);
  }
  if (failed) parts.push(`${failed} failed`);
  if (run.phase && run.status !== "completed") parts.push(`phase ${run.phase}`);
  return { running, done, failed, total, label: parts.join(" · ") };
}
