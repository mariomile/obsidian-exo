/**
 * Daily Pulse collection shell.
 *
 * This module gathers the bounded facts consumed by the pure Daily Pulse
 * model. All IO is injected through structural adapters so collection can be
 * tested without loading Obsidian and one unavailable source cannot blank the
 * data returned by the other sources.
 */

import {
  unreviewedWriteRuns,
  type AutomationRunRecord,
} from "../core/automations";
import {
  resetIfNewDay,
  type BudgetLedger,
} from "../core/background-budget";
import type { DailyPulseInput } from "../core/daily-pulse";
import { dueLoops, type LoopEntry } from "../core/open-loops";
import type { ProposalKind } from "../core/proposals";
import type { TaskEntry } from "../core/tasks";

export const DAILY_PULSE_TARGET_PATH = "_system/review.md";
export const DAILY_PULSE_FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
export const DAILY_PULSE_RECENT_NOTE_LIMIT = 20;
/**
 * The metadata adapter must stop after this many candidates. The collector
 * may discard internal/noisy paths, then applies the smaller output limit.
 */
export const DAILY_PULSE_RECENT_NOTE_SCAN_LIMIT = 50;

export type DailyPulseCollectionSource =
  | "tasks"
  | "loops"
  | "proposals"
  | "automations"
  | "recent-notes"
  | "budget";

export interface DailyPulseCollectionWarning {
  source: DailyPulseCollectionSource;
  message: string;
}

export interface RecentNoteCandidate {
  path: string;
  mtime: number;
}

export interface RecentNoteQuery {
  /** Exclusive lower boundary for candidate mtimes. */
  modifiedAfter: number;
  /** Hard maximum the adapter may inspect/return. */
  limit: number;
}

export interface DailyPulseBudgetSnapshot {
  enabled: boolean;
  dailyBudget: number;
  ledger: BudgetLedger;
}

interface LoadedTaskSource {
  tasks: readonly TaskEntry[];
  warnings: readonly string[];
}

interface PendingProposalSource {
  records: readonly {
    id: string;
    kind: ProposalKind;
    title: string;
  }[];
  warnings: readonly string[];
}

/**
 * Structural slices implemented by TaskStore, ProposalStore and the eventual
 * Obsidian wiring. `listRecentNotes` receives both a boundary and a hard cap;
 * broad vault enumeration is deliberately outside this contract.
 */
export interface DailyPulseCollectionSources {
  taskStore: { load(): Promise<LoadedTaskSource> };
  loadLoops(): Promise<readonly LoopEntry[]>;
  proposalStore: { listPending(): Promise<PendingProposalSource> };
  loadAutomationRuns(): Promise<readonly AutomationRunRecord[]>;
  listRecentNotes(query: RecentNoteQuery): Promise<readonly RecentNoteCandidate[]>;
  loadBackgroundBudget(): Promise<DailyPulseBudgetSnapshot>;
}

export interface DailyPulseCollectionOptions {
  now: number;
  /** Missing on the first run; a bounded 24-hour lookback is used instead. */
  lastPulseAt?: number | null;
}

export interface DailyPulseCollectionResult {
  input: DailyPulseInput;
  warnings: DailyPulseCollectionWarning[];
}

