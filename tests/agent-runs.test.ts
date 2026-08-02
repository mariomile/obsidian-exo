import { describe, it, expect } from "vitest";
import {
  agentLastRunKey,
  agentTriggerRunKey,
  dueScheduledAgentRuns,
  gateAgentRun,
  gateAgentInvoke,
  MAX_AGENT_DEPTH,
  AGENT_PROPOSAL_FENCE,
  extractProposalBlock,
  writeModeFor,
  agentRunName,
  buildAgentRunPrompt,
} from "../src/core/agent-runs";
import { mergeAgents, defaultContract, parseTrigger, type AgentBrain, type AgentContract } from "../src/core/agents";
import { parseProposalCandidates } from "../src/core/proposals";

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

describe("gateAgentRun — device capability", () => {
  const base = {
    lastRunAt: 0,
    now: at(2026, 8, 1, 9),
    running: 0,
    maxConcurrent: 2,
    inFlightKeys: new Set<string>(),
    runKey: "k",
    budgetAvailable: true,
  };

  it("refuses when the device cannot spawn the CLI", () => {
    expect(gateAgentRun({ ...base, agent: agent("a"), canSpawn: false })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });

  it("checks it first — a manual run on a phone still cannot happen", () => {
    const g = gateAgentRun({ ...base, agent: agent("a", { enabled: false }), canSpawn: false, manual: true });
    expect(g).toMatchObject({ reason: "unavailable" });
  });

  it("defaults to allowed, so existing callers are unaffected", () => {
    expect(gateAgentRun({ ...base, agent: agent("a") })).toEqual({ ok: true });
    expect(gateAgentRun({ ...base, agent: agent("a"), canSpawn: true })).toEqual({ ok: true });
  });
});

describe("extractProposalBlock", () => {
  const block = (body: string) => "```" + AGENT_PROPOSAL_FENCE + "\n" + body + "\n```";

  it("pulls the payload out of a prose report", () => {
    const out = `Found two things.\n\n${block('[{"kind":"task"}]')}\n\nDone.`;
    expect(extractProposalBlock(out)).toBe('[{"kind":"task"}]');
  });

  it("returns null when there is no block — the normal empty run", () => {
    expect(extractProposalBlock("Nothing needed doing.")).toBeNull();
    expect(extractProposalBlock("")).toBeNull();
  });

  it("takes the LAST block, so quoting the instruction first does not win", () => {
    const out = `${block('["example"]')}\n\nand my real answer:\n\n${block('["real"]')}`;
    expect(extractProposalBlock(out)).toBe('["real"]');
  });

  it("ignores ordinary json fences", () => {
    expect(extractProposalBlock('```json\n[{"kind":"task"}]\n```')).toBeNull();
  });

  it("treats an empty block as no proposals", () => {
    expect(extractProposalBlock(block(""))).toBeNull();
  });

  // The kernel's schema is FLAT — it reads the fields off each entry and builds
  // the payload itself. Teaching a nested `payload` in the prompt would make
  // every proposal an agent emits get rejected, silently.
  it("round-trips one entry of every kind into the kernel's own parser", () => {
    const candidates = [
      { kind: "task", title: "Draft the post", prompt: "write it", rationale: "the draft is stale" },
      { kind: "loop", title: "Chase the reply", note: "no answer yet", rationale: "it has been a week" },
      { kind: "decision", title: "Pick a tier", context: "two options", decision: "went with propose", rationale: "safer" },
    ];
    for (const c of candidates) {
      const raw = extractProposalBlock(`Report.\n\n${block(JSON.stringify([c]))}`);
      expect(raw).not.toBeNull();
      expect(parseProposalCandidates(raw!).status, `kind ${c.kind}`).toBe("ok");
    }
  });

  it("the example in the prompt is itself valid input", () => {
    const example = buildAgentRunPrompt(agent("a", { autonomy: "propose" }), "x")
      .split("\n")
      .find((l) => l.trim().startsWith('[{"kind"'));
    expect(example).toBeDefined();
    // The example uses "…" placeholders, so only its SHAPE can be checked:
    // flat keys, no nested payload.
    const parsed = JSON.parse(example!.trim()) as Record<string, unknown>[];
    expect(parsed[0]).toHaveProperty("prompt");
    expect(parsed[0]).toHaveProperty("rationale");
    expect(parsed[0]).not.toHaveProperty("payload");
  });
});

describe("buildAgentRunPrompt — the proposal channel", () => {
  it("is offered to `propose` only", () => {
    expect(buildAgentRunPrompt(agent("a", { autonomy: "propose" }), "x")).toContain(AGENT_PROPOSAL_FENCE);
    // `notify` has nothing to propose; `act` already writes, so proposing too
    // would let one change arrive twice.
    expect(buildAgentRunPrompt(agent("a", { autonomy: "notify" }), "x")).not.toContain(AGENT_PROPOSAL_FENCE);
    expect(buildAgentRunPrompt(agent("a", { autonomy: "act" }), "x")).not.toContain(AGENT_PROPOSAL_FENCE);
  });

  it("names the kernel's existing kinds and says proposals are inert", () => {
    const p = buildAgentRunPrompt(agent("a", { autonomy: "propose" }), "x");
    for (const kind of ["task", "loop", "decision", "playbook"]) expect(p).toContain(`\`${kind}\``);
    expect(p).toContain("INERT until a human accepts");
  });
});

describe("gateAgentInvoke", () => {
  const strategy = agent("strategy", { canCall: ["research"] });
  const research = agent("research");
  const crm = agent("crm");

  it("a human (exo) may invoke any agent, allowlist or not", () => {
    expect(gateAgentInvoke("exo", research, null, 0)).toEqual({ ok: true });
    expect(gateAgentInvoke("exo", crm, null, 0)).toEqual({ ok: true });
  });

  it("an agent may invoke only what its can_call lists", () => {
    expect(gateAgentInvoke("strategy", research, strategy, 0)).toEqual({ ok: true });
    expect(gateAgentInvoke("strategy", crm, strategy, 0)).toMatchObject({ ok: false, reason: "not-allowed" });
  });

  it("deny-by-default: an empty can_call delegates to nobody", () => {
    expect(gateAgentInvoke("research", crm, research, 0)).toMatchObject({ ok: false, reason: "not-allowed" });
  });

  it("refuses self-invocation", () => {
    expect(gateAgentInvoke("research", research, research, 0)).toMatchObject({ ok: false, reason: "self" });
  });

  it("refuses an unknown target or an unknown caller", () => {
    expect(gateAgentInvoke("exo", null, null, 0)).toMatchObject({ ok: false, reason: "unknown" });
    expect(gateAgentInvoke("ghost", research, null, 0)).toMatchObject({ ok: false, reason: "unknown" });
  });

  it("caps the delegation depth", () => {
    expect(gateAgentInvoke("strategy", research, strategy, 1)).toEqual({ ok: true });
    expect(gateAgentInvoke("strategy", research, strategy, MAX_AGENT_DEPTH)).toMatchObject({
      ok: false,
      reason: "depth",
    });
  });

  it("depth is checked before the allowlist, so a runaway chain stops regardless of config", () => {
    expect(gateAgentInvoke("strategy", crm, strategy, MAX_AGENT_DEPTH)).toMatchObject({ reason: "depth" });
  });

  it("an agent cannot wake a disabled agent, but a human can", () => {
    const off = agent("off", { enabled: false });
    const caller = agent("caller", { canCall: ["off"] });
    expect(gateAgentInvoke("caller", off, caller, 0)).toMatchObject({ ok: false, reason: "disabled" });
    expect(gateAgentInvoke("exo", off, null, 0)).toEqual({ ok: true });
  });
});

describe("gateAgentRun — nested runs", () => {
  const base = {
    lastRunAt: 0,
    now: at(2026, 8, 1, 9),
    running: 1,
    maxConcurrent: 1,
    inFlightKeys: new Set<string>(),
    runKey: "k",
    budgetAvailable: true,
  };

  it("a nested run is exempt from the concurrency cap (its caller is blocked)", () => {
    expect(gateAgentRun({ ...base, agent: agent("a"), nested: true })).toEqual({ ok: true });
    expect(gateAgentRun({ ...base, agent: agent("a") })).toMatchObject({ reason: "concurrency" });
  });

  it("but is still bound by budget and dedupe", () => {
    expect(gateAgentRun({ ...base, agent: agent("a"), nested: true, budgetAvailable: false })).toMatchObject({
      reason: "budget",
    });
    expect(
      gateAgentRun({ ...base, agent: agent("a"), nested: true, inFlightKeys: new Set(["k"]) })
    ).toMatchObject({ reason: "duplicate" });
  });
});

describe("buildAgentRunPrompt — delegated runs", () => {
  it("states the caller and the specific task, replacing the standing job", () => {
    const p = buildAgentRunPrompt(agent("research"), "invoked by strategy", undefined, {
      from: "strategy",
      text: "  find prior art on agent marketplaces  ",
    });
    expect(p).toContain("delegated by strategy");
    expect(p).toContain("Task from strategy: find prior art on agent marketplaces");
    expect(p).toContain("not this agent's standing job");
    expect(p).not.toContain("Standing task:");
  });

  it("keeps the standing-job wording when there is no delegated task", () => {
    const p = buildAgentRunPrompt(agent("research"), "daily 08:00");
    expect(p).toContain("Standing task:");
    expect(p).not.toContain("Task from");
  });
});

describe("buildAgentRunPrompt — memory", () => {
  it("injects prior learnings and points at the memory file", () => {
    const p = buildAgentRunPrompt(agent("a"), "hourly", {
      path: "_system/memory/agents/a.md",
      excerpt: "- prefers short posts",
    });
    expect(p).toContain("What you learned in earlier runs");
    expect(p).toContain("prefers short posts");
    expect(p).toContain("_system/memory/agents/a.md");
  });

  it("says nothing about memory when there is none", () => {
    expect(buildAgentRunPrompt(agent("a"), "hourly")).not.toContain("earlier runs");
  });

  it("still points at the file when memory is empty, so the first learning has a home", () => {
    const p = buildAgentRunPrompt(agent("a"), "hourly", { path: "m.md", excerpt: "" });
    expect(p).not.toContain("What you learned in earlier runs");
    expect(p).toContain("append ONE line to `m.md`");
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
