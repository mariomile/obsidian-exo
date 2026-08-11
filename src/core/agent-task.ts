/**
 * Backgrounded-subagent chip lifecycle (pure). The Agent tool backgrounds by
 * default on recent CLIs: its tool result is a launch ack (~1s) while the
 * agent keeps running, and the real lifecycle arrives as `agent-task` events
 * reduced from the stream's `system/task_*` messages (same channel as
 * workflow progress). This module owns the projection of those events onto a
 * live-task row; `view.ts` only supplies the card lookup.
 */
import type { LiveTask, LiveTaskStatus } from "./live-tasks";

/** Map a task_updated patch status onto the chip vocabulary. No/unknown
 *  status (task_started, task_progress echoes) means "still running". */
export function agentTaskStatus(patch: string | undefined): LiveTaskStatus {
  return patch === "completed" ? "done" : patch === "failed" || patch === "killed" ? "error" : "running";
}

/** The row an `agent-task` event upserts. Started/progress echoes RESURRECT a
 *  row the launch ack settled (hence `backgrounded: true` from the first
 *  event); label and start time stick to the earliest sighting. */
export function agentTaskRow(
  e: { toolUseId: string; description?: string; status?: string },
  prev: LiveTask | undefined,
  now: number,
): LiveTask {
  return {
    id: e.toolUseId,
    kind: "subagent",
    backgrounded: true,
    label: prev?.label ?? e.description ?? "background agent",
    status: agentTaskStatus(e.status),
    startedAt: prev?.startedAt ?? now,
  };
}
