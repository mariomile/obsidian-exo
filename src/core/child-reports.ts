/**
 * Child reports — the pure half of "a spawned child tells its parent what
 * happened" (no Obsidian imports).
 *
 * The driver observes convo-state events for child convos and turns each
 * outcome into a `ChildReport`. This module decides what an outcome IS, how the
 * excerpt is capped, and how a batch reads to the parent model. Delivery (UI
 * card, and queueing onto the parent's next turn) lives in the impure caller.
 */
import type { ConvoState, ConvoStateReason } from "./convo-state";

/** Longest child excerpt handed to the parent. */
export const EXCERPT_CAP = 2000;
/** How long the driver batches reports before delivering them. */
export const REPORT_DEBOUNCE_MS = 2000;

export type ChildOutcome = "done" | "blocked" | "stopped" | "error";

export interface ChildReport {
  taskId: string;
  childConvoId: string;
  title: string;
  outcome: ChildOutcome;
  excerpt: string;
  /** Wall-clock ms when the outcome landed. */
  at: number;
}

/**
 * Map a convo-state notification to a child outcome, or null when the event is
 * not an outcome at all (`turn-start`). `needs-input` is ambiguous by design on
 * that channel: reason `error` is a failure, everything else (`perm`, `ask`, or
 * no reason at all) is a live question waiting for Mario.
 */
export function outcomeFromState(state: ConvoState, reason?: ConvoStateReason): ChildOutcome | null {
  if (state === "turn-end") return "done";
  if (state === "stopped") return "stopped";
  if (state === "error") return "error";
  if (state === "needs-input") return reason === "error" ? "error" : "blocked";
  return null;
}

/** Trim and cap a child's last assistant text for inclusion in a report. */
export function buildExcerpt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= EXCERPT_CAP) return trimmed;
  return `${trimmed.slice(0, EXCERPT_CAP)}… [truncated]`;
}

const OUTCOME_LINE: Record<ChildOutcome, string> = {
  done: "is done",
  blocked: "is blocked, waiting for input",
  stopped: "was stopped by Mario",
  error: "hit an error and failed",
};

/**
 * Render a batch of reports as one message for the parent agent. Deliberately
 * plain prose: it is prepended to the parent's next turn, so it must read as
 * context, not as a tool result or a command.
 */
export function formatReportsForParent(reports: ChildReport[]): string {
  if (!reports.length) return "";
  const blocks = reports.map((r) => {
    const head = `Child task "${r.title}" (${r.taskId}) ${OUTCOME_LINE[r.outcome]}.`;
    const body = r.excerpt ? `\n${r.excerpt}` : "";
    return `${head}${body}`;
  });
  const guidance = reports.some((r) => r.outcome === "stopped")
    ? "\n\nOne of these was stopped by hand: do not resume its work unless Mario asks."
    : "";
  const plural = reports.length === 1 ? "a task you delegated" : "tasks you delegated";
  return `Update on ${plural}:\n\n${blocks.join("\n\n")}${guidance}`;
}
