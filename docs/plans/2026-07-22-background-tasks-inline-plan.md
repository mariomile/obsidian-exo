# Inline Background-Tasks List — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `.mva-agents` chip above the composer into an expandable, enumerable list of the open chat's live background work (subagent / background Bash / Workflow agents), each row click-jumping to its card, with the list surviving turn-end (keep-alive Level 1).

**Architecture:** A pure, Obsidian-free core (`src/core/live-tasks.ts`) owns the `LiveTask` type and all label/summary/fade logic (unit-tested, same discipline as `session-cards.ts`). The impure `ChatView` keeps a `Map` of live tasks **on `Convo`** (not the per-turn `AssistantCtx`, which is what makes it outlive the turn), populated from the three existing registration sites, and renders a toggle popover above the composer. Row click scrolls + flashes the target card. A turn-start reconciliation sweep evicts orphaned/faded entries.

**Tech Stack:** TypeScript, Obsidian plugin API, vitest (`npm run test`), tsc (`npm run typecheck`), esbuild build → deploy to vault via `.obsidian-plugin-dir` + `plugin:reload`.

## Global Constraints

- **No PR — land on `main`.** obsidian-exo ships directly to main + push (repo convention).
- **`docs/plans/` is gitignored** — `git add -f` when committing plan/spec docs.
- **Pure cores stay Obsidian-free** — `src/core/*` must not import from `obsidian` or `src/ui/*` (keeps them vitest-testable). DOM/`HTMLElement` lives only in `view.ts`.
- **Chip stays strictly per-open-chat** — never aggregate other chats' tasks (invariant at `view.ts:4322`). Cross-chat is out of scope (Cockpit work).
- **Copy:** keep the existing running-count phrasing style (`"1 agent running"` / `"N agents running"`).
- **Fade window:** terminal (done/error/stopped) rows linger `LIVE_FADE_MS = 2000` then evict.
- Reference spec: `docs/plans/2026-07-22-background-tasks-inline.md`.

---

## File Structure

- **Create** `src/core/live-tasks.ts` — pure types + `summarizeLiveTasks`, `liveTaskDotClass`, `liveTaskStatusText`, `fadedTaskIds`. Obsidian-free.
- **Create** `tests/live-tasks.test.ts` — unit tests for the core.
- **Modify** `src/view.ts` — `Convo.liveTasks` map + init; populate from the three sites; rewire `agentCount`; impure helpers (`liveUpsert`/`liveStatus`/`liveRemove`/`reconcileLiveTasks`/`flashCard`); expandable popover render + toggle; row click → scroll+flash; turn-start sweep; per-row dismiss.
- **Modify** `styles.css` — `.mva-agents-list` popover, `.mva-agents-row`, reuse `.mva-subagent-dot` colors, `.mva-flash`, dismiss `×`, expand caret.

---

## Task 1: Pure core — `live-tasks.ts` + tests

**Files:**
- Create: `src/core/live-tasks.ts`
- Test: `tests/live-tasks.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `type LiveTaskKind = "subagent" | "bash" | "workflow"`
  - `type LiveTaskStatus = "running" | "done" | "error" | "stopped"`
  - `interface LiveTask { id: string; kind: LiveTaskKind; label: string; status: LiveTaskStatus; startedAt: number; doneAt?: number }` (DOM-free)
  - `interface LiveTasksSummary { count: number; running: number; spinner: boolean; chipLabel: string }`
  - `function summarizeLiveTasks(tasks: LiveTask[]): LiveTasksSummary`
  - `function liveTaskDotClass(status: LiveTaskStatus): "" | "is-ok" | "is-error"`
  - `function liveTaskStatusText(status: LiveTaskStatus): string`
  - `function fadedTaskIds(tasks: LiveTask[], now: number, fadeMs: number): string[]`

- [ ] **Step 1: Write the failing test**

Create `tests/live-tasks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  summarizeLiveTasks,
  liveTaskDotClass,
  liveTaskStatusText,
  fadedTaskIds,
  type LiveTask,
} from "../src/core/live-tasks";

