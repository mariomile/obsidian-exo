import { describe, it, expect } from "vitest";
import { autonomyStatuses, autonomyActions } from "../src/core/actions-hub";
import type { AutomationConfig } from "../src/core/automations";

/** Local-time epoch helper (mirrors automations.test.ts fixtures). */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

const brief: AutomationConfig = { name: "Brief", cadence: { kind: "daily", hour: 7 }, enabled: true, write: false };

describe("autonomyStatuses", () => {
  const base = {
    exoQueueEnabled: true,
    queuePending: 2 as number | null,
    automations: [brief],
    scheduledLastRun: { Brief: 0 },
    hasPlaybooks: true,
    now: at(2026, 7, 15, 10),
  };

  it("reports pending count and next automation", () => {
    const [queue, sched] = autonomyStatuses(base);
    expect(queue.value).toBe("on · 2 pending");
    expect(queue.enabled).toBe(true);
    expect(sched.value).toBe("1 active · Brief due now"); // never ran → due
  });

  it("ran in today's slot → shows time until tomorrow's slot", () => {
    const [, sched] = autonomyStatuses({ ...base, scheduledLastRun: { Brief: at(2026, 7, 15, 7, 5) } });
    expect(sched.value).toBe("1 active · Brief in 21h");
  });

  it("off queue and no automations", () => {
    const [queue, sched] = autonomyStatuses({ ...base, exoQueueEnabled: false, automations: [], queuePending: 0 });
    expect(queue.value).toBe("off");
    expect(sched.value).toBe("none");
    expect(sched.enabled).toBe(false);
  });

  it("all automations paused → 'all paused', disabled", () => {
    const [, sched] = autonomyStatuses({ ...base, automations: [{ ...brief, enabled: false }] });
    expect(sched.value).toBe("all paused");
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
    automations: [] as AutomationConfig[],
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

  it("automations manager action is always available", () => {
    expect(autonomyActions(base).find((a) => a.id === "automations")?.enabled).toBe(true);
  });
});
