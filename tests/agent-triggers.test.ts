import { describe, it, expect } from "vitest";
import {
  isIgnoredTriggerPath,
  findAgentMentions,
  matchVaultEvent,
  anyEventTriggers,
  needsBody,
} from "../src/core/agent-triggers";
import { mergeAgents, defaultContract, parseTrigger, type AgentBrain, type AgentContract } from "../src/core/agents";

const brain = (slug: string, name = slug): AgentBrain => ({ slug, name, invocable: name, source: "vault" });

function agent(slug: string, triggers: string[], over: Partial<AgentContract> = {}, name = slug) {
  const contract: AgentContract = {
    ...defaultContract(slug),
    enabled: true,
    triggers: triggers.map((t) => parseTrigger(t)!),
    ...over,
  };
  return mergeAgents([brain(slug, name)], [contract])[0];
}

describe("isIgnoredTriggerPath", () => {
  it("ignores tool-owned trees, including the memory root", () => {
    for (const p of [
      ".obsidian/plugins/exo/data.json.md",
      ".claude/agents/x.md",
      ".trash/old.md",
      "_system/reports/run.md",
      "_system/agents/x.md",
    ]) {
      expect(isIgnoredTriggerPath(p, "_system")).toBe(true);
    }
  });

  it("ignores non-markdown", () => {
    expect(isIgnoredTriggerPath("Active/image.png", "_system")).toBe(true);
  });

  it("allows ordinary notes", () => {
    expect(isIgnoredTriggerPath("_inbox/idea.md", "_system")).toBe(false);
    expect(isIgnoredTriggerPath("Active/Projects/x/context.md", "_system")).toBe(false);
  });

  it("does not treat a same-prefixed sibling folder as excluded", () => {
    // `_systems/` is not `_system/`
    expect(isIgnoredTriggerPath("_systems/note.md", "_system")).toBe(false);
  });

  it("follows a relocated memory root", () => {
    expect(isIgnoredTriggerPath("_exo/reports/r.md", "_exo")).toBe(true);
    expect(isIgnoredTriggerPath("_system/reports/r.md", "_exo")).toBe(false);
  });
});

describe("findAgentMentions", () => {
  const agents = [agent("ghostwriter", [], {}, "Ghostwriter"), agent("crm-keeper", [], {}, "CRM Keeper")];

  it("matches the slug and the display name", () => {
    expect(findAgentMentions("please @ghostwriter draft this", agents).map((a) => a.brain.slug)).toEqual([
      "ghostwriter",
    ]);
    expect(findAgentMentions("cc @CRM Keeper", agents).map((a) => a.brain.slug)).toEqual(["crm-keeper"]);
  });

  it("is accent- and case-insensitive", () => {
    expect(findAgentMentions("@GHOSTWRITER", agents)).toHaveLength(1);
  });

  it("never matches an email address", () => {
    expect(findAgentMentions("write to mario@ghostwriter.com", agents)).toEqual([]);
  });

  it("ignores mentions inside fenced and inline code", () => {
    expect(findAgentMentions("```\n@ghostwriter\n```", agents)).toEqual([]);
    expect(findAgentMentions("use `@ghostwriter` to call it", agents)).toEqual([]);
  });

  it("requires a word boundary after the handle", () => {
    expect(findAgentMentions("@ghostwriters are great", agents)).toEqual([]);
    expect(findAgentMentions("@ghostwriter-2", agents)).toEqual([]);
  });

  it("matches at the very start of the body and after punctuation", () => {
    expect(findAgentMentions("@ghostwriter go", agents)).toHaveLength(1);
    expect(findAgentMentions("(@ghostwriter)", agents)).toHaveLength(1);
  });

  it("returns every distinct agent mentioned", () => {
    expect(findAgentMentions("@ghostwriter and @crm-keeper", agents)).toHaveLength(2);
  });
});

