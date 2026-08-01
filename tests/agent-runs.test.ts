import { describe, it, expect } from "vitest";
import {
  agentLastRunKey,
  agentTriggerRunKey,
  dueScheduledAgentRuns,
  gateAgentRun,
  writeModeFor,
  agentRunName,
  buildAgentRunPrompt,
} from "../src/core/agent-runs";
import { mergeAgents, defaultContract, parseTrigger, type AgentBrain, type AgentContract } from "../src/core/agents";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

const brain = (slug: string, name = slug): AgentBrain => ({ slug, name, invocable: name, source: "vault" });

function agent(slug: string, over: Partial<AgentContract> = {}, triggers: string[] = []) {
  const contract: AgentContract = {
    ...defaultContract(slug),
    enabled: true,
    triggers: triggers.map((t) => parseTrigger(t)!),
    ...over,
  };
  return mergeAgents([brain(slug, slug.toUpperCase())], [contract])[0];
}

describe("run keys", () => {
  it("separates the cooldown cursor from the per-trigger slot cursor", () => {
    const t = parseTrigger("schedule daily 08")!;
    expect(agentLastRunKey("a")).toBe("agent:a");
    expect(agentTriggerRunKey("a", t)).toBe("agent:a::schedule daily 08");
  });
  it("gives an agent with two schedules two independent cursors", () => {
    const morning = parseTrigger("schedule daily 08")!;
    const evening = parseTrigger("schedule daily 20")!;
    expect(agentTriggerRunKey("a", morning)).not.toBe(agentTriggerRunKey("a", evening));
  });
});

describe("dueScheduledAgentRuns", () => {
  const daily = agent("librarian", {}, ["schedule daily 08"]);
  const now = at(2026, 8, 1, 9);

  it("returns an agent whose slot has come round", () => {
    const due = dueScheduledAgentRuns([daily], {}, now);
    expect(due).toHaveLength(1);
    expect(due[0].agent.brain.slug).toBe("librarian");
    expect(due[0].reason).toBe("daily 08:00");
  });

  it("does not re-fire inside the same slot", () => {
    const key = agentTriggerRunKey("librarian", daily.contract.triggers[0]);
    expect(dueScheduledAgentRuns([daily], { [key]: at(2026, 8, 1, 8, 30) }, now)).toEqual([]);
  });

  it("catches up exactly once after a long closure (never storms)", () => {
    const key = agentTriggerRunKey("librarian", daily.contract.triggers[0]);
    // Last run five days ago: five slots were missed, but only one run is due.
    const due = dueScheduledAgentRuns([daily], { [key]: at(2026, 7, 27, 8) }, now);
    expect(due).toHaveLength(1);
    // After stamping, the next poll in the same slot yields nothing.
    expect(dueScheduledAgentRuns([daily], { [key]: now }, now)).toEqual([]);
  });

  it("skips disabled agents and non-schedule triggers", () => {
    const off = agent("off", { enabled: false }, ["schedule daily 08"]);
    const evented = agent("evented", {}, ["vault-event create _inbox/**", "note-mention"]);
    expect(dueScheduledAgentRuns([off, evented], {}, now)).toEqual([]);
  });

  it("emits one entry per schedule trigger", () => {
    const twice = agent("twice", {}, ["schedule daily 08", "schedule hourly"]);
    expect(dueScheduledAgentRuns([twice], {}, now)).toHaveLength(2);
  });
});

