import { describe, it, expect } from "vitest";
import { LiveTaskRegistry, LIVE_FADE_MS } from "../src/ui/live-task-registry";
import type { AssistantCtx, Convo, LiveTaskRecord } from "../src/ui/convo-types";
import type { LiveTaskKind, LiveTaskStatus } from "../src/core/live-tasks";

/**
 * The registry holds `cardEl` references but never touches the DOM, so a bare
 * object stands in for a card. That is the whole reason it was pulled out of
 * `view.ts`: this behaviour used to be reachable only through a 7k-line
 * ItemView that needs an App, a Workspace, a Vault and ~400 Obsidian DOM
 * monkey-patches to instantiate.
 */
const card = (id: string) => ({ id }) as unknown as HTMLElement;

const convo = (): Convo => ({ liveTasks: new Map(), listEl: card("list") }) as unknown as Convo;

const ctxFor = (c: Convo): AssistantCtx =>
  ({ convo: c, liveTaskIds: new Set<string>() }) as unknown as AssistantCtx;

const rec = (
  id: string,
  kind: LiveTaskKind = "subagent",
  status: LiveTaskStatus = "running",
): LiveTaskRecord => ({ id, kind, label: id, status, startedAt: 0, cardEl: card(id) });

/** Collects scheduled callbacks so a test can fire them deliberately. */
function harness() {
  let changes = 0;
  const timers: { fn: () => void; ms: number }[] = [];
  const reg = new LiveTaskRegistry(
    () => {
      changes++;
    },
    (fn, ms) => void timers.push({ fn, ms }),
  );
  return { reg, timers, changes: () => changes };
}

describe("LiveTaskRegistry — stamping and eviction", () => {
  it("a running task is stored with no doneAt and schedules nothing", () => {
    const { reg, timers } = harness();
    const c = convo();
    reg.upsert(c, rec("a"));
    expect(c.liveTasks.get("a")?.doneAt).toBeUndefined();
    expect(timers).toHaveLength(0);
  });

  it("a terminal task is stamped and its eviction scheduled at the fade window", () => {
    const { reg, timers } = harness();
    const c = convo();
    reg.upsert(c, rec("a", "workflow", "done"));
    expect(c.liveTasks.get("a")?.doneAt).toBeTypeOf("number");
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(LIVE_FADE_MS);
  });

  it("the scheduled eviction actually removes the row", () => {
    const { reg, timers } = harness();
    const c = convo();
    reg.upsert(c, rec("a", "bash", "error"));
    timers[0].fn();
    expect(c.liveTasks.has("a")).toBe(false);
  });

  it("every kind gets eviction, not just the ones that go through setStatus", () => {
    // The original bug: workflow progress went through upsert directly and so
    // never got the doneAt stamp that only the sibling function applied.
    for (const kind of ["subagent", "bash", "workflow"] as LiveTaskKind[]) {
      const { reg, timers } = harness();
      const c = convo();
      reg.upsert(c, rec("x", kind, "done"));
      expect(timers, kind).toHaveLength(1);
    }
  });

  it("repaints on insert and on removal", () => {
    const h = harness();
    const c = convo();
    h.reg.upsert(c, rec("a"));
    expect(h.changes()).toBe(1);
    h.reg.remove(c, "a");
    expect(h.changes()).toBe(2);
  });

  it("removing an absent id repaints nothing", () => {
    const h = harness();
    h.reg.remove(convo(), "nope");
    expect(h.changes()).toBe(0);
  });
});

describe("LiveTaskRegistry — registration ledger", () => {
  it("register records the id on the turn so it can be settled later", () => {
    const { reg } = harness();
    const c = convo();
    const ctx = ctxFor(c);
    reg.register(ctx, rec("a", "bash"));
    expect([...ctx.liveTaskIds]).toEqual(["a"]);
    expect(c.liveTasks.has("a")).toBe(true);
  });

  it("setStatus keeps the label and card while moving the status", () => {
    const { reg } = harness();
    const c = convo();
    const original = rec("a");
    original.label = "deep research";
    reg.upsert(c, original);
    reg.setStatus(c, "a", "done");
    const after = c.liveTasks.get("a");
    expect(after?.label).toBe("deep research");
    expect(after?.cardEl).toBe(original.cardEl);
    expect(after?.status).toBe("done");
  });

  it("setStatus on an unknown id is a no-op", () => {
    const h = harness();
    h.reg.setStatus(convo(), "ghost", "done");
    expect(h.changes()).toBe(0);
  });
});

describe("LiveTaskRegistry — settling a turn", () => {
  it("Stop settles the background work the turn started, not just its subagents", () => {
    // The reported bug: Stop left Bash and Workflow rows spinning forever.
    const { reg } = harness();
    const c = convo();
    const ctx = ctxFor(c);
    reg.register(ctx, rec("sub", "subagent"));
    reg.register(ctx, rec("sh", "bash"));
    reg.register(ctx, rec("wf", "workflow"));

    reg.settleTurn(ctx, "interrupted");

    expect([...c.liveTasks.values()].map((t) => t.status)).toEqual(["stopped", "stopped", "stopped"]);
  });

  it("a clean finish settles orphaned subagents but only detaches background work", () => {
    const { reg } = harness();
    const c = convo();
    const ctx = ctxFor(c);
    reg.register(ctx, rec("sub", "subagent"));
    reg.register(ctx, rec("sh", "bash"));

    reg.settleTurn(ctx, "completed");

    expect(c.liveTasks.get("sub")?.status).toBe("error");
    expect(c.liveTasks.get("sh")?.status).toBe("detached");
  });

  it("never settles work another turn registered — that is keep-alive L1", () => {
    const { reg } = harness();
    const c = convo();
    const earlier = ctxFor(c);
    reg.register(earlier, rec("old", "bash"));
    const current = ctxFor(c);
    reg.register(current, rec("mine", "subagent"));

    reg.settleTurn(current, "interrupted");

    expect(c.liveTasks.get("old")?.status).toBe("running");
    expect(c.liveTasks.get("mine")?.status).toBe("stopped");
  });
});

describe("LiveTaskRegistry — reconcile", () => {
  it("drops rows the caller reports as orphaned", () => {
    const { reg } = harness();
    const c = convo();
    reg.upsert(c, rec("gone"));
    reg.upsert(c, rec("here"));
    reg.reconcile(c, (r) => r.id === "gone");
    expect([...c.liveTasks.keys()]).toEqual(["here"]);
  });

  it("keeps a running row of a chat the user is not looking at", () => {
    // The isConnected bug: a background tab's cards are all detached, so the
    // sweep used to wipe exactly the work keep-alive exists to protect. With
    // orphan-ness asked of the conversation instead, nothing is dropped.
    const { reg } = harness();
    const c = convo();
    reg.upsert(c, rec("bg", "workflow"));
    reg.reconcile(c, () => false);
    expect(c.liveTasks.has("bg")).toBe(true);
  });

  it("repaints only when something was actually dropped", () => {
    const h = harness();
    const c = convo();
    h.reg.upsert(c, rec("a"));
    const before = h.changes();
    h.reg.reconcile(c, () => false);
    expect(h.changes()).toBe(before);
  });
});
