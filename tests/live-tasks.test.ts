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
