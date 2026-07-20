import { describe, expect, it, vi } from "vitest";
import type { AutomationRunRecord } from "../src/core/automations";
import type { LoopEntry } from "../src/core/open-loops";
import type { TaskEntry } from "../src/core/tasks";
import {
  collectDailyPulseInput,
  DAILY_PULSE_FIRST_RUN_LOOKBACK_MS,
  DAILY_PULSE_RECENT_NOTE_LIMIT,
  DAILY_PULSE_RECENT_NOTE_SCAN_LIMIT,
  type DailyPulseCollectionSources,
} from "../src/obsidian/daily-pulse";

const NOW = Date.parse("2026-07-20T08:00:00.000Z");
const LAST_PULSE_AT = NOW - 60_000;

function task(id: string, status: TaskEntry["status"]): TaskEntry {
  return {
    id,
    title: `Task ${id}`,
    status,
    created: "2026-07-20T07:00:00.000Z",
    updated: "2026-07-20T07:30:00.000Z",
    prompt: `Prompt ${id}`,
  };
}

function loop(
  id: string,
  overrides: Partial<LoopEntry> = {}
): LoopEntry {
  return {
    id,
    title: `Loop ${id}`,
    note: "Context",
    openedAt: NOW - 120_000,
    status: "open",
    ...overrides,
  };
}

function run(
  id: string,
  overrides: Partial<AutomationRunRecord> = {}
): AutomationRunRecord {
  return {
    id,
    name: `Run ${id}`,
    startedAt: NOW - 30_000,
    ok: true,
    reportPath: `Reports/${id}.md`,
    writes: [`Journal/${id}.md`],
    checkpoint: [],
    ...overrides,
  };
}

function sources(
  overrides: Partial<DailyPulseCollectionSources> = {}
): DailyPulseCollectionSources {
  return {
    taskStore: {
      load: async () => ({ tasks: [], warnings: [] }),
    },
    loadLoops: async () => [],
    proposalStore: {
      listPending: async () => ({ records: [], warnings: [] }),
    },
    loadAutomationRuns: async () => [],
    listRecentNotes: async () => [],
    loadBackgroundBudget: async () => ({
      enabled: true,
      dailyBudget: 10_000,
      ledger: { dateUTC: "2026-07-20", tokensUsed: 0 },
    }),
    ...overrides,
  };
}

