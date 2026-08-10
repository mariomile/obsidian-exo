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
  /** The convo that ran the child. EMPTY when the spawn itself failed: there
   *  never was a conversation. That case is precisely why routing must not go
   *  through this field (see `parentConvoId`). */
  childConvoId: string;
  /** Who the report is FOR — the convo id recorded as the task's `parent` in
   *  the ledger. Carried on the report rather than resolved downstream by
   *  looking `childConvoId` up among the conversations: that lookup finds
   *  nothing for a spawn failure, which silently drops exactly the report the
   *  parent most needs (the one saying its child never started). */
  parentConvoId: string;
  title: string;
  outcome: ChildOutcome;
  excerpt: string;
  /** Wall-clock ms when the outcome landed. */
  at: number;
}

/** The shape this module needs of a conversation to route a report to it. The
 *  view's `Convo` satisfies it structurally, so nothing here imports the view. */
export interface ReportHolder {
  id: string;
  pendingChildReports?: ChildReport[];
}

/**
 * Queue a report onto the conversation it names as parent, and return that
 * conversation so the caller can surface it.
 *
 * Returns `undefined` when the parent is not in `convos` — archived, deleted,
 * or simply gone. Dropping the report there is CORRECT, not a bug: there is no
 * next turn to hand it to and no transcript to show it in. It is also the only
 * failure mode, which is why routing is by `parentConvoId` and never by walking
 * back from `childConvoId`.
 */
export function queueReportForParent<T extends ReportHolder>(
  convos: readonly T[],
  report: ChildReport,
): T | undefined {
  const parent = convos.find((c) => c.id === report.parentConvoId);
  if (!parent) return undefined;
  (parent.pendingChildReports ??= []).push(report);
  return parent;
}

/**
 * Take everything queued on a parent and render it for that parent's next turn,
 * emptying the queue in the same step.
 *
 * Drain and format are ONE function on purpose. Split apart, a caller can
 * format without draining — and since the prefix is rebuilt on every turn, the
 * same "your child finished" message would then ride every subsequent turn
 * forever. Returns "" when there is nothing queued, so the caller can drop it
 * from the outbound join with a falsy filter.
 */
export function drainReportsForParent(parent: ReportHolder): string {
  const queued = parent.pendingChildReports;
  if (!queued?.length) return "";
  parent.pendingChildReports = [];
  return formatReportsForParent(queued);
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

/** The structural slice of a conversation's messages this module reads. The
 *  view's `Message` union satisfies it; nothing here imports the view. */
export interface ReportMessage {
  role: string;
  segments?: readonly { t: string; md?: string }[];
}

/**
 * The child's last answer, as the text that goes into a report's excerpt.
 *
 * An assistant turn is SEGMENTS, not a string — the `Message` union gives
 * `text` to user turns only (core/model.ts). Reading `.text` off an assistant
 * message therefore yields "" for every child, and every report ships with an
 * empty excerpt: a failure that is invisible from the outside, because the
 * report still arrives on time and merely says nothing. Hence this lives here,
 * under test, rather than as three lines inside the untested view.
 *
 * Only `text` segments count, and a turn with none falls through to the last
 * turn that did say something: a child whose final act was a tool call has no
 * prose of its own, and reporting silence there is strictly worse than
 * reporting the last thing it actually said.
 */
export function lastAssistantText(messages: readonly ReportMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const text = (m.segments ?? [])
      .filter((s) => s.t === "text")
      .map((s) => s.md ?? "")
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
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
