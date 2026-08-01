import { describe, it, expect, beforeEach } from "vitest";
import { AgentTriggerDriver, type TriggerDriverDeps } from "../src/obsidian/agent-triggers";
import type { DueAgentRun } from "../src/core/agent-runs";
import { mergeAgents, defaultContract, parseTrigger, type AgentBrain, type AgentContract } from "../src/core/agents";

const brain = (slug: string, name = slug): AgentBrain => ({ slug, name, invocable: name, source: "vault" });

function agent(slug: string, triggers: string[], over: Partial<AgentContract> = {}) {
  const contract: AgentContract = {
    ...defaultContract(slug),
    enabled: true,
    triggers: triggers.map((t) => parseTrigger(t)!),
    ...over,
  };
  return mergeAgents([brain(slug)], [contract])[0];
}

/** Deterministic timer queue — no real time, no vitest fake-timer globals. */
function fakeClock() {
  let next = 1;
  const jobs = new Map<number, () => void>();
  return {
    schedule: (fn: () => void, _ms: number) => {
      const id = next++;
      jobs.set(id, fn);
      return id;
    },
    cancel: (id: number) => void jobs.delete(id),
    /** Run every queued job (they may queue more; those wait for the next tick). */
    tick: () => {
      const now = [...jobs.entries()];
      jobs.clear();
      for (const [, fn] of now) fn();
    },
    pendingCount: () => jobs.size,
  };
}

function makeDriver(over: Partial<TriggerDriverDeps> = {}, notes: Record<string, { tags: string[]; body: string }> = {}) {
  const clock = fakeClock();
  const dispatched: DueAgentRun[] = [];
  const deps: TriggerDriverDeps = {
    agents: () => [agent("triager", ["vault-event create _inbox/**"])],
    memoryRoot: () => "_system",
    readNote: async (p) => notes[p] ?? { tags: [], body: "" },
    dispatch: (r) => void dispatched.push(r),
    schedule: clock.schedule,
    cancel: clock.cancel,
    ...over,
  };
  const driver = new AgentTriggerDriver(deps);
  return { driver, clock, dispatched, notes };
}