describe("matchVaultEvent — vault-event triggers", () => {
  const triager = agent("triager", ["vault-event create _inbox/**"]);

  it("fires on a matching path and kind", () => {
    const hits = matchVaultEvent([triager], { path: "_inbox/note.md", kind: "create" });
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toBe("create _inbox/note.md");
  });

  it("does not fire on a different kind or a non-matching path", () => {
    expect(matchVaultEvent([triager], { path: "_inbox/note.md", kind: "modify" })).toEqual([]);
    expect(matchVaultEvent([triager], { path: "Active/note.md", kind: "create" })).toEqual([]);
  });

  it("skips disabled agents", () => {
    const off = agent("off", ["vault-event create _inbox/**"], { enabled: false });
    expect(matchVaultEvent([off], { path: "_inbox/n.md", kind: "create" })).toEqual([]);
  });

  it("scopes the run key by path, so two notes are two runs", () => {
    const a = matchVaultEvent([triager], { path: "_inbox/a.md", kind: "create" })[0];
    const b = matchVaultEvent([triager], { path: "_inbox/b.md", kind: "create" })[0];
    expect(a.runKey).not.toBe(b.runKey);
    expect(a.runKey).toContain("_inbox/a.md");
  });
});

describe("matchVaultEvent — tag triggers", () => {
  const poster = agent("poster", ["tag #needs/post"]);

  it("fires when the tag appears on a newly created note", () => {
    const hits = matchVaultEvent([poster], { path: "n.md", kind: "create", tags: ["#needs/post"] });
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toBe("#needs/post on n.md");
  });

  it("fires on the transition, not on every later edit", () => {
    const added = matchVaultEvent([poster], {
      path: "n.md",
      kind: "modify",
      tags: ["#needs/post"],
      previousTags: [],
    });
    expect(added).toHaveLength(1);

    const unchanged = matchVaultEvent([poster], {
      path: "n.md",
      kind: "modify",
      tags: ["#needs/post"],
      previousTags: ["#needs/post"],
    });
    expect(unchanged).toEqual([]);
  });

  it("does not fire on a modify with no previous snapshot (first sight is not an addition)", () => {
    expect(matchVaultEvent([poster], { path: "n.md", kind: "modify", tags: ["#needs/post"] })).toEqual([]);
  });

  it("does not fire when the tag is absent", () => {
    expect(matchVaultEvent([poster], { path: "n.md", kind: "create", tags: ["#other"] })).toEqual([]);
  });
});

describe("matchVaultEvent — note-mention triggers", () => {
  const gw = agent("ghostwriter", ["note-mention"], {}, "Ghostwriter");

  it("fires when the body mentions the agent", () => {
    const hits = matchVaultEvent([gw], { path: "n.md", kind: "modify", body: "@ghostwriter please draft" });
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toBe("@mention in n.md");
  });

  it("does nothing without a body", () => {
    expect(matchVaultEvent([gw], { path: "n.md", kind: "modify" })).toEqual([]);
  });

  it("does not fire on an unrelated body", () => {
    expect(matchVaultEvent([gw], { path: "n.md", kind: "modify", body: "just notes" })).toEqual([]);
  });
});

describe("matchVaultEvent — combined", () => {
  it("returns one entry per matching trigger across agents", () => {
    const a = agent("a", ["vault-event create _inbox/**", "note-mention"], {}, "A");
    const b = agent("b", ["tag #x"], {}, "B");
    const hits = matchVaultEvent([a, b], {
      path: "_inbox/n.md",
      kind: "create",
      tags: ["#x"],
      body: "@a look at this",
    });
    expect(hits).toHaveLength(3);
  });

  it("ignores schedule triggers entirely", () => {
    const s = agent("s", ["schedule daily 08"]);
    expect(matchVaultEvent([s], { path: "_inbox/n.md", kind: "create" })).toEqual([]);
  });
});

describe("driver hints", () => {
  it("anyEventTriggers is false when only schedules exist", () => {
    expect(anyEventTriggers([agent("s", ["schedule daily 08"])])).toBe(false);
    expect(anyEventTriggers([agent("e", ["vault-event create x/**"])])).toBe(true);
  });

  it("anyEventTriggers ignores disabled agents", () => {
    expect(anyEventTriggers([agent("e", ["vault-event create x/**"], { enabled: false })])).toBe(false);
  });

  it("needsBody is true only for mention triggers", () => {
    expect(needsBody([agent("e", ["vault-event create x/**"])])).toBe(false);
    expect(needsBody([agent("m", ["note-mention"])])).toBe(true);
  });
});
