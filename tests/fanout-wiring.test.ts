import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Fan-out wiring contract — the seams that connect the tested pure cores to
 * each other through files nothing can unit-test.
 *
 * `view.ts` imports `obsidian` and has ZERO tests; `main.ts` and `board-view.ts`
 * are thin bridges over it. Every link in this chain is a plain function call
 * whose failure mode is silence, not a crash:
 *
 *   spawn_task → driver.spawn({parent}) → main.startTaskConversation
 *              → view.startTaskConversation → Convo.parentConvoId
 *   child ends → driver.onChildReport → main.deliverChildReport
 *              → view queues it → next turn's outbound
 *
 * The typecheck does NOT close it. `DriverDeps.spawn` types `opts` as
 * `{ model?, parent? }`, but the board passes it through as a variable, and TS
 * happily hands an object with EXTRA properties to a narrower parameter — so
 * dropping `parent` from the bridge's signature compiles clean and quietly
 * un-parents every child. The same is true of forgetting to wire
 * `onChildReport`: the driver's dep is optional, so an unwired board is a
 * legal, silent "child reporting is off".
 *
 * ⚠️ Red here means "re-wire the seam", never "relax the assertion". These are
 * deliberately loose (identifier presence inside the right function), so a
 * rename or a refactor that KEEPS the wiring will keep passing.
 */

const read = (...rel: string[]): string => readFileSync(join(__dirname, "..", ...rel), "utf8");
const view = read("src", "view.ts");
const main = read("src", "main.ts");
const board = read("src", "ui", "board-view.ts");

/** The body of `name`'s declaration in `src`, up to `chars` ahead — enough to
 *  contain the method without depending on brace matching. */
const near = (src: string, anchor: string, chars = 1200): string => {
  const at = src.indexOf(anchor);
  expect(at, `anchor moved or was renamed: ${anchor}`).toBeGreaterThan(-1);
  return src.slice(at, at + chars);
};

describe("fan-out wiring — spawn carries parentage", () => {
  it("the plugin bridge accepts a parent and does not silently drop it", () => {
    expect(main).toMatch(/startTaskConversation\([^)]*parent\?: string/s);
  });

  it("the view's spawn entry point accepts a parent", () => {
    expect(view).toMatch(/startTaskConversation\([^)]*parent\?: string/s);
  });

  it("the view stamps parentConvoId on the spawned child", () => {
    expect(near(view, "startTaskConversation(prompt: string")).toContain("parentConvoId = opts.parent");
  });

  it("the view takes the child back out of the tab strip", () => {
    // The exclusion decision itself is tested in working-set.test.ts; this only
    // pins that the view actually asks for it.
    expect(near(view, "startTaskConversation(prompt: string")).toContain("stripAfterChildSpawn");
  });
});

/**
 * The seam that closed the loop. `spawn_task` writes a `queued` block straight
 * into tasks.md; the running `OrchestratorDriver` loads the ledger ONCE in
 * `start()` and evolves an in-memory list from there. With no watcher, a board
 * that was ALREADY OPEN — the expected supervision posture — never saw the new
 * task: no card, no promotion, no spawn, no child, no report, while the tool had
 * already told the agent it would start and report back. Only closing and
 * reopening the board tab picked it up.
 *
 * board-view.ts imports `obsidian` and has zero unit tests, so the policy lives
 * in `core/ledger-watch.ts` (tested there) and this pins that the board actually
 * calls it.
 */
