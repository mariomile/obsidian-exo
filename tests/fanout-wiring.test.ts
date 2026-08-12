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
const runtime = read("src", "obsidian", "orchestration.ts");
const wiring = read("src", "obsidian", "orchestration-wiring.ts");

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
 * `start()` and evolves an in-memory list from there. With no watcher, an
 * already-running driver never saw the new task: no card, no promotion, no
 * spawn, no child, no report, while the tool had already told the agent it
 * would start and report back.
 *
 * The listener moved with the driver — from `BoardView` to the plugin-owned
 * `OrchestrationRuntime` — when orchestration stopped depending on a tab being
 * open. `orchestration-wiring.ts` imports `obsidian` and has no unit tests, so
 * the policy lives in `core/ledger-watch.ts` (tested there) and this pins that
 * the wiring actually calls it.
 */
describe("fan-out wiring — the plugin sees tasks the tool writes", () => {
  it("watches the ledger for modify AND create", () => {
    // `createChildTask` takes the vault.create branch when tasks.md doesn't exist
    // yet — a modify-only listener never fires for a vault's first-ever task,
    // same symptom as the missed-spawn bug this watcher exists to fix.
    const watch = near(wiring, "watchLedger:", 700);
    expect(watch).toMatch(/vault\.on\("modify"/);
    expect(watch).toMatch(/vault\.on\("create"/);
  });

  it("scopes the listeners to the ledger path, not to every note in the vault", () => {
    expect(near(wiring, "watchLedger:", 700)).toContain("plugin.paths.tasks");
  });

  it("hands back an unsubscribe, so a hot-disable does not leak a vault listener", () => {
    // Not `registerEvent`: the runtime is started and stopped at runtime by the
    // orchestration flag, many times per plugin load. A plugin-lifetime
    // registration would leak one listener set per toggle.
    expect(near(wiring, "watchLedger:", 700)).toContain("vault.offref(ref)");
    expect(near(runtime, "stop(): void {", 500)).toContain("this.unwatchLedger?.()");
  });

  it("routes the event through the debounced watch, never straight to a reload", () => {
    expect(near(runtime, "this.unwatchLedger = this.deps.watchLedger(", 200)).toMatch(
      /ledgerWatch\??\.notify\(\)/
    );
  });

  it("reloads the driver's task list when the ledger really changed", () => {
    expect(runtime).toContain("ledgerChangedExternally");
    expect(near(runtime, "private async reloadIfLedgerChanged()", 700)).toContain("this.reload()");
  });

  it("wraps the driver's OWN store writes, so they don't bounce back as reloads", () => {
    // The driver persists every transition through the same file it now watches.
    // Unguarded, each write it makes would re-enter the reload and restart the
    // driver — mid-spawn, repeatedly.
    expect(near(runtime, "private buildDriverDeps(): DriverDeps {")).toContain("guardedStore");
    const guarded = near(runtime, "private guardedStore()", 700);
    for (const write of ["update", "move", "archive"]) {
      expect(guarded, `store.${write} is not guarded`).toContain(`guard(store.${write}`);
    }
  });

  it("disposes the watch when the runtime stops", () => {
    expect(near(runtime, "stop(): void {", 500)).toContain("ledgerWatch?.dispose()");
  });
});

/**
 * Ownership contract. The driver used to be built in `BoardView.onOpen` and
 * stopped in `onClose`, which made every delegation conditional on a tab being
 * open. These assertions are the only cheap way to keep it that way: board-view
 * imports `obsidian` and cannot be instantiated under vitest.
 */
describe("orchestration ownership — the plugin, not the board", () => {
  it("the plugin starts the runtime at layout-ready and stops it on unload", () => {
    expect(near(main, "this.app.workspace.onLayoutReady(() => {", 500)).toContain(
      "this.orchestration.sync()"
    );
    expect(near(main, "onunload(): void {", 300)).toContain("this.orchestration.stop()");
  });

  it("a settings toggle starts or stops it live, with no reload", () => {
    expect(near(main, "private applyOrchestrationToggle()", 600)).toContain(
      "this.orchestration.sync()"
    );
  });

  it("the board never constructs a driver or a ledger watch of its own", () => {
    expect(board).not.toContain("new OrchestratorDriver");
    expect(board).not.toContain("new LedgerWatch");
  });

  it("closing the board stops nothing", () => {
    const close = near(board, "async onClose()", 500);
    expect(close).not.toContain("driver");
    expect(close).not.toContain("orchestration.stop");
  });

  it("opening the board attaches to the running runtime instead of starting one", () => {
    const open = near(board, "async onOpen()", 1600);
    expect(open).toContain("orchestration.onTasks(");
    expect(open).toContain("orchestration.snapshot()");
  });
});

describe("fan-out wiring — reports reach the parent's next turn", () => {
  it("the runtime wires both report deps into the driver", () => {
    const deps = near(runtime, "private buildDriverDeps(): DriverDeps {");
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

describe("allConvos guards a null active", () => {
  it("does not append `active` when it is absent, so listChatRows can't map over undefined", () => {
    // view.ts cannot be instantiated outside Obsidian, so this pins the source
    // contract the same way the sibling assertions in this file do. The bug it
    // guards was live: the chats sidebar paints during early boot, when
    // `active` is genuinely absent, and `listChatRows` threw on `c.id`.
    const src = readFileSync(join(__dirname, "..", "src", "view.ts"), "utf8");
    const at = src.indexOf("allConvos(): Convo[] {");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 600);
    expect(body).toContain("if (!this.active) return this.convos;");
  });
});

describe("canHostConversation keeps its three states", () => {
  /**
   * This policy is the ONLY thing separating the plugin-level driver from a
   * regression worse than the bug it fixed: at boot with a RESTORED-BUT-DEFERRED
   * Exo leaf, `convoBridge.chatView()` returns null, so spawning would get "" back
   * and every queued task would burn into needs-input with a false "your delegated
   * task failed" report to its parent.
   *
   * A mutation review proved the gap this pins: hardwiring the function to `true`
   * left all 2213 tests green. `orchestration-wiring.ts` imports `obsidian`, so it
   * cannot be exercised under vitest — the same grep-pin the sibling assertions in
   * this file use is the available guard.
   */
  const src = () => readFileSync(join(__dirname, "..", "src", "obsidian", "orchestration-wiring.ts"), "utf8");

  const body = (): string => {
    const text = src();
    const at = text.indexOf("function canHostConversation");
    expect(at).toBeGreaterThan(-1);
    return text.slice(at, text.indexOf("\n}", at));
  };

  it("refuses to spawn before the layout is ready", () => {
    expect(body()).toContain("layoutReady");
  });

  it("treats a resolvable ChatView as a host", () => {
    expect(body()).toContain("convoBridge.chatView");
  });

  it("treats ZERO leaves as hostable, since startTaskConversation creates one", () => {
    // The deferred case is what falls through to false: a leaf EXISTS but does
    // not resolve. That distinction is the whole policy.
    expect(body()).toContain("getLeavesOfType(VIEW_TYPE).length === 0");
  });

  it("is wired into the driver as canSpawn", () => {
    expect(src()).toContain("canSpawn: () => canHostConversation(plugin)");
  });
});

/**
 * Fan-out is the ONLY substitute Codex has for a subagent: it has no primitive
 * tied to `.claude/agents/*.md`, so parallel work has to become parallel
 * conversations, each with its own session. That already works, because
 * `askInNewConversation` reads `settings.provider` rather than assuming Claude.
 *
 * But it works through a completely separate call site. Claude receives the
 * Obsidian tools as an in-process MCP server; Codex receives the same registry
 * through its loopback bridge, built from its own options object. Nothing makes
 * the two lists agree — `spawn_task` gates on `orchestrationEnabled` AND on a
 * `parentConvoId` being present, and either one missing from the bridge's
 * options is a legal, silent "fan-out is Claude-only".
 */
describe("fan-out wiring — Codex reaches the same spawn path", () => {
  const bridge = near(view, "c.provider === \"codex\" &&", 1600);

  it("gives the Codex bridge the orchestration tools", () => {
    expect(bridge).toContain("orchestrationEnabled");
  });

  it("gives the Codex bridge a parent, without which spawn_task is withheld", () => {
    expect(bridge).toContain("parentConvoId: c.id");
  });

  it("spawns the child on the session provider rather than assuming Claude", () => {
    expect(near(view, "askInNewConversation(")).toContain("this.plugin.settings.provider");
  });
});
