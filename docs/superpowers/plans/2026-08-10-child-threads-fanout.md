# Child Threads — Supervisable Fan-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an Exo agent delegate work to real, supervisable child conversations that appear in the chats sidebar and Orchestration Board, and that report their outcome back to the parent.

**Architecture:** Board-first. Fan-out rides the existing pipeline — `tasks.md` ledger (`core/tasks.ts`) → pure reducer with concurrency cap (`core/orchestrator.ts`) → impure driver that spawns chats and consumes convo-state events (`obsidian/orchestrator-driver.ts`). This plan adds: a `parent` field on the ledger, fan-out/depth caps, two agent tools, a pure child-report reducer, and UI grouping. All new logic lands in pure, unit-tested modules; `view.ts` (7100 lines, no tests) receives wiring only.

**Tech Stack:** TypeScript, Obsidian plugin API, `@anthropic-ai/claude-agent-sdk` (`tool` + `createSdkMcpServer`), zod, vitest.

**Design doc:** `docs/plans/2026-08-10-child-threads-fanout.md`

## Global Constraints

- Test runner: `pnpm test` (vitest). Typecheck: `pnpm typecheck`. Lint: `pnpm lint`. Full gate: `pnpm release:check`.
- New logic goes in pure modules under `src/core/` with **no Obsidian imports** (so they unit-test in isolation). `view.ts` gets wiring only — never new logic.
- `view.ts` is under a size ratchet (`tests/size-contract.test.ts`). Keep additions there minimal; if the ratchet fails, the logic belongs in a core module.
- The whole feature is gated by the existing `orchestrationEnabled` setting (default OFF). When it is false, the tool list sent to sessions must be **byte-identical** to before this feature existed.
- Ledger parsing is tolerant and never throws: unknown lines are skipped, `formatTask ∘ parseTasksFile` must round-trip.
- All ledger writes go through the shared `tasksWriteQueue` (`obsidian/task-store.ts`) — never a direct vault write.
- Fan-out caps: **5** open (non-done/archived) children per parent; depth **2** (parent → child → grandchild, then refuse).
- Child report excerpt cap: **2000** chars. Report debounce: **2000** ms.
- Commit after each task. Do not `git add -A` in the vault repo; in this repo staging explicit paths is still required. `docs/` plans are gitignored — stage them with `git add -f`.

---

### Task 1: `parent` field on the task ledger