const t = (id: string, status: LiveTask["status"], over: Partial<LiveTask> = {}): LiveTask => ({
  id,
  kind: "subagent",
  label: id,
  status,
  startedAt: 0,
  ...over,
});

describe("summarizeLiveTasks", () => {
  it("all running → spinner + running phrasing", () => {
    const s = summarizeLiveTasks([t("a", "running"), t("b", "running")]);
    expect(s).toMatchObject({ count: 2, running: 2, spinner: true, chipLabel: "2 agents running" });
  });

  it("singular running copy", () => {
    expect(summarizeLiveTasks([t("a", "running")]).chipLabel).toBe("1 agent running");
  });

  it("mixed running + done → combined label, still spinning", () => {
    const s = summarizeLiveTasks([t("a", "running"), t("b", "done"), t("c", "error")]);
    expect(s.running).toBe(1);
    expect(s.spinner).toBe(true);
    expect(s.chipLabel).toBe("1 running · 2 done");
  });

  it("nothing running → no spinner, done phrasing", () => {
    const s = summarizeLiveTasks([t("a", "done"), t("b", "stopped")]);
    expect(s.spinner).toBe(false);
    expect(s.chipLabel).toBe("2 done");
  });

  it("empty → zero count, empty label", () => {
    expect(summarizeLiveTasks([])).toMatchObject({ count: 0, running: 0, spinner: false, chipLabel: "" });
  });
});

describe("liveTaskDotClass / liveTaskStatusText", () => {
  it("maps status to dot class", () => {
    expect(liveTaskDotClass("running")).toBe("");
    expect(liveTaskDotClass("done")).toBe("is-ok");
    expect(liveTaskDotClass("stopped")).toBe("is-ok");
    expect(liveTaskDotClass("error")).toBe("is-error");
  });
  it("maps status to text", () => {
    expect(liveTaskStatusText("running")).toBe("running");
    expect(liveTaskStatusText("stopped")).toBe("stopped");
  });
});

