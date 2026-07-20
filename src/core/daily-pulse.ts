/**
 * Daily Pulse — deterministic, side-effect-free view model.
 *
 * Collection and rendering live in the Obsidian layer. This module only turns
 * already-collected facts into a bounded set of review/open actions.
 */

import type { ProposalKind } from "./proposals";

export interface DailyPulseInput {
  now: number;
  tasks: { id: string; title: string; status: "needs-input" | "review" }[];
  dueLoops: { id: string; title: string; resurface?: string }[];
  pendingProposals: { id: string; kind: ProposalKind; title: string }[];
  automationRuns: { id: string; name: string; startedAt: number; writes: string[] }[];
  recentNotes: { path: string; mtime: number }[];
  budget: { remaining: number | null };
}

export type DailyPulseSectionTitle =
  | "Attention"
  | "Open loops"
  | "Suggestions"
  | "Recent work"
  | "System";

export type DailyPulseTarget =
  | { kind: "task"; id: string }
  | { kind: "loop"; id: string }
  | { kind: "proposal"; id: string }
  | { kind: "automation"; id: string }
  | { kind: "note"; path: string }
  | { kind: "system"; id: "budget" };

export type DailyPulseAction =
  | { kind: "review"; target: "task" | "loop" | "proposal" | "automation"; id: string }
  | { kind: "open"; path: string };

export interface DailyPulseItem {
  id: string;
  kind: "task" | "loop" | "proposal" | "automation" | "note" | "system";
  title: string;
  detail?: string;
  target: DailyPulseTarget;
  action?: DailyPulseAction;
}

export interface DailyPulseSection {
  title: DailyPulseSectionTitle;
  items: DailyPulseItem[];
}

export interface DailyPulse {
  generatedAt: number;
  sections: DailyPulseSection[];
}

export const DAILY_PULSE_SECTION_LIMIT = 5;

const TASK_STATUS_ORDER: Record<DailyPulseInput["tasks"][number]["status"], number> = {
  "needs-input": 0,
  review: 1,
};

const PROPOSAL_KIND_ORDER: Record<ProposalKind, number> = {
  task: 0,
  loop: 1,
  decision: 2,
  playbook: 3,
};

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareTitleAndId(
  a: { title: string; id: string },
  b: { title: string; id: string }
): number {
  return compareText(a.title, b.title) || compareText(a.id, b.id);
}

function descendingTime(a: number, b: number): number {
  const safeA = Number.isFinite(a) ? a : Number.NEGATIVE_INFINITY;
  const safeB = Number.isFinite(b) ? b : Number.NEGATIVE_INFINITY;
  return safeB - safeA;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function noteTitle(path: string): string {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  return fileName.replace(/\.md$/i, "") || fileName;
}

function bounded(items: DailyPulseItem[]): DailyPulseItem[] {
  return items.slice(0, DAILY_PULSE_SECTION_LIMIT);
}

function attentionItems(input: DailyPulseInput): DailyPulseItem[] {
  const tasks: DailyPulseItem[] = [...input.tasks]
    .sort(
      (a, b) =>
        TASK_STATUS_ORDER[a.status] - TASK_STATUS_ORDER[b.status] ||
        compareTitleAndId(a, b)
    )
    .map((task) => ({
      id: `task:${task.id}`,
      kind: "task",
      title: task.title,
      detail: task.status === "needs-input" ? "Needs input" : "Ready for review",
      target: { kind: "task", id: task.id },
      action: { kind: "review", target: "task", id: task.id },
    }));

  const runs: DailyPulseItem[] = input.automationRuns
    .filter((run) => run.writes.length > 0)
    .slice()
    .sort(
      (a, b) =>
        descendingTime(a.startedAt, b.startedAt) ||
        compareText(a.name, b.name) ||
        compareText(a.id, b.id)
    )
    .map((run) => ({
      id: `automation:${run.id}`,
      kind: "automation",
      title: run.name,
      detail: run.writes.length === 1 ? "1 write to review" : `${run.writes.length} writes to review`,
      target: { kind: "automation", id: run.id },
      action: { kind: "review", target: "automation", id: run.id },
    }));

  return bounded([...tasks, ...runs]);
}

function loopItems(input: DailyPulseInput): DailyPulseItem[] {
  return bounded(
    [...input.dueLoops]
      .sort(
        (a, b) =>
          compareText(a.resurface ?? "", b.resurface ?? "") ||
          compareTitleAndId(a, b)
      )
      .map((loop) => ({
        id: `loop:${loop.id}`,
        kind: "loop",
        title: loop.title,
        ...(loop.resurface ? { detail: `Due ${loop.resurface}` } : {}),
        target: { kind: "loop", id: loop.id },
        action: { kind: "review", target: "loop", id: loop.id },
      }))
  );
}

function proposalItems(input: DailyPulseInput): DailyPulseItem[] {
  return bounded(
    [...input.pendingProposals]
      .sort(
        (a, b) =>
          PROPOSAL_KIND_ORDER[a.kind] - PROPOSAL_KIND_ORDER[b.kind] ||
          compareTitleAndId(a, b)
      )
      .map((proposal) => ({
        id: `proposal:${proposal.id}`,
        kind: "proposal",
        title: proposal.title,
        detail: titleCase(proposal.kind),
        target: { kind: "proposal", id: proposal.id },
        action: { kind: "review", target: "proposal", id: proposal.id },
      }))
  );
}

function recentWorkItems(input: DailyPulseInput): DailyPulseItem[] {
  return bounded(
    [...input.recentNotes]
      .sort(
        (a, b) =>
          descendingTime(a.mtime, b.mtime) ||
          compareText(a.path, b.path)
      )
      .map((note) => ({
        id: `note:${note.path}`,
        kind: "note",
        title: noteTitle(note.path),
        detail: note.path,
        target: { kind: "note", path: note.path },
        action: { kind: "open", path: note.path },
      }))
  );
}

function systemItems(input: DailyPulseInput): DailyPulseItem[] {
  const remaining = input.budget.remaining;
  if (remaining === null || !Number.isFinite(remaining)) return [];
  return [{
    id: "system:budget",
    kind: "system",
    title: "Background budget",
    detail: remaining <= 0 ? "Budget exhausted" : `${remaining} remaining`,
    target: { kind: "system", id: "budget" },
  }];
}

/** Build the first-render Daily Pulse without IO, Obsidian APIs or an LLM. */
export function buildDailyPulse(input: DailyPulseInput): DailyPulse {
  const candidates: DailyPulseSection[] = [
    { title: "Attention", items: attentionItems(input) },
    { title: "Open loops", items: loopItems(input) },
    { title: "Suggestions", items: proposalItems(input) },
    { title: "Recent work", items: recentWorkItems(input) },
    { title: "System", items: systemItems(input) },
  ];

  return {
    generatedAt: input.now,
    sections: candidates.filter((section) => section.items.length > 0),
  };
}
