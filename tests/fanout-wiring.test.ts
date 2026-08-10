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