interface Captured<T> {
  value: T;
  warnings: DailyPulseCollectionWarning[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function capture<T>(
  source: DailyPulseCollectionSource,
  load: () => Promise<T>,
  fallback: T
): Promise<Captured<T>> {
  try {
    return { value: await load(), warnings: [] };
  } catch (error) {
    return {
      value: fallback,
      warnings: [{ source, message: errorMessage(error) }],
    };
  }
}

function embeddedWarnings(
  source: DailyPulseCollectionSource,
  warnings: readonly string[]
): DailyPulseCollectionWarning[] {
  return warnings.map((message) => ({ source, message }));
}

function recentBoundary(now: number, lastPulseAt?: number | null): number {
  if (typeof lastPulseAt === "number" && Number.isFinite(lastPulseAt)) {
    return Math.min(lastPulseAt, now);
  }
  return now - DAILY_PULSE_FIRST_RUN_LOOKBACK_MS;
}

function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isExcludedRecentPath(path: string): boolean {
  return path === ".obsidian"
    || path.startsWith(".obsidian/")
    || path === DAILY_PULSE_TARGET_PATH
    || path === "Resources/_artifacts"
    || path.startsWith("Resources/_artifacts/");
}

function collectRecentNotes(
  candidates: readonly RecentNoteCandidate[],
  modifiedAfter: number,
  now: number
): DailyPulseInput["recentNotes"] {
  const newestByPath = new Map<string, number>();
  for (const candidate of candidates.slice(0, DAILY_PULSE_RECENT_NOTE_SCAN_LIMIT)) {
    const path = normalizeVaultPath(candidate.path);
    if (!path || !/\.md$/i.test(path) || isExcludedRecentPath(path)) continue;
    if (!Number.isFinite(candidate.mtime)
      || candidate.mtime <= modifiedAfter
      || candidate.mtime > now) continue;
    const prior = newestByPath.get(path);
    if (prior === undefined || candidate.mtime > prior) {
      newestByPath.set(path, candidate.mtime);
    }
  }

  return [...newestByPath]
    .map(([path, mtime]) => ({ path, mtime }))
    .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
    .slice(0, DAILY_PULSE_RECENT_NOTE_LIMIT);
}

function remainingBudget(snapshot: DailyPulseBudgetSnapshot, now: number): number | null {
  if (!snapshot.enabled) return 0;
  if (!(snapshot.dailyBudget > 0) || !Number.isFinite(snapshot.dailyBudget)) return null;
  const ledger = resetIfNewDay(snapshot.ledger, now);
  const used = Number.isFinite(ledger.tokensUsed) && ledger.tokensUsed > 0
    ? ledger.tokensUsed
    : 0;
  return Math.max(0, snapshot.dailyBudget - used);
}

function needsPulseAttention(
  task: TaskEntry
): task is TaskEntry & { status: "needs-input" | "review" } {
  return task.status === "needs-input" || task.status === "review";
}

/** Collect a DailyPulseInput while preserving partial success and warnings. */
export async function collectDailyPulseInput(
  sources: DailyPulseCollectionSources,
  options: DailyPulseCollectionOptions
): Promise<DailyPulseCollectionResult> {
  const { now } = options;
  const modifiedAfter = recentBoundary(now, options.lastPulseAt);
  const [tasks, loops, proposals, automations, notes, budget] = await Promise.all([
    capture("tasks", () => sources.taskStore.load(), { tasks: [], warnings: [] }),
    capture("loops", () => sources.loadLoops(), []),
    capture("proposals", () => sources.proposalStore.listPending(), { records: [], warnings: [] }),
    capture("automations", () => sources.loadAutomationRuns(), []),
    capture(
      "recent-notes",
      () => sources.listRecentNotes({
        modifiedAfter,
        limit: DAILY_PULSE_RECENT_NOTE_SCAN_LIMIT,
      }),
      []
    ),
    capture("budget", () => sources.loadBackgroundBudget(), null),
  ]);

  const warnings = [
    ...tasks.warnings,
    ...embeddedWarnings("tasks", tasks.value.warnings),
    ...loops.warnings,
    ...proposals.warnings,
    ...embeddedWarnings("proposals", proposals.value.warnings),
    ...automations.warnings,
    ...notes.warnings,
    ...budget.warnings,
  ];

  return {
    input: {
      now,
      tasks: tasks.value.tasks
        .filter(needsPulseAttention)
        .map(({ id, title, status }) => ({
          id,
          title,
          status,
        })),
      dueLoops: dueLoops([...loops.value], now).map(({ id, title, resurface }) => ({
        id,
        title,
        ...(resurface ? { resurface } : {}),
      })),
      pendingProposals: proposals.value.records.map(({ id, kind, title }) => ({
        id,
        kind,
        title,
      })),
      automationRuns: unreviewedWriteRuns([...automations.value]).map((run) => ({
        id: run.id,
        name: run.name,
        startedAt: run.startedAt,
        writes: [...run.writes],
      })),
      recentNotes: collectRecentNotes(notes.value, modifiedAfter, now),
      budget: {
        remaining: budget.value === null ? null : remainingBudget(budget.value, now),
      },
    },
    warnings,
  };
}
