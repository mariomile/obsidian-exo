import { describe, it, expect } from "vitest";
import { parseScheduledRuns, nextScheduled, autonomyStatuses, autonomyActions } from "../src/core/actions-hub";

const HOUR = 3_600_000;

describe("parseScheduledRuns", () => {
  it("parses valid lines and drops malformed ones", () => {
    const raw = "Morning brief | daily\nWeekly review|weekly\nno-cadence\nBad | monthly\n";
    expect(parseScheduledRuns(raw)).toEqual([
      { name: "Morning brief", cadence: "daily" },
      { name: "Weekly review", cadence: "weekly" },
    ]);
  });

  it("empty input → empty list", () => {
    expect(parseScheduledRuns("")).toEqual([]);
  });
});

describe("nextScheduled", () => {
  const now = 100 * HOUR;
  it("picks the soonest-due playbook", () => {
    const next = nextScheduled(
      [
        { name: "A", cadence: "daily" }, // last 90h ago → overdue
        { name: "B", cadence: "weekly" },
      ],
      { A: now - 90 * HOUR, B: now - HOUR },
      now
    );
    expect(next?.name).toBe("A");
    expect(next!.dueInMs).toBeLessThanOrEqual(0);
  });

  it("never-run playbooks are due immediately (last = 0)", () => {
    const next = nextScheduled([{ name: "A", cadence: "daily" }], {}, now);
    expect(next!.dueInMs).toBeLessThanOrEqual(0);
  });

  it("null when nothing is scheduled", () => {
    expect(nextScheduled([], {}, now)).toBeNull();
  });
});

describe("autonomyStatuses", () => {
  const base = {
    exoQueueEnabled: true,
    queuePending: 2 as number | null,
    scheduled: [{ name: "Brief", cadence: "daily" as const }],
    scheduledLastRun: { Brief: 0 },
    hasPlaybooks: true,
    now: 100 * HOUR,
  };

  it("reports pending count and next schedule", () => {
    const [queue, sched] = autonomyStatuses(base);
    expect(queue.value).toBe("on · 2 pending");
    expect(queue.enabled).toBe(true);
    expect(sched.value).toBe("1 active · Brief due now");
  });

  it("off queue and empty schedules", () => {
    const [queue, sched] = autonomyStatuses({ ...base, exoQueueEnabled: false, scheduled: [], queuePending: 0 });
    expect(queue.value).toBe("off");
    expect(sched.value).toBe("none");
    expect(sched.enabled).toBe(false);
  });

  it("unknown pending renders as plain on", () => {
    expect(autonomyStatuses({ ...base, queuePending: null })[0].value).toBe("on");
  });

  it("idle queue", () => {
    expect(autonomyStatuses({ ...base, queuePending: 0 })[0].value).toBe("on · idle");
  });
});

describe("autonomyActions", () => {
  const base = {
    exoQueueEnabled: true,
    queuePending: 3 as number | null,
    scheduled: [],
    scheduledLastRun: {},
    hasPlaybooks: true,
    now: 0,
  };

  it("drain carries the pending badge", () => {
    const drain = autonomyActions(base).find((a) => a.id === "queue-drain");
    expect(drain?.enabled).toBe(true);
    expect(drain?.badge).toBe("3 pending");
  });

  it("queue actions are inert when the queue is off", () => {
    const acts = autonomyActions({ ...base, exoQueueEnabled: false });
    expect(acts.find((a) => a.id === "queue-drain")?.enabled).toBe(false);
    expect(acts.find((a) => a.id === "queue-new")?.enabled).toBe(false);
  });

  it("run-playbook is hinted off without playbooks", () => {
    const run = autonomyActions({ ...base, hasPlaybooks: false }).find((a) => a.id === "run-playbook");
    expect(run?.enabled).toBe(false);
    expect(run?.hint).toBe("no playbooks yet");
  });
});