describe("fadedTaskIds", () => {
  it("evicts terminal rows older than fadeMs, keeps running and fresh", () => {
    const tasks = [
      t("run", "running"),
      t("old", "done", { doneAt: 100 }),
      t("fresh", "error", { doneAt: 900 }),
    ];
    expect(fadedTaskIds(tasks, 1200, 500)).toEqual(["old"]);
  });
  it("terminal without doneAt is not evicted (grace until stamped)", () => {
    expect(fadedTaskIds([t("x", "done")], 9999, 500)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Dev\ Projects/obsidian-exo && npm run test -- live-tasks`
Expected: FAIL — `Cannot find module '../src/core/live-tasks'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/live-tasks.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Dev\ Projects/obsidian-exo && npm run test -- live-tasks`
Expected: PASS (all cases green).

- [ ] **Step 5: Typecheck**

Run: `cd ~/Dev\ Projects/obsidian-exo && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd ~/Dev\ Projects/obsidian-exo
git add src/core/live-tasks.ts tests/live-tasks.test.ts
git commit -m "feat(live-tasks): pure core for background-tasks chip projection"
```

---

## Task 2: State on `Convo` + parallel population (invisible)

Populate a new `Convo.liveTasks` map from the three existing sites, keeping `agentCount` on its current source so nothing changes visually yet. This isolates the state move from the count rewire.

**Files:**
- Modify: `src/view.ts` — `Convo` interface (~172), convo creation, `registerTaskCard` (3692), `onEvent` subagent branch (4701-4713), `trackBackgroundTask` call site (4707), workflow-progress case (4924-4939).

**Interfaces:**
- Consumes: `LiveTask`, `LiveTaskKind`, `LiveTaskStatus` from `./core/live-tasks`; `toolMeta` from `./ui/tools`.
- Produces:
  - `type LiveTaskRecord = LiveTask & { cardEl: HTMLElement }`
  - `Convo.liveTasks: Map<string, LiveTaskRecord>`
  - `private liveUpsert(c: Convo, rec: LiveTaskRecord): void`

- [ ] **Step 1: Add imports and the record type**

At the top of `view.ts`, add to the existing `./core/...` import group:

```ts
import {
  summarizeLiveTasks,
  liveTaskDotClass,
  liveTaskStatusText,
  fadedTaskIds,
  type LiveTask,
  type LiveTaskStatus,
} from "./core/live-tasks";
```

Near the `Convo` interface, add the view-side record (DOM-carrying) type:

```ts
/** A live task plus its scroll-to target card. The DOM-free `LiveTask` fields
 *  feed the pure core; `cardEl` is view-only. */
export type LiveTaskRecord = LiveTask & { cardEl: HTMLElement };
```

- [ ] **Step 2: Add `liveTasks` to the `Convo` interface**

Inside `interface Convo` (after `currentCtx`, ~212), add:

```ts
  /** Live background work this conversation owns RIGHT NOW — subagents, background
   *  Bash, and Workflow agents. Lives on the Convo (NOT the per-turn AssistantCtx)
   *  so it OUTLIVES the turn: keep-alive Level 1. Keyed by tool-call id (subagent/
   *  bash) or Workflow tool_use id. Drives the expandable agents chip. Runtime-only. */
  liveTasks: Map<string, LiveTaskRecord>;
```

- [ ] **Step 3: Initialize `liveTasks` where convos are created**

Find every object literal that builds a `Convo` (search `runningTasks` is per-ctx, so instead search for convo creation — grep `currentCtx: null`). Add `liveTasks: new Map(),` alongside `currentCtx: null,` in each.

Run to find sites: `grep -n "currentCtx: null" src/view.ts`
For each site, add `liveTasks: new Map(),`.

- [ ] **Step 4: Add the `liveUpsert` helper**

Add near `refreshAgentIndicators` (~4324):

```ts
  /** Insert or update a live task on a convo and refresh the chip. The single
   *  mutation point so the count/label and any open popover stay in sync. */
  private liveUpsert(c: Convo, rec: LiveTaskRecord): void {
    c.liveTasks.set(rec.id, rec);
    this.refreshAgentIndicators();
    this.renderAgentPopover(); // no-op until Task 4 adds it; declared there
  }
```

> Note: `renderAgentPopover` is added in Task 4. To keep Task 2 compiling on its own, add a temporary stub now and flesh it out in Task 4:
> ```ts
> private renderAgentPopover(): void { /* filled in Task 4 */ }
> ```

- [ ] **Step 5: Populate from the subagent site**

In `onEvent`, `tool-call-start`, after `registerTaskCard(ctx, e.id); ctx.runningTasks.add(e.id);` (4704-4705), add:

```ts
              const subCard = ctx.cards.get(e.id)?.card;
              if (subCard) {
                const m = toolMeta(e.name, e.input);
                this.liveUpsert(c, {
                  id: e.id,
                  kind: "subagent",
                  label: m.target || m.label, // description if present, else "Subagent"
                  status: "running",
                  startedAt: Date.now(),
                  cardEl: subCard,
                });
              }
```

- [ ] **Step 6: Populate from the background-Bash site**

Still in `tool-call-start`, right after `this.trackBackgroundTask(ctx, e.id, e.name, e.input);` (4707), add:

```ts
              const bg = ctx.bgTasks.get(e.id);
              if (bg) {
                const m = toolMeta(e.name, e.input);
                this.liveUpsert(c, {
                  id: e.id,
                  kind: "bash",
                  label: m.target || "background task",
                  status: "running",
                  startedAt: Date.now(),
                  cardEl: bg.cardEl,
                });
              }
```

- [ ] **Step 7: Populate from the workflow site**

In the `"workflow-progress"` case, after `refs.wfEl.setText(summarizeWorkflowRun(run).label);` (4939), add (inside the `if (refs)` block, using the tool card element `refs.card`):

```ts
            const wfStatus: LiveTaskStatus =
              run.status === "completed" ? "done" : run.status === "failed" ? "error" : "running";
            this.liveUpsert(c, {
              id: e.toolUseId,
              kind: "workflow",
              label: `${run.name ?? "workflow"} · ${summarizeWorkflowRun(run).label}`,
              status: wfStatus,
              startedAt: Date.now(), // first sighting; not re-stamped on updates below
              cardEl: refs.card,
            });
```

> If `refs.card` is not the field name on the cards map value, use whatever holds the tool card `HTMLElement` (same object `ctx.cards.get(id)` whose `.card` is used at `view.ts:3651`). Re-stamping `startedAt` on every progress event is acceptable (progress is frequent but the value is cosmetic elapsed time); if you prefer stability, guard with `c.liveTasks.get(e.toolUseId)?.startedAt ?? Date.now()`.

- [ ] **Step 8: Typecheck + existing tests**

Run: `cd ~/Dev\ Projects/obsidian-exo && npm run typecheck && npm run test`
Expected: no type errors; all existing tests still pass. (No visual change yet — `agentCount` still reads the old source.)

- [ ] **Step 9: Commit**

```bash
cd ~/Dev\ Projects/obsidian-exo
git add src/view.ts
git commit -m "feat(live-tasks): populate Convo.liveTasks from the three background sites"
```

---

## Task 3: Rewire `agentCount` + terminal transitions & fade

Switch the chip count to read `liveTasks`, add done/error/stopped transitions with a fade eviction. After this task the count reflects `liveTasks` (now including Workflow agents) and **survives turn end** (keep-alive L1 emerges because the map is on `Convo`).

**Files:**
- Modify: `src/view.ts` — `agentCount` (4315-4318), subagent result branch (4739), KillShell branch inside `trackBackgroundTask` (3669), add `liveStatus` + `liveRemove` helpers.

**Interfaces:**
- Consumes: `summarizeLiveTasks`, `fadedTaskIds` from `./core/live-tasks`.
- Produces:
  - `private liveStatus(c: Convo, id: string, status: LiveTaskStatus): void`
  - `private liveRemove(c: Convo, id: string): void`
  - `LIVE_FADE_MS` constant.

- [ ] **Step 1: Add the fade constant and helpers**

Near the top-of-class constants, add:

```ts
  private static readonly LIVE_FADE_MS = 2000;
```

Add below `liveUpsert`:

```ts
  /** Mark a live task terminal (done/error/stopped), stamp `doneAt`, and schedule
   *  its eviction after the fade window so the row lingers briefly then leaves. */
  private liveStatus(c: Convo, id: string, status: LiveTaskStatus): void {
    const rec = c.liveTasks.get(id);
    if (!rec) return;
    rec.status = status;
    rec.doneAt = Date.now();
    this.refreshAgentIndicators();
    this.renderAgentPopover();
    if (status !== "running") {
      window.setTimeout(() => this.liveRemove(c, id), ChatView.LIVE_FADE_MS);
    }
  }

  /** Evict a live task and refresh the chip. */
  private liveRemove(c: Convo, id: string): void {
    if (c.liveTasks.delete(id)) {
      this.refreshAgentIndicators();
      this.renderAgentPopover();
    }
  }
```

> Replace `ChatView` with the actual class name if different (grep `export default class` / `class .* extends ItemView` in `view.ts`).

- [ ] **Step 2: Rewire `agentCount` to `liveTasks`**

Replace the body of `agentCount` (4315-4318):

```ts
  private agentCount(c: Convo): number {
    return c.liveTasks.size;
  }
```

- [ ] **Step 3: Use the summary in `refreshAgentIndicators`**

In `refreshAgentIndicators` (4324), replace the label/icon block (4329-4334) so the chip label and spinner come from the core summary:

```ts
    chip.empty();
    const c = this.active;
    const tasks = c ? [...c.liveTasks.values()] : [];
    const sum = summarizeLiveTasks(tasks);
    chip.toggleClass("is-hidden", sum.count === 0);
    if (sum.count === 0) return;
    const icon = chip.createSpan({ cls: "mva-agents-icon" });
    icon.toggleClass("is-idle", !sum.spinner); // stop the spin when nothing runs
    setIcon(icon, sum.spinner ? "loader" : "check");
    chip.createSpan({ cls: "mva-agents-label", text: sum.chipLabel });
    setIcon(chip.createSpan({ cls: "mva-agents-caret" }), "chevron-up");
    this.clickable(chip, () => this.toggleAgentPopover()); // added in Task 4
```

> `toggleAgentPopover` is added in Task 4; add a temporary stub `private toggleAgentPopover(): void {}` now so this compiles, and flesh it out in Task 4.

- [ ] **Step 4: Transition subagent to terminal on its result**

In `onEvent` `tool-call-result`, where `if (ctx.runningTasks.delete(e.id)) this.refreshAgentIndicators();` (4739), replace with:

```ts
            if (ctx.runningTasks.delete(e.id)) {
              this.liveStatus(c, e.id, e.ok ? "done" : "error");
            }
```

(`liveStatus` already calls `refreshAgentIndicators`.)

- [ ] **Step 5: Transition background Bash to stopped on KillShell**

In `trackBackgroundTask`, in the KillShell/BashOutput link branch where `task.badgeEl.setText(...)` (3669), add after it:

```ts
          if (name === "KillShell") this.liveStatus(ctx.convo, /* originating bg id */ this.bgIdForShell(ctx, sid), "stopped");
```

Add the small resolver helper (background Bash entries are keyed by their original tool-call id, not the shell id):

```ts
  /** Find the live-task id (original background Bash tool-call id) for a shell id. */
  private bgIdForShell(ctx: AssistantCtx, sid: string): string {
    for (const [id, task] of ctx.bgTasks) if (task.shellId === sid) return id;
    return "";
  }
```

Guard `liveStatus("")` is harmless (`liveTasks.get("")` → undefined → no-op).

- [ ] **Step 6: Typecheck + build + manual verify**

Run: `cd ~/Dev\ Projects/obsidian-exo && npm run typecheck && npm run test && npm run build`
Expected: clean. Reload in Obsidian (`plugin:reload` via obsidian-cli, or Cmd-P → "Reload app without saving"). Then:
1. Ask Exo something that spawns a subagent → chip shows "1 agent running".
2. Let the turn END while the subagent is still working → **chip stays visible** (was: disappeared). This is the keep-alive win.
3. On completion → count drops; the entry fades within ~2s.

- [ ] **Step 7: Commit**

```bash
cd ~/Dev\ Projects/obsidian-exo
git add src/view.ts
git commit -m "feat(live-tasks): count from liveTasks + terminal fade (keep-alive L1)"
```

---

## Task 4: Expandable popover UI

Render the enumerable list above the chip, toggled by clicking the chip.

**Files:**
- Modify: `src/view.ts` — replace the `renderAgentPopover`/`toggleAgentPopover` stubs; add `agentPopoverEl` field; close-on-outside/Esc.
- Modify: `styles.css` — `.mva-agents-list`, `.mva-agents-row`, `.mva-agents-caret`, `.mva-agents-icon.is-idle`.

**Interfaces:**
- Consumes: `liveTaskDotClass`, `liveTaskStatusText` from `./core/live-tasks`.
- Produces: `private agentPopoverEl: HTMLElement | null`.

- [ ] **Step 1: Add the field**

With the other element fields (near `agentChipEl`, 379):

```ts
  private agentPopoverEl: HTMLElement | null = null;
```

- [ ] **Step 2: Implement `toggleAgentPopover`**

```ts
  /** Toggle the enumerable list of this chat's live tasks, anchored above the chip. */
  private toggleAgentPopover(): void {
    if (this.agentPopoverEl) {
      this.closeAgentPopover();
      return;
    }
    if (!this.agentChipEl || !this.active?.liveTasks.size) return;
    const pop = this.agentChipEl.createDiv({ cls: "mva-agents-list" });
    this.agentPopoverEl = pop;
    this.renderAgentPopover();
    // Close on outside click / Esc (registered next tick so THIS click doesn't fire it).
    window.setTimeout(() => {
      this.registerDomEvent(document, "click", this.onAgentPopoverOutside);
      this.registerDomEvent(document, "keydown", this.onAgentPopoverKey);
    }, 0);
  }

  private closeAgentPopover(): void {
    this.agentPopoverEl?.remove();
    this.agentPopoverEl = null;
    document.removeEventListener("click", this.onAgentPopoverOutside);
    document.removeEventListener("keydown", this.onAgentPopoverKey);
  }

  private onAgentPopoverOutside = (e: MouseEvent): void => {
    if (this.agentChipEl && !this.agentChipEl.contains(e.target as Node)) this.closeAgentPopover();
  };

  private onAgentPopoverKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.closeAgentPopover();
  };
```

> If `registerDomEvent` double-registration is a concern, `closeAgentPopover` already removes by the same bound reference — the arrow-function fields are stable per instance, so add/remove pair correctly.

- [ ] **Step 3: Implement `renderAgentPopover`**

Replace the stub:

```ts
  /** (Re)draw the popover rows from the active convo's live tasks. No-op when the
   *  popover is closed; auto-closes when the list empties. */
  private renderAgentPopover(): void {
    const pop = this.agentPopoverEl;
    if (!pop) return;
    const c = this.active;
    const tasks = c ? [...c.liveTasks.values()] : [];
    if (!tasks.length) {
      this.closeAgentPopover();
      return;
    }
    pop.empty();
    for (const rec of tasks) {
      const row = pop.createDiv({ cls: "mva-agents-row" });
      row.createSpan({ cls: `mva-subagent-dot ${liveTaskDotClass(rec.status)}` });
      row.createSpan({ cls: "mva-agents-row-label", text: rec.label });
      row.createSpan({ cls: "mva-agents-row-status", text: liveTaskStatusText(rec.status) });
      this.clickable(row, () => this.jumpToLiveTask(rec)); // added in Task 5
      const x = row.createSpan({ cls: "mva-agents-row-x" });
      setIcon(x, "x");
      this.clickable(x, (e) => {
        e.stopPropagation();
        if (c) this.liveRemove(c, rec.id);
      });
    }
  }
```

> `jumpToLiveTask` is added in Task 5; add a temporary stub `private jumpToLiveTask(_rec: LiveTaskRecord): void {}` now.

- [ ] **Step 4: Add CSS**

Append to `styles.css` after the `.mva-agents:hover` rule (~937):

```css
.mva-agents-caret {
  display: inline-flex;
  align-items: center;
  margin-left: auto;
  color: var(--text-muted);
}
.mva-agents-caret .svg-icon { width: 12px; height: 12px; }
.mva-agents-icon.is-idle .svg-icon { animation: none; color: var(--color-green, #19c37d); }

/* Enumerable list, anchored above the chip (opens upward). */
.mva-agents-list {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 14px;
  right: 14px;
  max-width: var(--mva-content-max);
  margin: 0 auto;
  max-height: 40vh;
  overflow-y: auto;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--mva-r2, 8px);
  box-shadow: var(--shadow-s);
  padding: 4px;
  z-index: var(--layer-popover, 30);
}
.mva-agents { position: relative; } /* anchor for the absolute list */
.mva-agents-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--mva-r1, 6px);
  cursor: pointer;
}
.mva-agents-row:hover { background: var(--background-modifier-hover); }
.mva-agents-row-label {
  color: var(--text-normal);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mva-agents-row-status {
  margin-left: auto;
  color: var(--text-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}
.mva-agents-row-x {
  display: inline-flex;
  align-items: center;
  color: var(--text-faint);
  flex-shrink: 0;
}
.mva-agents-row-x:hover { color: var(--text-normal); }
.mva-agents-row-x .svg-icon { width: 13px; height: 13px; }
```

- [ ] **Step 5: Typecheck + build + manual verify**

Run: `cd ~/Dev\ Projects/obsidian-exo && npm run typecheck && npm run build`
Reload. Spawn a subagent + a background Bash. Click the chip → popover opens upward with two rows (label + status + `×`). Click chip again / click outside / Esc → closes. Click `×` on a row → that row leaves.

- [ ] **Step 6: Commit**

```bash
cd ~/Dev\ Projects/obsidian-exo
git add src/view.ts styles.css
git commit -m "feat(live-tasks): expandable agents popover with per-row dismiss"
```

---

## Task 5: Row click → scroll + flash

**Files:**
- Modify: `src/view.ts` — replace `jumpToLiveTask` stub; add `flashCard`.
- Modify: `styles.css` — `.mva-flash` keyframe.

**Interfaces:**
- Consumes: `LiveTaskRecord`.
- Produces: `private jumpToLiveTask(rec: LiveTaskRecord): void`, `private flashCard(el: HTMLElement): void`.

- [ ] **Step 1: Implement `jumpToLiveTask` + `flashCard`**

Replace the stub:

```ts
  /** Scroll the task's card into view, flash it, and close the popover. */
  private jumpToLiveTask(rec: LiveTaskRecord): void {
    this.closeAgentPopover();
    if (!rec.cardEl.isConnected) return; // card was cleaned (old turn) — nothing to show
    rec.cardEl.scrollIntoView({ block: "center", behavior: "smooth" });
    this.flashCard(rec.cardEl);
  }

  /** Transient highlight so the eye lands on the right card after a jump. */
  private flashCard(el: HTMLElement): void {
    el.addClass("mva-flash");
    window.setTimeout(() => el.removeClass("mva-flash"), 1000);
  }
```

- [ ] **Step 2: Add the flash CSS**

Append to `styles.css`:

```css
.mva-flash {
  animation: mva-flash 1s ease-out;
}
@keyframes mva-flash {
  0% { box-shadow: 0 0 0 2px var(--interactive-accent); }
  100% { box-shadow: 0 0 0 2px transparent; }
}
```

- [ ] **Step 3: Typecheck + build + manual verify**

Run: `cd ~/Dev\ Projects/obsidian-exo && npm run typecheck && npm run build`
Reload. Spawn work, scroll away from its card, open the chip, click the row → transcript scrolls to the card and it flashes. Popover closes.

- [ ] **Step 4: Commit**

```bash
cd ~/Dev\ Projects/obsidian-exo
git add src/view.ts styles.css
git commit -m "feat(live-tasks): row click scrolls + flashes the target card"
```

---

## Task 6: Turn-start reconciliation sweep

Evict orphaned (card detached) and faded (terminal past window) entries when a new stream starts, so nothing lingers stuck on "running" after a turn that never delivered a completion event.

**Files:**
- Modify: `src/view.ts` — `runTurn`, right after `c.currentCtx = ctx;` (4585).

**Interfaces:**
- Consumes: `fadedTaskIds` from `./core/live-tasks`.
- Produces: `private reconcileLiveTasks(c: Convo): void`.

- [ ] **Step 1: Add the sweep helper**

```ts
  /** Turn-start reconciliation: drop live tasks whose card was cleaned (orphaned by
   *  a finished turn) or whose terminal fade window has elapsed. The keep-alive L1
   *  backstop — without a session-level event pump (L2, out of scope), a task that
   *  finished with no active stream can't self-clear; this sweeps it on the next turn. */
  private reconcileLiveTasks(c: Convo): void {
    let changed = false;
    for (const [id, rec] of c.liveTasks) {
      if (!rec.cardEl.isConnected) {
        c.liveTasks.delete(id);
        changed = true;
      }
    }
    for (const id of fadedTaskIds([...c.liveTasks.values()], Date.now(), ChatView.LIVE_FADE_MS)) {
      c.liveTasks.delete(id);
      changed = true;
    }
    if (changed) {
      this.refreshAgentIndicators();
      this.renderAgentPopover();
    }
  }
```

- [ ] **Step 2: Call it at turn start**

Right after `c.currentCtx = ctx;` (4585):

```ts
    this.reconcileLiveTasks(c); // drop orphaned/faded entries before this turn adds new ones
```

- [ ] **Step 3: Typecheck + build + full manual pass**

Run: `cd ~/Dev\ Projects/obsidian-exo && npm run typecheck && npm run test && npm run build`
Reload. Full scenario from spec §7:
1. Subagent + background Bash in parallel → chip "2 agents running", popover lists both.
2. Click a row → scroll + flash.
3. End the turn with the subagent still alive → list persists.
4. Completion → row goes done → fades after ~2s.
5. Start a new turn where a prior entry's card is gone → sweep removes it (no stuck "running").
6. `×` on a lingering row → immediate removal.

- [ ] **Step 4: Commit**

```bash
cd ~/Dev\ Projects/obsidian-exo
git add src/view.ts
git commit -m "feat(live-tasks): turn-start reconciliation sweep for orphaned/faded tasks"
```

---

## Self-Review

**Spec coverage:**
- §1 Modello dati → Task 1 (pure `LiveTask`) + Task 2 (`LiveTaskRecord` + `Convo.liveTasks`, agentCount → Task 3). ✓
- §2 Siti di registrazione (subagent/bash/workflow) → Task 2 Steps 5-7. ✓
- §3 UI chip espandibile → Task 4. ✓
- §4 Interazione riga → card → Task 5. ✓
- §5 Keep-alive L1 + riconciliazione → Task 3 (state on Convo, terminal fade) + Task 6 (sweep). ✓
- §6 Edge cases (scroll-to, orphan, workflow-no-agents, stopped) → Task 5 (`isConnected` guard), Task 6 (orphan sweep), Task 2 Step 7 (workflow label), Task 3 Step 5 (stopped). ✓
- §7 Verifica → per-task manual + `npm run test`/`typecheck`/`build`. ✓
- Per-row dismiss `×` → Task 4 Step 3. ✓

**Placeholder scan:** Temporary stubs (`renderAgentPopover`, `toggleAgentPopover`, `jumpToLiveTask`) are explicitly introduced and each is fleshed out in a named later task — not open-ended TODOs. Two grounding caveats flagged inline (actual class name for `ChatView`; the cards-map card-element field name) with the exact grep to resolve them.

**Type consistency:** `LiveTask` (core, DOM-free) vs `LiveTaskRecord = LiveTask & { cardEl }` (view) used consistently. Helper names stable across tasks: `liveUpsert`/`liveStatus`/`liveRemove`/`reconcileLiveTasks`/`jumpToLiveTask`/`flashCard`/`toggleAgentPopover`/`renderAgentPopover`/`closeAgentPopover`. `LIVE_FADE_MS` defined once (Task 3), reused (Task 6). Core fns `summarizeLiveTasks`/`liveTaskDotClass`/`liveTaskStatusText`/`fadedTaskIds` match Task 1 signatures at all call sites.