describe("fan-out wiring — the board sees tasks the tool writes", () => {
  it("registers a vault modify listener, so it is torn down with the view", () => {
    // registerEvent, not a bare vault.on: a leaked listener on a closed board
    // would keep calling into a disposed driver.
    expect(board).toMatch(/registerEvent\(\s*this\.app\.vault\.on\("modify"/);
  });

  it("scopes the listener to the ledger path, not to every note in the vault", () => {
    const handler = near(board, 'this.app.vault.on("modify"', 400);
    expect(handler).toContain("this.plugin.paths.tasks");
  });

  it("routes the event through the debounced watch, never straight to a reload", () => {
    const handler = near(board, 'this.app.vault.on("modify"', 400);
    expect(handler).toMatch(/ledgerWatch\??\.notify\(\)/);
  });

  it("also registers a vault create listener, so the ledger's first-ever write is seen", () => {
    // `createChildTask` takes the vault.create branch when tasks.md doesn't exist
    // yet — a modify-only listener never fires for a vault's first-ever task,
    // same symptom as the missed-spawn bug this watcher exists to fix, confined
    // to first use. registerEvent, not a bare vault.on, same as "modify".
    expect(board).toMatch(/registerEvent\(\s*this\.app\.vault\.on\("create"/);
  });

  it("scopes the create listener to the ledger path too", () => {
    const handler = near(board, 'this.app.vault.on("create"', 400);
    expect(handler).toContain("this.plugin.paths.tasks");
  });

  it("routes the create event through the same debounced watch as modify", () => {
    const handler = near(board, 'this.app.vault.on("create"', 400);
    expect(handler).toMatch(/ledgerWatch\??\.notify\(\)/);
  });

  it("reloads the driver's task list when the ledger really changed", () => {
    expect(board).toContain("ledgerChangedExternally");
    expect(near(board, "private async reloadIfLedgerChanged()", 700)).toContain("reloadTasks()");
  });

  it("wraps the driver's OWN store writes, so they don't bounce back as reloads", () => {
    // The driver persists every transition through the same file it now watches.
    // Unguarded, each write it makes would re-enter reloadTasks and restart the
    // driver — mid-spawn, repeatedly.
    const deps = near(board, "private buildDeps(): DriverDeps {");
    expect(deps).toContain("guardedStore");
    const guarded = near(board, "private guardedStore()", 700);
    for (const write of ["update", "move", "archive"]) {
      expect(guarded, `store.${write} is not guarded`).toContain(`guard(store.${write}`);
    }
  });

  it("disposes the watch when the board closes", () => {
    expect(near(board, "async onClose()", 500)).toContain("ledgerWatch");
  });
});

describe("fan-out wiring — reports reach the parent's next turn", () => {
  it("the board wires both report deps into the driver", () => {
    const deps = near(board, "private buildDeps(): DriverDeps {");
    expect(deps).toContain("onChildReport");
    expect(deps).toContain("lastAssistantText");
  });

  it("the plugin bridges both of them onto the view", () => {
    expect(main).toContain("deliverChildReport");
    expect(main).toContain("lastAssistantTextOf");
  });

  it("the view routes a report by parentConvoId, through the tested consumer", () => {
    // `queueReportForParent` is what makes the spawn-failure path work (its
    // childConvoId is ""); re-resolving the parent locally would reopen that.
    expect(near(view, "deliverChildReport(report: ChildReport)")).toContain("queueReportForParent");
  });

  it("a delivered report is scheduled for persistence, not left for the next unrelated save", () => {
    // PERSIST_DEBOUNCE_MS (1500) is shorter than REPORT_DEBOUNCE_MS (2000), so
    // the child's own turn-end save fires BEFORE the report exists — nothing
    // else schedules a write for it. Without an explicit persist() here, a
    // fan-out that finishes while the vault sits idle loses the queued report
    // (and the unread affordance) on the next restart, defeating the whole
    // point of persisting `pendingChildReports` across reload.
    expect(near(view, "deliverChildReport(report: ChildReport)")).toContain("this.persist()");
  });

  it("the turn drains queued reports into the outbound message", () => {
    expect(view).toContain("drainReportsForParent(c)");
    // Present in the join that builds `outbound`, or the drain would consume
    // the reports and throw them away.
    const join = near(view, "const outbound = [", 200);
    expect(join).toContain("childReports");
  });

  it("the excerpt comes from the tested segment reader, not an inlined .text read", () => {
    // An assistant Message has no `text` field (core/model.ts): reading one
    // gives every report an empty excerpt, and nothing downstream notices
    // because the report still arrives on time. Keep this in the pure module.
    expect(near(view, "lastAssistantTextOf(convoId: string)", 300)).toContain("lastAssistantText(c.messages)");
  });

  it("the sidebar surfaces a parent holding an undelivered report", () => {
    expect(near(view, "listChatRows(): ChatRowSource[] {")).toContain("pendingChildReports");
  });

  it("the sidebar reports parentage, or every row would render at top level", () => {
    expect(near(view, "listChatRows(): ChatRowSource[] {")).toContain("parentConvoId");
  });
});