**Files:**
- Modify: `src/core/tasks.ts` (the `TaskEntry` interface, `META` regex, `formatTask`, `parseTasksFile`, `NewBacklogTask`, `addBacklogTask`)
- Test: `tests/tasks.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `TaskEntry.parent?: string`; `NewBacklogTask.parent?: string`; `addBacklogTask(content, task, now)` accepting and persisting `parent`. Later tasks read `entry.parent`.

- [ ] **Step 1: Write the failing test**

Add to `tests/tasks.test.ts`, inside the existing `describe("formatTask / parseTasksFile round-trip", ...)` block:

```typescript
  it("round-trips the parent field", () => {
    const entry: TaskEntry = {
      id: "task-1720000000003",
      title: "Research competitor pricing",
      status: "queued",
      created: "2026-08-10T10:00:00.000Z",
      updated: "2026-08-10T10:00:00.000Z",
      parent: "convo-parent-1",
      prompt: "Look into competitor pricing pages.",
    };
    const block = formatTask(entry);
    expect(block).toContain("- parent: convo-parent-1");
    const [parsed] = parseTasksFile(block);
    expect(parsed).toEqual(entry);
  });

  it("omits the parent line entirely when there is no parent", () => {
    const entry: TaskEntry = {
      id: "task-1720000000004",
      title: "Standalone task",
      status: "backlog",
      created: "2026-08-10T10:00:00.000Z",
      updated: "2026-08-10T10:00:00.000Z",
      prompt: "Do the thing.",
    };
    expect(formatTask(entry)).not.toContain("parent");
    const [parsed] = parseTasksFile(formatTask(entry));
    expect(parsed.parent).toBeUndefined();
  });

  it("addBacklogTask persists a parent when given one", () => {
    const { entry } = addBacklogTask(
      "",
      { title: "Child work", prompt: "Do it.", parent: "convo-parent-1" },
      1720000000005
    );
    expect(entry.parent).toBe("convo-parent-1");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/tasks.test.ts`
Expected: FAIL — TypeScript/assertion errors on `parent` not existing on `TaskEntry` / `NewBacklogTask`.

- [ ] **Step 3: Write minimal implementation**

In `src/core/tasks.ts`:

Add to the `TaskEntry` interface, after `convo`:

```typescript
  /** Convo id of the conversation that spawned this task (fan-out parentage).
   *  Omitted for tasks a human created directly. The ledger is the source of
   *  truth for parentage; `Convo.parentConvoId` is a denormalized UI copy. */
  parent?: string;
```

Extend the `META` regex to accept the key:

```typescript
const META = /^-\s+(title|status|created|updated|model|convo|order|parent):\s*(.*)$/;
```

In `formatTask`, after the `convo` line:

```typescript
  if (e.parent) lines.push(`- parent: ${e.parent}`);
```

In `parseTasksFile`, declare `let parent: string | undefined;` alongside `convo`, add the branch:

```typescript
      else if (key === "parent") parent = val || undefined;
```

and include it in the pushed entry, after the `convo` spread:

```typescript
      ...(parent ? { parent } : {}),
```

Add `parent?: string;` to `NewBacklogTask`, and in `addBacklogTask`'s entry literal, after the `model` spread:

```typescript
    ...(task.parent ? { parent: task.parent } : {}),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/tasks.test.ts`
Expected: PASS (all existing tests still green — `parent` is additive and optional).

- [ ] **Step 5: Commit**

```bash
git add src/core/tasks.ts tests/tasks.test.ts
git commit -m "feat(tasks): add optional parent field to the ledger"
```

---

### Task 2: Fan-out caps (pure)

**Files:**
- Create: `src/core/child-tasks.ts`
- Test: `tests/child-tasks.test.ts`

**Interfaces:**
- Consumes: `TaskEntry` (with `parent`) from Task 1.
- Produces:
  - `MAX_OPEN_CHILDREN = 5`, `MAX_FANOUT_DEPTH = 2`
  - `childrenOf(tasks: TaskEntry[], parentConvoId: string): TaskEntry[]`
  - `openChildCount(tasks: TaskEntry[], parentConvoId: string): number`
  - `fanoutDepth(tasks: TaskEntry[], parentConvoId: string): number`
  - `canSpawnChild(tasks: TaskEntry[], parentConvoId: string): { ok: true } | { ok: false; reason: string }`

- [ ] **Step 1: Write the failing test**

Create `tests/child-tasks.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  childrenOf,
  openChildCount,
  fanoutDepth,
  canSpawnChild,
  MAX_OPEN_CHILDREN,
} from "../src/core/child-tasks";
import type { TaskEntry } from "../src/core/tasks";

function task(over: Partial<TaskEntry> & { id: string }): TaskEntry {
  return {
    title: "t",
    status: "queued",
    created: "2026-08-10T10:00:00.000Z",
    updated: "2026-08-10T10:00:00.000Z",
    prompt: "p",
    ...over,
  } as TaskEntry;
}

describe("childrenOf / openChildCount", () => {
  it("returns only tasks whose parent matches", () => {
    const tasks = [
      task({ id: "task-1", parent: "convo-a" }),
      task({ id: "task-2", parent: "convo-b" }),
      task({ id: "task-3" }),
    ];
    expect(childrenOf(tasks, "convo-a").map((t) => t.id)).toEqual(["task-1"]);
  });

  it("does not count done or archived children as open", () => {
    const tasks = [
      task({ id: "task-1", parent: "convo-a", status: "running" }),
      task({ id: "task-2", parent: "convo-a", status: "done" }),
      task({ id: "task-3", parent: "convo-a", status: "archived" }),
    ];
    expect(openChildCount(tasks, "convo-a")).toBe(1);
  });
});

describe("fanoutDepth", () => {
  it("is 0 for a convo that is not itself a child", () => {
    expect(fanoutDepth([task({ id: "task-1", parent: "convo-a" })], "convo-a")).toBe(0);
  });

  it("is 1 for the convo of a task that has a parent", () => {
    const tasks = [task({ id: "task-1", parent: "convo-a", convo: "convo-b" })];
    expect(fanoutDepth(tasks, "convo-b")).toBe(1);
  });

  it("is 2 for a grandchild convo", () => {
    const tasks = [
      task({ id: "task-1", parent: "convo-a", convo: "convo-b" }),
      task({ id: "task-2", parent: "convo-b", convo: "convo-c" }),
    ];
    expect(fanoutDepth(tasks, "convo-c")).toBe(2);
  });

  it("terminates on a cyclic ledger instead of hanging", () => {
    const tasks = [
      task({ id: "task-1", parent: "convo-b", convo: "convo-a" }),
      task({ id: "task-2", parent: "convo-a", convo: "convo-b" }),
    ];
    expect(fanoutDepth(tasks, "convo-a")).toBeGreaterThanOrEqual(2);
  });
});

describe("canSpawnChild", () => {
  it("allows a spawn under both caps", () => {
    expect(canSpawnChild([], "convo-a")).toEqual({ ok: true });
  });

  it("refuses past the open-children cap, naming the cap", () => {
    const tasks = Array.from({ length: MAX_OPEN_CHILDREN }, (_, i) =>
      task({ id: `task-${i}`, parent: "convo-a", status: "queued" })
    );
    const res = canSpawnChild(tasks, "convo-a");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain(String(MAX_OPEN_CHILDREN));
  });

  it("refuses at max depth", () => {
    const tasks = [
      task({ id: "task-1", parent: "convo-a", convo: "convo-b" }),
      task({ id: "task-2", parent: "convo-b", convo: "convo-c" }),
    ];
    const res = canSpawnChild(tasks, "convo-c");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("depth");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/child-tasks.test.ts`
Expected: FAIL — cannot resolve `../src/core/child-tasks`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/child-tasks.ts`:

```typescript
/**
 * Fan-out caps — pure predicates over the task ledger (no Obsidian imports).
 *
 * A "child task" is a ledger entry whose `parent` is the convo id of the
 * conversation that spawned it. Two caps keep a delegating agent from running
 * away: how many children one parent may have open at once, and how deep the
 * chain may go. Concurrency itself is NOT decided here — that stays the
 * orchestrator reducer's `maxConcurrent`.
 */
import type { TaskEntry } from "./tasks";

/** Max children per parent that are not yet done/archived. */
export const MAX_OPEN_CHILDREN = 5;
/** Max chain length: parent → child → grandchild, then refuse. */
export const MAX_FANOUT_DEPTH = 2;

/** Statuses that no longer occupy a fan-out slot. */
const CLOSED = new Set(["done", "archived"]);

export function childrenOf(tasks: TaskEntry[], parentConvoId: string): TaskEntry[] {
  return tasks.filter((t) => t.parent === parentConvoId);
}

export function openChildCount(tasks: TaskEntry[], parentConvoId: string): number {
  return childrenOf(tasks, parentConvoId).filter((t) => !CLOSED.has(t.status)).length;
}

/**
 * How many spawn hops separate `convoId` from a human-started conversation.
 * Walks up via "the task whose `convo` is this convo" → its `parent`. The
 * visited set makes a hand-edited cyclic ledger terminate instead of hanging.
 */
export function fanoutDepth(tasks: TaskEntry[], convoId: string): number {
  let depth = 0;
  let current = convoId;
  const seen = new Set<string>([current]);
  for (;;) {
    const owning = tasks.find((t) => t.convo === current && t.parent);
    if (!owning || !owning.parent) return depth;
    depth++;
    current = owning.parent;
    if (seen.has(current)) return depth;
    seen.add(current);
  }
}

/** Whether `parentConvoId` may spawn one more child right now. */
export function canSpawnChild(
  tasks: TaskEntry[],
  parentConvoId: string
): { ok: true } | { ok: false; reason: string } {
  const open = openChildCount(tasks, parentConvoId);
  if (open >= MAX_OPEN_CHILDREN) {
    return {
      ok: false,
      reason: `This conversation already has ${open} open child tasks (cap ${MAX_OPEN_CHILDREN}). Wait for one to finish, or mark one done on the board.`,
    };
  }
  const depth = fanoutDepth(tasks, parentConvoId);
  if (depth >= MAX_FANOUT_DEPTH) {
    return {
      ok: false,
      reason: `Delegation depth ${depth} is at the cap (${MAX_FANOUT_DEPTH}). Do this work here instead of spawning another level.`,
    };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/child-tasks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/child-tasks.ts tests/child-tasks.test.ts
git commit -m "feat(child-tasks): pure fan-out and depth caps"
```

---

### Task 3: Child-report reducer (pure)

**Files:**
- Create: `src/core/child-reports.ts`
- Test: `tests/child-reports.test.ts`

**Interfaces:**
- Consumes: `ConvoState` / `ConvoStateReason` from `src/core/convo-state.ts`.
- Produces:
  - `EXCERPT_CAP = 2000`, `REPORT_DEBOUNCE_MS = 2000`
  - `interface ChildReport { taskId: string; childConvoId: string; title: string; outcome: ChildOutcome; excerpt: string; at: number }`
  - `type ChildOutcome = "done" | "blocked" | "stopped" | "error"`
  - `outcomeFromState(state: ConvoState, reason?: ConvoStateReason): ChildOutcome | null`
  - `buildExcerpt(text: string): string`
  - `formatReportsForParent(reports: ChildReport[]): string`

- [ ] **Step 1: Write the failing test**

Create `tests/child-reports.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  outcomeFromState,
  buildExcerpt,
  formatReportsForParent,
  EXCERPT_CAP,
  type ChildReport,
} from "../src/core/child-reports";

describe("outcomeFromState", () => {
  it("maps a clean turn-end to done", () => {
    expect(outcomeFromState("turn-end")).toBe("done");
  });

  it("maps needs-input with an error reason to error, and otherwise to blocked", () => {
    expect(outcomeFromState("needs-input", "error")).toBe("error");
    expect(outcomeFromState("needs-input", "perm")).toBe("blocked");
    expect(outcomeFromState("needs-input", "ask")).toBe("blocked");
  });

  it("maps stopped to stopped", () => {
    expect(outcomeFromState("stopped", "stopped")).toBe("stopped");
  });

  it("returns null for turn-start, which is not an outcome", () => {
    expect(outcomeFromState("turn-start")).toBeNull();
  });
});

describe("buildExcerpt", () => {
  it("returns short text unchanged", () => {
    expect(buildExcerpt("all done")).toBe("all done");
  });

  it("caps long text and marks the truncation", () => {
    const out = buildExcerpt("x".repeat(EXCERPT_CAP + 500));
    expect(out.length).toBeLessThanOrEqual(EXCERPT_CAP + 20);
    expect(out).toContain("truncated");
  });

  it("trims surrounding whitespace", () => {
    expect(buildExcerpt("  hi\n\n")).toBe("hi");
  });
});

describe("formatReportsForParent", () => {
  const base: ChildReport = {
    taskId: "task-1",
    childConvoId: "convo-b",
    title: "Research pricing",
    outcome: "done",
    excerpt: "Found three competitors.",
    at: 1720000000000,
  };

  it("names the child, its outcome and its excerpt", () => {
    const out = formatReportsForParent([base]);
    expect(out).toContain("Research pricing");
    expect(out).toContain("done");
    expect(out).toContain("Found three competitors.");
  });

  it("batches several reports into one message", () => {
    const out = formatReportsForParent([base, { ...base, taskId: "task-2", title: "Draft post" }]);
    expect(out).toContain("Research pricing");
    expect(out).toContain("Draft post");
  });

  it("carries anti-hallucination guidance for stopped children", () => {
    const out = formatReportsForParent([{ ...base, outcome: "stopped" }]);
    expect(out.toLowerCase()).toContain("do not resume");
  });

  it("returns an empty string for no reports", () => {
    expect(formatReportsForParent([])).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/child-reports.test.ts`
Expected: FAIL — cannot resolve `../src/core/child-reports`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/child-reports.ts`:

```typescript
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
 * that channel: reason `error` is a failure, everything else is a live question
 * waiting for the user.
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
  done: "finished",
  blocked: "is waiting for input",
  stopped: "was stopped by Mario",
  error: "failed",
};

/**
 * Render a batch of reports as one message for the parent agent. Deliberately
 * plain prose: it is prepended to the parent's next turn, so it must read as
 * context, not as a tool result.
 */
export function formatReportsForParent(reports: ChildReport[]): string {
  if (!reports.length) return "";
  const blocks = reports.map((r) => {
    const head = `Child task "${r.title}" (${r.taskId}) ${OUTCOME_LINE[r.outcome]}.`;
    const body = r.excerpt ? `\n${r.excerpt}` : "";
    return `${head}${body}`;
  });
  const guidance =
    reports.some((r) => r.outcome === "stopped")
      ? "\n\nOne of these was stopped by hand: do not resume its work unless Mario asks."
      : "";
  const plural = reports.length === 1 ? "a task you delegated" : "tasks you delegated";
  return `Update on ${plural}:\n\n${blocks.join("\n\n")}${guidance}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/child-reports.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/child-reports.ts tests/child-reports.test.ts
git commit -m "feat(child-reports): pure outcome mapping and parent report formatting"
```

---

### Task 4: Child-tree grouping for the sidebar (pure)

**Files:**
- Create: `src/core/child-tree.ts`
- Test: `tests/child-tree.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (structural input only).
- Produces:
  - `interface ChildTreeNode { id: string; depth: 0 | 1 }`
  - `groupByParent<T extends { id: string; parentConvoId?: string }>(convos: T[]): { item: T; depth: 0 | 1 }[]`

- [ ] **Step 1: Write the failing test**

Create `tests/child-tree.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { groupByParent } from "../src/core/child-tree";

type C = { id: string; parentConvoId?: string };

describe("groupByParent", () => {
  it("keeps parentless convos at depth 0 in input order", () => {
    const out = groupByParent<C>([{ id: "a" }, { id: "b" }]);
    expect(out).toEqual([
      { item: { id: "a" }, depth: 0 },
      { item: { id: "b" }, depth: 0 },
    ]);
  });

  it("places a child at depth 1 directly after its parent", () => {
    const out = groupByParent<C>([{ id: "a" }, { id: "b" }, { id: "a1", parentConvoId: "a" }]);
    expect(out.map((n) => n.item.id)).toEqual(["a", "a1", "b"]);
    expect(out.map((n) => n.depth)).toEqual([0, 1, 0]);
  });

  it("keeps several children of one parent in input order", () => {
    const out = groupByParent<C>([
      { id: "a" },
      { id: "a1", parentConvoId: "a" },
      { id: "a2", parentConvoId: "a" },
    ]);
    expect(out.map((n) => n.item.id)).toEqual(["a", "a1", "a2"]);
  });

  it("promotes an orphan (parent absent from the list) to depth 0", () => {
    const out = groupByParent<C>([{ id: "x1", parentConvoId: "gone" }]);
    expect(out).toEqual([{ item: { id: "x1", parentConvoId: "gone" }, depth: 0 }]);
  });

  it("never nests deeper than one level: a grandchild renders at depth 1", () => {
    const out = groupByParent<C>([
      { id: "a" },
      { id: "a1", parentConvoId: "a" },
      { id: "a1x", parentConvoId: "a1" },
    ]);
    expect(out.map((n) => n.item.id)).toEqual(["a", "a1", "a1x"]);
    expect(out.map((n) => n.depth)).toEqual([0, 1, 1]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/child-tree.test.ts`
Expected: FAIL — cannot resolve `../src/core/child-tree`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/child-tree.ts`:

```typescript
/**
 * Child-tree grouping — the pure projection behind the chats sidebar's indented
 * children (no Obsidian imports, no DOM).
 *
 * The sidebar shows a flat list; this decides the ORDER and the indent level so
 * the view only renders. Indentation is capped at one level on purpose: a
 * grandchild renders beside its parent rather than marching rightwards, since
 * the sidebar is narrow and the fan-out depth cap is 2 anyway.
 */

/** One rendered row: the original item plus how far to indent it. */
export interface GroupedConvo<T> {
  item: T;
  depth: 0 | 1;
}

export function groupByParent<T extends { id: string; parentConvoId?: string }>(
  convos: T[]
): GroupedConvo<T>[] {
  const present = new Set(convos.map((c) => c.id));
  // Children bucketed by parent, preserving input order within each bucket.
  const byParent = new Map<string, T[]>();
  for (const c of convos) {
    const parent = c.parentConvoId;
    if (!parent || !present.has(parent)) continue;
    const bucket = byParent.get(parent);
    if (bucket) bucket.push(c);
    else byParent.set(parent, [c]);
  }
  const emitted = new Set<string>();
  const out: GroupedConvo<T>[] = [];
  const emitChildren = (parentId: string): void => {
    for (const child of byParent.get(parentId) ?? []) {
      if (emitted.has(child.id)) continue;
      emitted.add(child.id);
      out.push({ item: child, depth: 1 });
      // Grandchildren follow their parent, still at depth 1 (see header).
      emitChildren(child.id);
    }
  };
  for (const c of convos) {
    if (emitted.has(c.id)) continue;
    // Anything whose parent is in this list is emitted by its parent, not here.
    if (c.parentConvoId && present.has(c.parentConvoId)) continue;
    emitted.add(c.id);
    out.push({ item: c, depth: 0 });
    emitChildren(c.id);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/child-tree.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/child-tree.ts tests/child-tree.test.ts
git commit -m "feat(child-tree): pure sidebar grouping for child conversations"
```

---

### Task 5: `createChildTask` store helper

**Files:**
- Modify: `src/obsidian/task-store.ts` (add `createChildTask` beside `createBacklogTask`)
- Test: `tests/task-store.test.ts` (existing file; uses the fake vault adapter already defined there)

**Interfaces:**
- Consumes: `addBacklogTask` with `parent` (Task 1); `TaskVaultAdapter`, `WriteQueue`, `TASKS_PATH` (existing).
- Produces: `createChildTask(vault, queue, task: NewBacklogTask & { parent: string }, tasksPath?): Promise<TaskEntry>` — creates the entry already in `queued` status so the reducer promotes it on the next free slot.

- [ ] **Step 1: Write the failing test**

Open `tests/task-store.test.ts`, read how the existing tests build their fake `TaskVaultAdapter` and `WriteQueue`, and add a matching block (reuse the file's existing helper — do not invent a second fake):

```typescript
describe("createChildTask", () => {
  it("writes a queued task carrying its parent convo id", async () => {
    // Build the fake vault + queue exactly as the sibling createBacklogTask
    // tests in this file already do.
    const { vault, queue } = makeFakeVault();
    const entry = await createChildTask(vault, queue, {
      title: "Research pricing",
      prompt: "Look into competitor pricing.",
      parent: "convo-parent-1",
    });
    expect(entry.status).toBe("queued");
    expect(entry.parent).toBe("convo-parent-1");
    const written = await vault.read(TASKS_PATH);
    expect(written).toContain("- parent: convo-parent-1");
    expect(written).toContain("- status: queued");
  });
});
```

Add `createChildTask` to this file's import list from `../src/obsidian/task-store`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/task-store.test.ts`
Expected: FAIL — `createChildTask` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/obsidian/task-store.ts`, directly below `createBacklogTask`:

```typescript
/**
 * Create a task spawned BY a conversation (fan-out). Same queued write path as
 * `createBacklogTask` — one shared `WriteQueue`, so chat-driven and board-driven
 * creation never interleave a read-modify-write — with two differences: the
 * entry carries its `parent` convo id, and it starts `queued` rather than
 * `backlog`, because a delegated task is meant to run as soon as the
 * orchestrator has a free slot.
 */
export async function createChildTask(
  vault: TaskVaultAdapter,
  queue: WriteQueue,
  task: NewBacklogTask & { parent: string },
  tasksPath: string = TASKS_PATH
): Promise<TaskEntry> {
  return queue.enqueue(async () => {
    const existing = vault.getFile(tasksPath);
    const current = existing ? await vault.read(tasksPath) : "";
    const { content, entry } = addBacklogTask(current, task);
    const queued: TaskEntry = { ...entry, status: "queued" };
    const next = content.replace(formatTask(entry), formatTask(queued));
    if (existing) {
      await vault.modify(tasksPath, next);
    } else {
      await vault.ensureFolder(tasksPath);
      await vault.create(tasksPath, next);
    }
    return queued;
  });
}
```

Ensure `formatTask` is imported from `../core/tasks` in this file (add it to the existing import if absent).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/task-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/obsidian/task-store.ts tests/task-store.test.ts
git commit -m "feat(task-store): createChildTask writes queued tasks with parentage"
```

---

### Task 6: `spawn_task` and `list_tasks` tools

**Files:**
- Modify: `src/obsidian/tools.ts` (new `parentConvoId` option; two new tools; registration list around the existing `...(orchestrationEnabled ? [addTask] : [])`)
- Modify: `src/view.ts` (pass `parentConvoId: c.id` where the tool server is built — the same per-convo closure site that already passes `askBridge`/`rethinkBridge`)
- Test: `tests/obsidian-tools.test.ts` — **first check which existing test file covers `tools.ts`** (`ls tests | grep -i tool`) and add to that file rather than creating a duplicate.

**Interfaces:**
- Consumes: `createChildTask` (Task 5); `canSpawnChild`, `childrenOf` (Task 2); `parseTasksFile` (existing).
- Produces: tools `spawn_task({title, prompt, model?})` and `list_tasks({all?})`, registered only when `orchestrationEnabled` is true.

- [ ] **Step 1: Write the failing test**

In the tools test file, add a block asserting registration gating and cap refusal. Follow the file's existing pattern for building the server/tool list:

```typescript
describe("fan-out tools", () => {
  it("registers spawn_task and list_tasks only when orchestration is enabled", () => {
    const off = toolNamesFor({ orchestrationEnabled: false });
    expect(off).not.toContain("spawn_task");
    expect(off).not.toContain("list_tasks");
    const on = toolNamesFor({ orchestrationEnabled: true, parentConvoId: "convo-a" });
    expect(on).toContain("spawn_task");
    expect(on).toContain("list_tasks");
  });

  it("does not register spawn_task without a parent convo id", () => {
    const names = toolNamesFor({ orchestrationEnabled: true });
    expect(names).not.toContain("spawn_task");
  });
});
```

`toolNamesFor` is a local helper in that test file (or write one mirroring how the file already enumerates registered tool names).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/obsidian-tools.test.ts`
Expected: FAIL — `spawn_task` never registered.

- [ ] **Step 3: Write minimal implementation**

In `src/obsidian/tools.ts`, add to the destructured options (beside `tasksWriteQueue`):

```typescript
    /** Convo id of the conversation this tool server belongs to. Present only
     *  for real chat sessions (never headless runs) — `spawn_task` is not
     *  registered without it, since a child with no parent has nobody to
     *  report to. */
    parentConvoId,
```

and to the `ObsidianToolOpts` interface: `parentConvoId?: string;`

Add the two tools after `addTask`:

```typescript
  const spawnTask = tool(
    "spawn_task",
    "Delegate a piece of work to a separate child conversation that runs in parallel with this one. Use it when the work is self-contained and would otherwise crowd this thread — research a source, draft a section, check a dataset. The child starts as soon as the board has a free slot, runs as a normal chat (so it can ask Mario for permission), and reports its outcome back here when it finishes. Prefer doing small work yourself: each child is a whole conversation Mario has to supervise.",
    {
      title: z.string().describe("Short title shown on the board card and in the sidebar."),
      prompt: z.string().describe("The full instruction for the child conversation — it does not see this chat's history."),
      model: z.string().optional().describe("Provider model id for the child; omit for the default."),
    },
    async (args) => {
      if (!parentConvoId) return ok("Delegation is unavailable in this session.");
      const vault = adaptAppToTaskVault(app);
      const existing = vault.getFile(paths.tasks);
      const current = existing ? await vault.read(paths.tasks) : "";
      const gate = canSpawnChild(parseTasksFile(current), parentConvoId);
      if (!gate.ok) return ok(gate.reason);
      const entry = await createChildTask(
        vault,
        tasksWriteQueue,
        {
          title: args.title,
          prompt: args.prompt,
          parent: parentConvoId,
          ...(args.model ? { model: args.model } : {}),
        },
        paths.tasks
      );
      return ok(
        `Queued child task ${entry.id}: ${entry.title}. It starts when the board has a free slot and reports back here when it is done.`
      );
    }
  );

  const listTasks = tool(
    "list_tasks",
    "List tasks on the Orchestration Board. By default it shows only the child tasks this conversation delegated, with their current status — use it to check on work you handed off before reporting to Mario.",
    {
      all: z.boolean().optional().describe("List every task on the board instead of only this conversation's children."),
    },
    async (args) => {
      const vault = adaptAppToTaskVault(app);
      const existing = vault.getFile(paths.tasks);
      const tasks = parseTasksFile(existing ? await vault.read(paths.tasks) : "");
      const shown = args.all ? tasks : parentConvoId ? childrenOf(tasks, parentConvoId) : [];
      if (!shown.length) return ok(args.all ? "The board is empty." : "This conversation has not delegated any tasks.");
      return ok(
        shown
          .map((t) => `- ${t.id} · ${t.status} · ${t.title}${t.convo ? "" : " (not started yet)"}`)
          .join("\n")
      );
    }
  );
```

Add the imports at the top of the file:

```typescript
import { canSpawnChild, childrenOf } from "../core/child-tasks";
import { parseTasksFile } from "../core/tasks";
import { createChildTask } from "./task-store";
```

(Check whether `parseTasksFile` / `createChildTask` are already imported before adding duplicates.)

Extend the registration line:

```typescript
    ...(orchestrationEnabled ? [addTask, listTasks] : []),
    ...(orchestrationEnabled && parentConvoId ? [spawnTask] : []),
```

In `src/view.ts`, at the per-convo tool-server construction site (the object literal that already contains `orchestrationEnabled: s.orchestrationEnabled && !readOnlySandbox` and `tasksWriteQueue: this.plugin.tasksWriteQueue`), add:

```typescript
          parentConvoId: c.id,
```

If the positional-argument form of `createObsidianToolServer` is used at the other call site in `view.ts`, pass it through the options object there too — do not change the positional signature.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run tests/obsidian-tools.test.ts && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/obsidian/tools.ts src/view.ts tests/obsidian-tools.test.ts
git commit -m "feat(tools): spawn_task and list_tasks for supervisable fan-out"
```

---

### Task 7: Driver stamps parentage and emits child reports

**Files:**
- Modify: `src/obsidian/orchestrator-driver.ts` (`DriverDeps`, `runEffect`, the convo-state listener)
- Test: `tests/orchestrator-driver.test.ts` (existing file with fakes for `DriverStore` / subscribe / spawn)

**Interfaces:**
- Consumes: `outcomeFromState`, `buildExcerpt`, `ChildReport`, `REPORT_DEBOUNCE_MS` (Task 3); `TaskEntry.parent` (Task 1).
- Produces: `DriverDeps.onChildReport?(report: ChildReport): void` and `DriverDeps.lastAssistantText?(convoId: string): string`; `DriverDeps.spawn` gains an optional second-arg field `parent?: string`.

- [ ] **Step 1: Write the failing test**

Add to `tests/orchestrator-driver.test.ts`, reusing the file's existing fake-deps builder:

```typescript
describe("child reports", () => {
  it("reports a child's completion to its parent, with the excerpt", async () => {
    const reports: ChildReport[] = [];
    const deps = makeDeps({
      tasks: [
        {
          id: "task-1",
          title: "Research pricing",
          status: "running",
          created: "2026-08-10T10:00:00.000Z",
          updated: "2026-08-10T10:00:00.000Z",
          parent: "convo-parent",
          convo: "convo-child",
          prompt: "p",
        },
      ],
      onChildReport: (r) => reports.push(r),
      lastAssistantText: () => "Found three competitors.",
    });
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    deps.emit({ convoId: "convo-child", state: "turn-end" });
    await deps.flushReports();
    expect(reports).toHaveLength(1);
    expect(reports[0].outcome).toBe("done");
    expect(reports[0].title).toBe("Research pricing");
    expect(reports[0].excerpt).toBe("Found three competitors.");
  });

  it("emits no report for a task that has no parent", async () => {
    const reports: ChildReport[] = [];
    const deps = makeDeps({
      tasks: [
        {
          id: "task-2",
          title: "Solo task",
          status: "running",
          created: "2026-08-10T10:00:00.000Z",
          updated: "2026-08-10T10:00:00.000Z",
          convo: "convo-solo",
          prompt: "p",
        },
      ],
      onChildReport: (r) => reports.push(r),
    });
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    deps.emit({ convoId: "convo-solo", state: "turn-end" });
    await deps.flushReports();
    expect(reports).toHaveLength(0);
  });

  it("emits no report for turn-start, which is not an outcome", async () => {
    const reports: ChildReport[] = [];
    const deps = makeDeps({
      tasks: [
        {
          id: "task-3",
          title: "Child",
          status: "running",
          created: "2026-08-10T10:00:00.000Z",
          updated: "2026-08-10T10:00:00.000Z",
          parent: "convo-parent",
          convo: "convo-child",
          prompt: "p",
        },
      ],
      onChildReport: (r) => reports.push(r),
    });
    const driver = new OrchestratorDriver(deps);
    await driver.start();
    deps.emit({ convoId: "convo-child", state: "turn-start" });
    await deps.flushReports();
    expect(reports).toHaveLength(0);
  });
});
```

Extend the file's `makeDeps` helper with the two new optional deps and a `flushReports()` that awaits the debounce (use vitest fake timers if the file already does, otherwise `await new Promise((r) => setTimeout(r, REPORT_DEBOUNCE_MS + 50))`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/orchestrator-driver.test.ts`
Expected: FAIL — no `onChildReport` behavior.

- [ ] **Step 3: Write minimal implementation**

In `src/obsidian/orchestrator-driver.ts`, extend `DriverDeps`:

```typescript
  /** Spawn a chat for a task and return its new convo id. `parent` is passed
   *  through so the view can stamp `parentConvoId` on the new conversation and
   *  keep it out of the tab strip. */
  spawn(prompt: string, opts?: { model?: string; parent?: string }): Promise<string>;
  /** Last assistant text of a convo, for the report excerpt. Absent → no excerpt. */
  lastAssistantText?(convoId: string): string;
  /** Deliver a finished child's report to its parent. Absent → reports are off. */
  onChildReport?(report: ChildReport): void;
```

In `runEffect`, pass the parent through when the task has one:

```typescript
      const task = this.tasks.find((t) => t.id === effect.taskId);
      const convoId = await this.deps.spawn(effect.prompt, {
        ...(effect.model ? { model: effect.model } : {}),
        ...(task?.parent ? { parent: task.parent } : {}),
      });
```

(Keep the existing falsy-convoId check and catch block exactly as they are.)

In the convo-state listener, after the existing reducer dispatch, add report emission:

```typescript
    // Child reporting: a task WITH a parent that reached an outcome tells its
    // parent. Never inline — batched behind the debounce so a child that ends
    // several turns in quick succession produces one message, not five.
    const owner = this.tasks.find((t) => t.convo === e.convoId);
    if (owner?.parent && this.deps.onChildReport) {
      const outcome = outcomeFromState(e.state, e.reason);
      if (outcome) {
        this.pendingReports.set(owner.id, {
          taskId: owner.id,
          childConvoId: e.convoId,
          title: owner.title,
          outcome,
          excerpt: buildExcerpt(this.deps.lastAssistantText?.(e.convoId) ?? ""),
          at: Date.now(),
        });
        this.scheduleReportFlush();
      }
    }
```

Add the field and flush method to the class:

```typescript
  private readonly pendingReports = new Map<string, ChildReport>();
  private reportTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleReportFlush(): void {
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.reportTimer = setTimeout(() => {
      this.reportTimer = null;
      const batch = [...this.pendingReports.values()];
      this.pendingReports.clear();
      for (const report of batch) {
        try {
          this.deps.onChildReport?.(report);
        } catch {
          // A failing consumer must never break orchestration — same isolation
          // contract as the convo-state channel's listeners.
        }
      }
    }, REPORT_DEBOUNCE_MS);
  }
```

Clear the timer in the driver's existing `stop()`/dispose path:

```typescript
    if (this.reportTimer) {
      clearTimeout(this.reportTimer);
      this.reportTimer = null;
    }
```

Add the import:

```typescript
import {
  buildExcerpt,
  outcomeFromState,
  REPORT_DEBOUNCE_MS,
  type ChildReport,
} from "../core/child-reports";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/orchestrator-driver.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/obsidian/orchestrator-driver.ts tests/orchestrator-driver.test.ts
git commit -m "feat(driver): stamp child parentage and batch child reports"
```

---

### Task 8: View wiring — parentage, strip exclusion, sidebar indent, report delivery

**Files:**
- Modify: `src/ui/convo-types.ts` (`ConvoData.parentConvoId`, `Convo.parentConvoId`, `Convo.pendingChildReports`)
- Modify: `src/view.ts` (spawn path stamps parentage and skips the strip; report delivery)
- Modify: `src/ui/chat-list-view.ts` (indented rendering via `groupByParent`)
- Modify: `src/main.ts` (wire `onChildReport` / `lastAssistantText` into the driver deps where the board driver is constructed)
- Modify: `styles.css` (one indent rule)

**Interfaces:**
- Consumes: `groupByParent` (Task 4), `formatReportsForParent` + `ChildReport` (Task 3), driver deps (Task 7).
- Produces: child convos carrying `parentConvoId`, excluded from the tab strip at creation, indented in the sidebar, and delivering queued reports on the parent's next turn.

- [ ] **Step 1: Add the persisted fields**

In `src/ui/convo-types.ts`, add to **both** `ConvoData` and `Convo`:

```typescript
  /** Convo id of the conversation that spawned this one via `spawn_task`.
   *  Denormalized from the ledger's `parent` (which stays the source of truth)
   *  so the sidebar can group without reading tasks.md. Persisted. */
  parentConvoId?: string;
```

and to `Convo` only:

```typescript
  /** Reports from finished child tasks, waiting to be handed to this
   *  conversation's model on its NEXT turn. Runtime-only: a reloaded chat has
   *  no in-flight turn to prepend them to, and the board still shows the
   *  children's real state. */
  pendingChildReports?: ChildReport[];
```

with `import type { ChildReport } from "../core/child-reports";` at the top.

- [ ] **Step 2: Verify persistence carries the new field**

Run: `pnpm vitest run tests/persistence.test.ts`
Expected: PASS. If the persistence mapper enumerates `ConvoData` fields explicitly, add `parentConvoId` to both the to-disk and from-disk mapping in `src/core/persistence.ts`, then re-run until green.

- [ ] **Step 3: Wire the spawn path**

In `src/view.ts`, find the method the driver's `spawn` dep is bound to (`startTaskConversation` in `src/main.ts` delegates into the view — follow it to the view method that creates the conversation, near `askInNewConversation`). Extend its options to accept `parent?: string`, and when present:

1. stamp `c.parentConvoId = parent` on the new `Convo` before the first turn runs;
2. do **not** add the new convo to the tab strip / working set (children live in the sidebar and board; opening one later uses the normal open path).

Keep the existing contract that a failure resolves with `""` — the driver's falsy check depends on it.

- [ ] **Step 4: Wire report delivery**

In `src/main.ts`, where the board driver's deps are constructed, add:

```typescript
      lastAssistantText: (convoId) => this.view?.lastAssistantTextOf(convoId) ?? "",
      onChildReport: (report) => this.view?.deliverChildReport(report),
```

In `src/view.ts` add the two thin methods (wiring only — the formatting lives in `core/child-reports.ts`):

```typescript
  /** Last assistant message text of a conversation, for a child report excerpt. */
  lastAssistantTextOf(convoId: string): string {
    const c = this.convos.find((x) => x.id === convoId);
    if (!c) return "";
    for (let i = c.messages.length - 1; i >= 0; i--) {
      const m = c.messages[i];
      if (m.role === "assistant") return typeof m.text === "string" ? m.text : "";
    }
    return "";
  }

  /** Queue a finished child's report onto its parent and surface it in the UI.
   *  The model sees it on the parent's NEXT turn (never mid-turn). */
  deliverChildReport(report: ChildReport): void {
    const parent = this.convos.find((x) => x.id === report.childConvoId)?.parentConvoId;
    const target = this.convos.find((x) => x.id === parent);
    if (!target) return; // orphan: parent archived or deleted — drop silently
    (target.pendingChildReports ??= []).push(report);
    target.unread = true;
    this.renderChatList();
  }
```

Adapt the exact member names (`this.convos`, `this.renderChatList`, the `Message` text field) to what `view.ts` actually uses — verify each before writing it.

Then, at the point where a turn is about to be sent (where `pendingSendPrefix` is already consumed in `runTurn`), prepend any queued reports:

```typescript
    const childReports = c.pendingChildReports?.length
      ? formatReportsForParent(c.pendingChildReports)
      : "";
    if (childReports) c.pendingChildReports = [];
```

and join `childReports` ahead of the existing prefix, keeping the existing "consumed once" semantics.

- [ ] **Step 5: Wire the sidebar indent**

In `src/ui/chat-list-view.ts`, replace the direct iteration over conversations with:

```typescript
import { groupByParent } from "../core/child-tree";
```

```typescript
    for (const { item, depth } of groupByParent(convos)) {
      const row = /* existing row creation for `item` */;
      if (depth === 1) row.addClass("mv-chat-row-child");
    }
```

In `styles.css`, add one rule beside the existing chat-row rules:

```css
.mv-chat-row-child {
  padding-left: calc(var(--mv-space-3, 12px) * 2);
}
```

Verify the class prefix and spacing token against the neighbouring rules in the file; match them rather than introducing new names.

- [ ] **Step 6: Run the full gate**

Run: `pnpm release:check`
Expected: lint clean, all tests pass, build succeeds. If `tests/size-contract.test.ts` fails on `view.ts` growth, move logic out of the view into a core module rather than raising the ratchet.

- [ ] **Step 7: Commit**

```bash
git add src/ui/convo-types.ts src/view.ts src/ui/chat-list-view.ts src/main.ts src/core/persistence.ts styles.css
git commit -m "feat(fanout): child convos out of the strip, indented in the sidebar, reporting to parents"
```

---

### Task 9: Manual verification in the live vault

**Files:** none (verification only).

**Interfaces:**
- Consumes: everything above.
- Produces: a verified end-to-end fan-out, or a bug list.

- [ ] **Step 1: Build and reload**

Run: `pnpm build`

The build writes `main.js` straight into the live vault plugin dir via `.obsidian-plugin-dir`. Do **not** force a plugin reload while a turn is in flight — it kills the live turn. Reload from Obsidian when idle.

- [ ] **Step 2: Enable the flag**

In Exo settings, turn the Orchestration Board on (`orchestrationEnabled`). Confirm `spawn_task` and `list_tasks` appear in the session's tool list (Capabilities Hub → Tools).

- [ ] **Step 3: Exercise the happy path**

In a chat, ask Exo to delegate two small research tasks. Verify, in order:

1. Two `queued` cards appear on the board, each showing its parent.
2. They promote to `running` respecting `maxConcurrent` (default 2).
3. The child conversations do **not** appear in the tab strip.
4. They appear indented under the parent in the chats sidebar.
5. On completion the parent shows an unread marker.
6. The parent's next turn visibly has the children's outcomes in context (ask it "what did your children report?").

- [ ] **Step 4: Exercise the refusals**

Ask for six children in one conversation: the sixth must be refused with the cap message, not silently dropped. From inside a child, ask it to delegate again twice: the second level must be refused with the depth message.

- [ ] **Step 5: Exercise the blocked path**

Give a child a task that triggers a permission prompt. Verify it lands in the board's `needs-input` lane and that the parent receives a "waiting for input" report.

- [ ] **Step 6: Record results**

Append findings to `docs/plans/2026-08-10-child-threads-fanout.md` under a new `## Verification` section — real outcomes, including anything that failed.

```bash
git add -f docs/plans/2026-08-10-child-threads-fanout.md
git commit -m "docs: record child-threads fan-out verification results"
```

---

## Self-Review

**Spec coverage:** ledger `parent` → Task 1; caps (5 open / depth 2) → Task 2 + enforced in Task 6; child reports with 2s debounce, 2000-char excerpt, anti-hallucination guidance, dual UI/model rails → Tasks 3, 7, 8; `spawn_task` + `list_tasks` → Task 6; normal-session child permissions (no headless profile) → inherited by construction, verified in Task 9 Step 5; children out of the strip, indented in the sidebar, board chip → Task 8 (the board "child of" chip is the one spec item folded into the existing card render — if it proves non-trivial, it is a follow-up, not a blocker); orphan drop → Task 8 Step 4; caps never silent → Task 6 + Task 9 Step 4; pure-module testing → every task.

**Deviation from the spec, deliberate:** the spec proposed `spawn_task` alongside an assumed-absent task tool. `add_task` already exists (backlog, human-parked). `spawn_task` is therefore a sibling with different semantics (queued + parented), not a replacement — both stay gated by `orchestrationEnabled`.

**Known unverified seams** the implementer must check rather than assume: the exact spawn method reached by `startTaskConversation` in `view.ts`; whether `createObsidianToolServer`'s second call site uses positional args; the persistence mapper's field enumeration; the chat-row class prefix and spacing token in `styles.css`; the existing fake-vault helper name in `tests/task-store.test.ts`.