/** flush() is async; let its microtasks settle after ticking the clock. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("AgentTriggerDriver — arming", () => {
  it("ignores everything until armed (Obsidian replays create for the whole vault at boot)", async () => {
    const { driver, clock, dispatched } = makeDriver();
    driver.notify("_inbox/a.md", "create");
    driver.notify("_inbox/b.md", "create");
    expect(clock.pendingCount()).toBe(0);
    clock.tick();
    await settle();
    expect(dispatched).toEqual([]);
  });

  it("reacts once armed", async () => {
    const { driver, clock, dispatched } = makeDriver();
    driver.arm();
    expect(driver.isArmed()).toBe(true);
    driver.notify("_inbox/a.md", "create");
    clock.tick();
    await settle();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].agent.brain.slug).toBe("triager");
  });
});

describe("AgentTriggerDriver — filtering", () => {
  let d: ReturnType<typeof makeDriver>;
  beforeEach(() => {
    d = makeDriver();
    d.driver.arm();
  });

  it("drops excluded paths before scheduling any work", () => {
    d.driver.notify("_system/reports/run.md", "create");
    d.driver.notify(".obsidian/x.md", "create");
    d.driver.notify("Active/image.png", "create");
    expect(d.clock.pendingCount()).toBe(0);
  });

  it("does nothing when no enabled agent has an event trigger", () => {
    const only = makeDriver({ agents: () => [agent("s", ["schedule daily 08"])] });
    only.driver.arm();
    only.driver.notify("_inbox/a.md", "create");
    expect(only.clock.pendingCount()).toBe(0);
  });
});

describe("AgentTriggerDriver — debounce and coalescing", () => {
  it("coalesces a burst on one path into a single flush", async () => {
    const { driver, clock, dispatched } = makeDriver();
    driver.arm();
    for (let i = 0; i < 20; i++) driver.notify("_inbox/a.md", "modify");
    expect(clock.pendingCount()).toBe(1);
    clock.tick();
    await settle();
    // 20 events, at most one run — and this agent only listens for `create`.
    expect(dispatched).toEqual([]);
  });

  it("keeps `create` when Obsidian follows it with `modify` for the same new file", async () => {
    const { driver, clock, dispatched } = makeDriver();
    driver.arm();
    driver.notify("_inbox/a.md", "create");
    driver.notify("_inbox/a.md", "modify");
    clock.tick();
    await settle();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].reason).toBe("create _inbox/a.md");
  });

  it("keeps separate paths separate", async () => {
    const { driver, clock, dispatched } = makeDriver();
    driver.arm();
    driver.notify("_inbox/a.md", "create");
    driver.notify("_inbox/b.md", "create");
    expect(clock.pendingCount()).toBe(2);
    clock.tick();
    await settle();
    expect(dispatched.map((r) => r.reason).sort()).toEqual(["create _inbox/a.md", "create _inbox/b.md"]);
  });
});

describe("AgentTriggerDriver — tag transitions", () => {
  const poster = () => [agent("poster", ["tag #needs/post"])];

  it("fires when a tag appears, and not on the next edit", async () => {
    const notes: Record<string, { tags: string[]; body: string }> = {
      "n.md": { tags: [], body: "" },
    };
    const { driver, clock, dispatched } = makeDriver({ agents: poster, readNote: async (p) => notes[p] ?? null }, notes);
    driver.arm();

    // First sight with no tag — establishes the baseline, fires nothing.
    driver.notify("n.md", "modify");
    clock.tick();
    await settle();
    expect(dispatched).toEqual([]);

    // Tag added → fires once.
    notes["n.md"] = { tags: ["#needs/post"], body: "" };
    driver.notify("n.md", "modify");
    clock.tick();
    await settle();
    expect(dispatched).toHaveLength(1);

    // Further edits with the tag still present → silent.
    driver.notify("n.md", "modify");
    clock.tick();
    await settle();
    expect(dispatched).toHaveLength(1);
  });

  it("seedTags establishes a baseline so a pre-existing tag never reads as added", async () => {
    const notes = { "n.md": { tags: ["#needs/post"], body: "" } };
    const { driver, clock, dispatched } = makeDriver({ agents: poster, readNote: async (p) => notes[p as "n.md"] }, notes);
    driver.arm();
    driver.seedTags("n.md", ["#needs/post"]);
    driver.notify("n.md", "modify");
    clock.tick();
    await settle();
    expect(dispatched).toEqual([]);
  });

  it("forgets the baseline when a note becomes unreadable, so a re-creation counts again", async () => {
    const notes: Record<string, { tags: string[]; body: string } | null> = {
      "n.md": { tags: ["#needs/post"], body: "" },
    };
    const { driver, clock, dispatched } = makeDriver({
      agents: poster,
      readNote: async (p) => notes[p] ?? null,
    });
    driver.arm();
    driver.seedTags("n.md", ["#needs/post"]);

    notes["n.md"] = null; // deleted
    driver.notify("n.md", "modify");
    clock.tick();
    await settle();
    expect(dispatched).toEqual([]);

    notes["n.md"] = { tags: ["#needs/post"], body: "" }; // recreated
    driver.notify("n.md", "create");
    clock.tick();
    await settle();
    expect(dispatched).toHaveLength(1);
  });
});

describe("AgentTriggerDriver — body reads", () => {
  it("only reads the body when a mention trigger needs it", async () => {
    const seen: string[] = [];
    const { driver, clock, dispatched } = makeDriver({
      agents: () => [agent("ghostwriter", ["note-mention"])],
      readNote: async (p) => {
        seen.push(p);
        return { tags: [], body: "hey @ghostwriter" };
      },
    });
    driver.arm();
    driver.notify("n.md", "modify");
    clock.tick();
    await settle();
    expect(seen).toEqual(["n.md"]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].reason).toBe("@mention in n.md");
  });
});

describe("AgentTriggerDriver — dispose", () => {
  it("cancels pending work and stops reacting", async () => {
    const { driver, clock, dispatched } = makeDriver();
    driver.arm();
    driver.notify("_inbox/a.md", "create");
    driver.dispose();
    expect(clock.pendingCount()).toBe(0);
    driver.notify("_inbox/b.md", "create");
    clock.tick();
    await settle();
    expect(dispatched).toEqual([]);
  });
});
