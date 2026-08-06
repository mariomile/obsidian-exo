import { describe, it, expect } from "vitest";
import { summarizeLiveTasks, isSettled, type LiveTask, type LiveTaskKind } from "../src/core/live-tasks";
import { planLiveTaskSweep } from "../src/core/live-task-lifecycle";
import { LiveTaskRegistry } from "../src/ui/live-task-registry";
import type { AssistantCtx, Convo, LiveTaskRecord } from "../src/ui/convo-types";

/**
 * The `detached` state exists because Exo cannot poll background work.
 *
 * A `Bash run_in_background` or a Workflow genuinely may outlive the turn that
 * started it, but once that turn's stream closes nothing will ever report back.
 * Claiming "running" is a lie Exo can't back up — the turn-end footer two lines
 * away already admits as much. `detached` says only what is true: this was
 * started, and its outcome is unknown.
 */

const t = (id: string, kind: LiveTaskKind, status: LiveTask["status"], over: Partial<LiveTask> = {}): LiveTask =>
  ({ id, kind, label: id, status, startedAt: 0, ...over });

describe("isSettled — detached is not an outcome", () => {
  it("only done/error/stopped are settled", () => {
    expect(isSettled("done")).toBe(true);
    expect(isSettled("error")).toBe(true);
    expect(isSettled("stopped")).toBe(true);
  });

  it("running and detached are not settled — neither has an outcome yet", () => {
    expect(isSettled("running")).toBe(false);
    expect(isSettled("detached")).toBe(false);
  });
});

describe("summarizeLiveTasks — the chip stops claiming what it cannot know", () => {
  it("detached alone does not spin", () => {
    const s = summarizeLiveTasks([t("a", "bash", "detached")]);
    expect(s.spinner).toBe(false);
  });

  it("one detached task reads as a background task, not a running agent", () => {
    expect(summarizeLiveTasks([t("a", "bash", "detached")]).chipLabel).toBe("1 background task");
  });

  it("several detached tasks pluralise", () => {
    const s = summarizeLiveTasks([t("a", "bash", "detached"), t("b", "workflow", "detached")]);
    expect(s.chipLabel).toBe("2 background tasks");
  });

  it("running still wins the spinner when both are present", () => {
    const s = summarizeLiveTasks([t("a", "subagent", "running"), t("b", "bash", "detached")]);
    expect(s.spinner).toBe(true);
    expect(s.chipLabel).toBe("1 running · 1 background");
  });

  it("detached is reported alongside finished work", () => {
    const s = summarizeLiveTasks([t("a", "bash", "detached"), t("b", "subagent", "done")]);
    expect(s.spinner).toBe(false);
    expect(s.chipLabel).toBe("1 background · 1 done");
  });

  it("the all-running phrasing is unchanged", () => {
    expect(summarizeLiveTasks([t("a", "subagent", "running")]).chipLabel).toBe("1 agent running");
  });
});

describe("planLiveTaskSweep — detached clears at the next turn, never fades", () => {
  it("a detached row is swept, however recent", () => {
    // reconcile runs only at turn start, so this IS "cleared when you send the
    // next message" — by then the row is stale information either way.
    expect(planLiveTaskSweep([t("b", "bash", "detached")], new Set(), 0, 2000)).toEqual(["b"]);
  });

  it("a running row is still never swept by age", () => {
    expect(planLiveTaskSweep([t("b", "bash", "running")], new Set(), 999_999, 2000)).toEqual([]);
  });

  it("settled rows still fade on their own clock", () => {
    expect(planLiveTaskSweep([t("a", "subagent", "done", { doneAt: 0 })], new Set(), 1000, 2000)).toEqual([]);
    expect(planLiveTaskSweep([t("a", "subagent", "done", { doneAt: 0 })], new Set(), 3000, 2000)).toEqual(["a"]);
  });

  it("reports a detached, orphaned row exactly once", () => {
    expect(planLiveTaskSweep([t("b", "bash", "detached")], new Set(["b"]), 0, 2000)).toEqual(["b"]);
  });
});

describe("LiveTaskRegistry — detached is not stamped and schedules no eviction", () => {
  const card = (id: string) => ({ id }) as unknown as HTMLElement;
  const convo = (): Convo => ({ liveTasks: new Map(), listEl: card("l") }) as unknown as Convo;
  const ctxFor = (c: Convo): AssistantCtx =>
    ({ convo: c, liveTaskIds: new Set<string>() }) as unknown as AssistantCtx;
  const rec = (id: string, kind: LiveTaskKind): LiveTaskRecord =>
    ({ id, kind, label: id, status: "running", startedAt: 0, cardEl: card(id) });

  it("detaching does not stamp doneAt — there is no outcome to timestamp", () => {
    const timers: (() => void)[] = [];
    const reg = new LiveTaskRegistry(
      () => {},
      (fn) => void timers.push(fn),
    );
    const c = convo();
    const ctx = ctxFor(c);
    reg.register(ctx, rec("b", "bash"));
    reg.settleTurn(ctx, "completed");

    expect(c.liveTasks.get("b")?.status).toBe("detached");
    expect(c.liveTasks.get("b")?.doneAt).toBeUndefined();
    expect(timers).toHaveLength(0); // nothing scheduled: it must not vanish on a timer
  });
});