describe("collectDailyPulseInput", () => {
  it("collects every source and applies the source-specific filters", async () => {
    const listRecentNotes = vi.fn(async () => [
      { path: "Active/Newer.md", mtime: NOW - 1_000 },
      { path: "Active/At boundary.md", mtime: LAST_PULSE_AT },
      { path: "Active/Older.md", mtime: LAST_PULSE_AT - 1 },
      { path: "Active/Future.md", mtime: NOW + 1 },
      { path: ".obsidian/plugins/exo/proposals.json", mtime: NOW - 2_000 },
      { path: "_system/review.md", mtime: NOW - 3_000 },
      { path: "Resources/_artifacts/generated.md", mtime: NOW - 4_000 },
      { path: "Active/not-a-note.pdf", mtime: NOW - 5_000 },
    ]);
    const result = await collectDailyPulseInput(sources({
      taskStore: {
        load: async () => ({
          tasks: [task("input", "needs-input"), task("review", "review"), task("backlog", "backlog")],
          warnings: [],
        }),
      },
      loadLoops: async () => [
        loop("immediate"),
        loop("today", { resurface: "2026-07-20" }),
        loop("future", { resurface: "2026-07-21" }),
        loop("closed", { status: "closed", closedAt: NOW - 10_000 }),
      ],
      proposalStore: {
        listPending: async () => ({
          records: [
            { id: "proposal-1", kind: "decision", title: "Choose direction" },
          ],
          warnings: [],
        }),
      },
      loadAutomationRuns: async () => [
        run("pending"),
        run("reviewed", { reviewedAt: NOW - 1_000 }),
        run("restored", { restoredAt: NOW - 1_000 }),
        run("read-only", { writes: [] }),
      ],
      listRecentNotes,
      loadBackgroundBudget: async () => ({
        enabled: true,
        dailyBudget: 10_000,
        ledger: { dateUTC: "2026-07-20", tokensUsed: 3_250 },
      }),
    }), { now: NOW, lastPulseAt: LAST_PULSE_AT });

    expect(listRecentNotes).toHaveBeenCalledWith({
      modifiedAfter: LAST_PULSE_AT,
      limit: DAILY_PULSE_RECENT_NOTE_SCAN_LIMIT,
    });
    expect(result.input).toEqual({
      now: NOW,
      tasks: [
        { id: "input", title: "Task input", status: "needs-input" },
        { id: "review", title: "Task review", status: "review" },
      ],
      dueLoops: [
        { id: "immediate", title: "Loop immediate" },
        { id: "today", title: "Loop today", resurface: "2026-07-20" },
      ],
      pendingProposals: [
        { id: "proposal-1", kind: "decision", title: "Choose direction" },
      ],
      automationRuns: [{
        id: "pending",
        name: "Run pending",
        startedAt: NOW - 30_000,
        writes: ["Journal/pending.md"],
      }],
      recentNotes: [{ path: "Active/Newer.md", mtime: NOW - 1_000 }],
      budget: { remaining: 6_750 },
    });
    expect(result.warnings).toEqual([]);
  });

  it("keeps successful source data when other sources fail and identifies each warning", async () => {
    const result = await collectDailyPulseInput(sources({
      taskStore: {
        load: async () => ({ tasks: [task("review", "review")], warnings: [] }),
      },
      loadLoops: async () => { throw new Error("loops unavailable"); },
      proposalStore: {
        listPending: async () => { throw new Error("proposals unavailable"); },
      },
      loadAutomationRuns: async () => { throw new Error("runs unavailable"); },
      listRecentNotes: async () => { throw new Error("metadata unavailable"); },
      loadBackgroundBudget: async () => { throw new Error("budget unavailable"); },
    }), { now: NOW, lastPulseAt: LAST_PULSE_AT });

    expect(result.input.tasks).toEqual([
      { id: "review", title: "Task review", status: "review" },
    ]);
    expect(result.input.dueLoops).toEqual([]);
    expect(result.input.pendingProposals).toEqual([]);
    expect(result.input.automationRuns).toEqual([]);
    expect(result.input.recentNotes).toEqual([]);
    expect(result.input.budget).toEqual({ remaining: null });
    expect(result.warnings).toEqual([
      { source: "loops", message: "loops unavailable" },
      { source: "proposals", message: "proposals unavailable" },
      { source: "automations", message: "runs unavailable" },
      { source: "recent-notes", message: "metadata unavailable" },
      { source: "budget", message: "budget unavailable" },
    ]);
  });

  it("preserves TaskStore and ProposalStore warnings alongside valid records", async () => {
    const result = await collectDailyPulseInput(sources({
      taskStore: {
        load: async () => ({
          tasks: [task("input", "needs-input")],
          warnings: ["Malformed task block task-bad."],
        }),
      },
      proposalStore: {
        listPending: async () => ({
          records: [{ id: "proposal-1", kind: "task", title: "Draft task" }],
          warnings: ["Proposal record 2 was quarantined."],
        }),
      },
    }), { now: NOW, lastPulseAt: LAST_PULSE_AT });

    expect(result.input.tasks).toHaveLength(1);
    expect(result.input.pendingProposals).toHaveLength(1);
    expect(result.warnings).toEqual([
      { source: "tasks", message: "Malformed task block task-bad." },
      { source: "proposals", message: "Proposal record 2 was quarantined." },
    ]);
  });

  it("uses a bounded first-run lookback and enforces the exclusive boundary", async () => {
    const modifiedAfter = NOW - DAILY_PULSE_FIRST_RUN_LOOKBACK_MS;
    const listRecentNotes = vi.fn(async () => [
      { path: "At boundary.md", mtime: modifiedAfter },
      { path: "Inside.md", mtime: modifiedAfter + 1 },
    ]);
    const result = await collectDailyPulseInput(sources({ listRecentNotes }), { now: NOW });

    expect(listRecentNotes).toHaveBeenCalledWith({
      modifiedAfter,
      limit: DAILY_PULSE_RECENT_NOTE_SCAN_LIMIT,
    });
    expect(result.input.recentNotes).toEqual([
      { path: "Inside.md", mtime: modifiedAfter + 1 },
    ]);
  });

  it("sorts, deduplicates and bounds recent note candidates", async () => {
    const candidates = Array.from(
      { length: DAILY_PULSE_RECENT_NOTE_LIMIT + 4 },
      (_, index) => ({ path: `Active/Note ${index}.md`, mtime: NOW - index - 1 })
    );
    candidates.push({ ...candidates[0] });
    candidates.reverse();

    const result = await collectDailyPulseInput(sources({
      listRecentNotes: async () => candidates,
    }), { now: NOW, lastPulseAt: LAST_PULSE_AT });

    expect(result.input.recentNotes).toHaveLength(DAILY_PULSE_RECENT_NOTE_LIMIT);
    expect(result.input.recentNotes[0]).toEqual({ path: "Active/Note 0.md", mtime: NOW - 1 });
    expect(new Set(result.input.recentNotes.map(({ path }) => path)).size)
      .toBe(DAILY_PULSE_RECENT_NOTE_LIMIT);
  });

  it("does not mutate arrays or records returned by any source", async () => {
    const tasks = [task("input", "needs-input"), task("done", "done")];
    const loops = [loop("due"), loop("future", { resurface: "2026-07-21" })];
    const proposals = [{ id: "proposal-1", kind: "loop" as const, title: "Follow up" }];
    const runs = [run("pending")];
    const notes = [{ path: "Active/Changed.md", mtime: NOW - 1 }];
    const budget = {
      enabled: true,
      dailyBudget: 1_000,
      ledger: { dateUTC: "2026-07-19", tokensUsed: 900 },
    };
    const snapshot = structuredClone({ tasks, loops, proposals, runs, notes, budget });

    const result = await collectDailyPulseInput(sources({
      taskStore: { load: async () => ({ tasks, warnings: [] }) },
      loadLoops: async () => loops,
      proposalStore: { listPending: async () => ({ records: proposals, warnings: [] }) },
      loadAutomationRuns: async () => runs,
      listRecentNotes: async () => notes,
      loadBackgroundBudget: async () => budget,
    }), { now: NOW, lastPulseAt: LAST_PULSE_AT });

    expect({ tasks, loops, proposals, runs, notes, budget }).toEqual(snapshot);
    expect(result.input.automationRuns[0].writes).not.toBe(runs[0].writes);
    expect(result.input.budget).toEqual({ remaining: 1_000 });
  });

  it("reports disabled, unlimited and exhausted background budget consistently", async () => {
    const collectBudget = async (enabled: boolean, dailyBudget: number, tokensUsed: number) =>
      collectDailyPulseInput(sources({
        loadBackgroundBudget: async () => ({
          enabled,
          dailyBudget,
          ledger: { dateUTC: "2026-07-20", tokensUsed },
        }),
      }), { now: NOW, lastPulseAt: LAST_PULSE_AT });

    await expect(collectBudget(false, 10_000, 100)).resolves.toMatchObject({
      input: { budget: { remaining: 0 } },
    });
    await expect(collectBudget(true, 0, 100)).resolves.toMatchObject({
      input: { budget: { remaining: null } },
    });
    await expect(collectBudget(true, 100, 150)).resolves.toMatchObject({
      input: { budget: { remaining: 0 } },
    });
  });
});