describe("gateAgentRun", () => {
  const base = {
    lastRunAt: 0,
    now: at(2026, 8, 1, 9),
    running: 0,
    maxConcurrent: 2,
    inFlightKeys: new Set<string>(),
    runKey: "agent:a::schedule daily 08",
    budgetAvailable: true,
  };

  it("allows a clean run", () => {
    expect(gateAgentRun({ ...base, agent: agent("a") })).toEqual({ ok: true });
  });

  it("refuses a disabled agent", () => {
    const g = gateAgentRun({ ...base, agent: agent("a", { enabled: false }) });
    expect(g).toMatchObject({ ok: false, reason: "disabled" });
  });

  it("refuses a duplicate before anything else", () => {
    const g = gateAgentRun({
      ...base,
      agent: agent("a"),
      inFlightKeys: new Set([base.runKey]),
      running: 99,
    });
    expect(g).toMatchObject({ ok: false, reason: "duplicate" });
  });

  it("refuses when the concurrency cap is reached", () => {
    const g = gateAgentRun({ ...base, agent: agent("a"), running: 2 });
    expect(g).toMatchObject({ ok: false, reason: "concurrency" });
  });

  it("refuses when the background budget is exhausted", () => {
    const g = gateAgentRun({ ...base, agent: agent("a"), budgetAvailable: false });
    expect(g).toMatchObject({ ok: false, reason: "budget" });
  });

  it("refuses inside the cooldown window and allows once it lapses", () => {
    const a = agent("a", { cooldownMs: 30 * 60_000 });
    const justRan = base.now - 10 * 60_000;
    expect(gateAgentRun({ ...base, agent: a, lastRunAt: justRan })).toMatchObject({
      ok: false,
      reason: "cooldown",
    });
    expect(gateAgentRun({ ...base, agent: a, lastRunAt: base.now - 31 * 60_000 })).toEqual({ ok: true });
  });

  it("treats a never-run agent as out of cooldown", () => {
    expect(gateAgentRun({ ...base, agent: agent("a", { cooldownMs: 86_400_000 }), lastRunAt: 0 })).toEqual({
      ok: true,
    });
  });

  it("manual runs bypass cooldown and the disabled flag, but not budget or concurrency", () => {
    const a = agent("a", { enabled: false, cooldownMs: 86_400_000 });
    const lastRunAt = base.now - 1000;
    expect(gateAgentRun({ ...base, agent: a, lastRunAt, manual: true })).toEqual({ ok: true });
    expect(gateAgentRun({ ...base, agent: a, lastRunAt, manual: true, budgetAvailable: false })).toMatchObject({
      reason: "budget",
    });
    expect(gateAgentRun({ ...base, agent: a, lastRunAt, manual: true, running: 5 })).toMatchObject({
      reason: "concurrency",
    });
  });

  it("carries a human-readable detail on every refusal", () => {
    const g = gateAgentRun({ ...base, agent: agent("a", { cooldownMs: 60 * 60_000 }), lastRunAt: base.now });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.detail).toMatch(/cooling down/);
  });
});

describe("writeModeFor", () => {
  it("only `act` may write unattended", () => {
    expect(writeModeFor("act")).toBe(true);
    expect(writeModeFor("propose")).toBe(false);
    expect(writeModeFor("notify")).toBe(false);
  });
});

describe("buildAgentRunPrompt", () => {
  it("names the subagent and states the trigger", () => {
    const p = buildAgentRunPrompt(agent("librarian"), "daily 08:00");
    expect(p).toContain('trigger="daily 08:00"');
    // The invocable id (frontmatter name), never the slug — see agents.test.ts.
    expect(p).toContain('subagent_type: "LIBRARIAN"');
    expect(p).toContain("No human is watching");
  });

  it("permits an empty run instead of inventing work", () => {
    expect(buildAgentRunPrompt(agent("a"), "hourly")).toMatch(/empty run is a good outcome/);
  });

  it("act + write scope → the scope is stated and bounded", () => {
    const p = buildAgentRunPrompt(agent("a", { autonomy: "act", scope: { read: [], write: ["Posts/**"] } }), "hourly");
    expect(p).toContain("Write scope: Posts/**");
    expect(p).toContain("Never write outside it");
  });

  it("act without a write scope forbids writing outright", () => {
    const p = buildAgentRunPrompt(agent("a", { autonomy: "act" }), "hourly");
    expect(p).toContain("do not write anything");
  });

  it("propose and notify are read-only, and say so differently", () => {
    expect(buildAgentRunPrompt(agent("a", { autonomy: "propose" }), "hourly")).toMatch(/READ-ONLY.*would change/s);
    expect(buildAgentRunPrompt(agent("a", { autonomy: "notify" }), "hourly")).toMatch(/Report findings only/);
  });

  it("omits the read-scope line when none is declared", () => {
    expect(buildAgentRunPrompt(agent("a"), "hourly")).not.toContain("Read scope:");
  });
});

describe("agentRunName", () => {
  it("reads as one line in the automation run list", () => {
    expect(agentRunName(agent("librarian"), "daily 08:00")).toBe("LIBRARIAN (daily 08:00)");
  });
});
