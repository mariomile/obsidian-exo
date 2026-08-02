import { describe, it, expect } from "vitest";
import {
  slugifyAgent,
  frontmatterBlock,
  fmScalar,
  fmList,
  parseDuration,
  formatDuration,
  parseTrigger,
  serializeTrigger,
  triggerLabel,
  globToRegExp,
  matchesGlobs,
  canWritePath,
  parseAgentBrain,
  reconcileInvocable,
  parseAgentSidecar,
  serializeAgentSidecar,
  defaultContract,
  mergeAgents,
  orphanContracts,
  resolveAgent,
  agentsWithTrigger,
  buildAgentBindingOutbound,
  parseAgentCommand,
  type AgentBrain,
  type AgentContract,
} from "../src/core/agents";

const brain = (slug: string, over: Partial<AgentBrain> = {}): AgentBrain => ({
  slug,
  name: slug,
  invocable: slug,
  source: "vault",
  ...over,
});

describe("parseAgentBrain — the invocable id", () => {
  const file = (fm: string[]) => ["---", ...fm, "---", "You are an agent."].join("\n");

  // Ground truth: a live `system/init` capability snapshot lists these exact
  // ids, and `subagent_type` must match them or delegation silently misses.
  it("a vault agent is invoked by its frontmatter name, not its filename", () => {
    const b = parseAgentBrain(file(["name: Career Coach"]), "career-coach", "vault");
    expect(b.slug).toBe("career-coach");
    expect(b.name).toBe("Career Coach");
    expect(b.invocable).toBe("Career Coach");
  });

  it("a plugin agent keeps its scope prefix and drops the .agent file suffix", () => {
    // Slug arrives already prefixed and already stripped of `.agent` by the scan.
    const b = parseAgentBrain(
      file(["name: ce-adversarial-reviewer"]),
      "compound-engineering:ce-adversarial-reviewer",
      "plugin"
    );
    expect(b.invocable).toBe("compound-engineering:ce-adversarial-reviewer");
    expect(b.name).toBe("ce-adversarial-reviewer");
  });

  it("falls back to the filename base when there is no name:", () => {
    expect(parseAgentBrain(file(["description: x"]), "vault-librarian", "vault").invocable).toBe("vault-librarian");
    expect(parseAgentBrain("no frontmatter", "plugin:foo", "plugin").invocable).toBe("plugin:foo");
    expect(parseAgentBrain("no frontmatter", "plugin:foo", "plugin").name).toBe("foo");
  });

  it("reads model, tools and description", () => {
    const b = parseAgentBrain(
      file(["name: X", "description: does things", "model: claude-sonnet-4-5", "tools: [Read, Grep]"]),
      "x",
      "vault",
      ".claude/agents/x.md"
    );
    expect(b.model).toBe("claude-sonnet-4-5");
    expect(b.tools).toEqual(["Read", "Grep"]);
    expect(b.description).toBe("does things");
    expect(b.path).toBe(".claude/agents/x.md");
  });
});

describe("slugifyAgent", () => {
  it("lowercases and collapses non-alphanumerics", () => {
    expect(slugifyAgent("  Research Analyst ")).toBe("research-analyst");
    expect(slugifyAgent("CRM Keeper")).toBe("crm-keeper");
    expect(slugifyAgent("Inbox — Triager!!")).toBe("inbox-triager");
  });
  it("returns empty for input with nothing to slug", () => {
    expect(slugifyAgent("   ***  ")).toBe("");
  });
});

describe("frontmatter helpers", () => {
  const fm = frontmatterBlock(
    ["---", "name: Ghostwriter", 'icon: "pen-line"', "enabled: true # inline comment", "read: [a/**, b/*]", "triggers:", "  - schedule daily 08", "  - note-mention", "empty:", "---", "body"].join("\n")
  )!;

  it("extracts the block", () => {
    expect(fm).toContain("name: Ghostwriter");
    expect(fm).not.toContain("body");
  });
  it("returns null when there is no frontmatter", () => {
    expect(frontmatterBlock("just a body")).toBeNull();
  });
  it("reads scalars, unquoting and stripping trailing comments", () => {
    expect(fmScalar(fm, "name")).toBe("Ghostwriter");
    expect(fmScalar(fm, "icon")).toBe("pen-line");
    expect(fmScalar(fm, "enabled")).toBe("true");
    expect(fmScalar(fm, "missing")).toBeUndefined();
    expect(fmScalar(fm, "empty")).toBeUndefined();
  });
  it("reads flow lists", () => {
    expect(fmList(fm, "read")).toEqual(["a/**", "b/*"]);
  });
  it("reads block lists and stops at the next key", () => {
    expect(fmList(fm, "triggers")).toEqual(["schedule daily 08", "note-mention"]);
  });
  it("returns [] for absent or empty keys", () => {
    expect(fmList(fm, "write")).toEqual([]);
    expect(fmList(fm, "empty")).toEqual([]);
  });
});

describe("parseDuration / formatDuration", () => {
  it("parses units, defaulting bare numbers to minutes", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("45")).toBe(2_700_000);
    expect(parseDuration("0")).toBe(0);
  });
  it("rejects garbage and negatives", () => {
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("-5m")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });
  it("round-trips through the largest exact unit", () => {
    for (const s of ["30m", "2h", "90s", "1d"]) {
      expect(formatDuration(parseDuration(s)!)).toBe(s);
    }
  });
});

describe("parseTrigger", () => {
  it("parses schedule cadences", () => {
    expect(parseTrigger("schedule hourly")).toEqual({ on: "schedule", cadence: { kind: "hourly" } });
    expect(parseTrigger("schedule daily 08")).toEqual({ on: "schedule", cadence: { kind: "daily", hour: 8 } });
    expect(parseTrigger("schedule weekly mon 08")).toEqual({
      on: "schedule",
      cadence: { kind: "weekly", day: 1, hour: 8 },
    });
  });
  it("accepts Italian day names (parseCadenceInput is shared)", () => {
    expect(parseTrigger("schedule weekly lunedì 07")).toEqual({
      on: "schedule",
      cadence: { kind: "weekly", day: 1, hour: 7 },
    });
  });
  it("parses vault events with globs", () => {
    expect(parseTrigger("vault-event create _inbox/**")).toEqual({
      on: "vault-event",
      event: "create",
      path: "_inbox/**",
    });
  });
  it("parses note-mention and tag, normalizing a missing #", () => {
    expect(parseTrigger("note-mention")).toEqual({ on: "note-mention" });
    expect(parseTrigger("tag needs/post")).toEqual({ on: "tag", tag: "#needs/post" });
    expect(parseTrigger("tag #needs/post")).toEqual({ on: "tag", tag: "#needs/post" });
  });
  it("rejects unknown kinds and incomplete forms", () => {
    expect(parseTrigger("webhook")).toBeNull();
    expect(parseTrigger("vault-event create")).toBeNull();
    expect(parseTrigger("vault-event deleted _inbox/**")).toBeNull();
    expect(parseTrigger("schedule")).toBeNull();
    expect(parseTrigger("schedule fortnightly")).toBeNull();
    expect(parseTrigger("tag")).toBeNull();
    expect(parseTrigger("")).toBeNull();
  });
  it("round-trips through serializeTrigger", () => {
    for (const line of [
      "schedule hourly",
      "schedule daily 08",
      "schedule weekly mon 08",
      "vault-event create _inbox/**",
      "note-mention",
      "tag #needs/post",
    ]) {
      expect(serializeTrigger(parseTrigger(line)!)).toBe(line);
    }
  });
  it("labels triggers for the UI", () => {
    expect(triggerLabel(parseTrigger("schedule daily 08")!)).toBe("daily 08:00");
    expect(triggerLabel(parseTrigger("vault-event create _inbox/**")!)).toBe("on create in _inbox/**");
    expect(triggerLabel(parseTrigger("note-mention")!)).toBe("on @mention in a note");
  });
});

describe("globToRegExp / matchesGlobs", () => {
  it("trailing ** spans any depth, and the folder itself", () => {
    const re = globToRegExp("_inbox/**");
    expect(re.test("_inbox/note.md")).toBe(true);
    expect(re.test("_inbox/a/b/note.md")).toBe(true);
    expect(re.test("_inbox")).toBe(true);
    expect(re.test("_inbox-old/note.md")).toBe(false);
    expect(re.test("Active/note.md")).toBe(false);
  });
  it("interior ** collapses to nothing", () => {
    const re = globToRegExp("Active/**/context.md");
    expect(re.test("Active/context.md")).toBe(true);
    expect(re.test("Active/Projects/context.md")).toBe(true);
    expect(re.test("Active/Projects/Captoo/context.md")).toBe(true);
    expect(re.test("Atlas/context.md")).toBe(false);
  });
  it("leading ** matches at any depth", () => {
    const re = globToRegExp("**/*.md");
    expect(re.test("note.md")).toBe(true);
    expect(re.test("a/b/note.md")).toBe(true);
    expect(re.test("note.canvas")).toBe(false);
  });
  it("* stays inside one segment", () => {
    const re = globToRegExp("Active/*.md");
    expect(re.test("Active/note.md")).toBe(true);
    expect(re.test("Active/sub/note.md")).toBe(false);
  });
  it("escapes regex metacharacters in literal text", () => {
    expect(globToRegExp("a+b(c).md").test("a+b(c).md")).toBe(true);
    expect(globToRegExp("a+b(c).md").test("aXbYcZmd")).toBe(false);
  });
  it("matches against any pattern in the list", () => {
    expect(matchesGlobs("Journal/Daily/01-08-2026.md", ["Active/**", "Journal/**"])).toBe(true);
    expect(matchesGlobs("Journal/Daily/01-08-2026.md", ["Active/**"])).toBe(false);
    expect(matchesGlobs("anything", [])).toBe(false);
  });
});

describe("canWritePath — deny by default", () => {
  it("refuses every path when no write glob is declared", () => {
    const c = defaultContract("x");
    expect(canWritePath(c, "Active/note.md")).toBe(false);
  });
  it("allows only declared globs", () => {
    const c: AgentContract = { ...defaultContract("x"), scope: { read: [], write: ["Posts/**"] } };
    expect(canWritePath(c, "Posts/a.md")).toBe(true);
    expect(canWritePath(c, "Active/a.md")).toBe(false);
  });
});

describe("parseAgentSidecar", () => {
  const raw = [
    "---",
    "type: agent",
    "agent: ghostwriter",
    "enabled: true",
    "icon: pen-line",
    "autonomy: act",
    "cooldown: 2h",
    'read: ["Active/Projects/Content/**"]',
    'write: ["Active/Projects/Content/Posts/**"]',
    "can_call: [research-analyst, ghostwriter]",
    "triggers:",
    "  - schedule weekly mon 08",
    "  - note-mention",
    "tags:",
    "  - type/agent",
    "---",
    "",
    "## Notes",
  ].join("\n");

  it("parses the full contract", () => {
    const { contract, warnings } = parseAgentSidecar(raw, "ghostwriter");
    expect(contract.enabled).toBe(true);
    expect(contract.icon).toBe("pen-line");
    expect(contract.autonomy).toBe("act");
    expect(contract.cooldownMs).toBe(7_200_000);
    expect(contract.scope.write).toEqual(["Active/Projects/Content/Posts/**"]);
    expect(contract.triggers).toHaveLength(2);
    expect(warnings).toContain("can_call lists the agent itself — self-calls are always refused");
  });
  it("drops a self-reference from can_call", () => {
    expect(parseAgentSidecar(raw, "ghostwriter").contract.canCall).toEqual(["research-analyst"]);
  });
  it("ignores unknown frontmatter keys (tags survive untouched in the file)", () => {
    expect(parseAgentSidecar(raw, "ghostwriter").contract.slug).toBe("ghostwriter");
  });
  it("falls back to inert defaults without frontmatter, and warns", () => {
    const { contract, warnings } = parseAgentSidecar("# just a note", "x");
    expect(contract).toEqual(defaultContract("x"));
    expect(warnings[0]).toMatch(/no frontmatter/);
  });
  it("keeps the agent usable when individual fields are broken", () => {
    const broken = ["---", "enabled: true", "autonomy: yolo", "cooldown: soon", "triggers:", "  - telepathy", "---"].join("\n");
    const { contract, warnings } = parseAgentSidecar(broken, "x");
    expect(contract.enabled).toBe(true);
    expect(contract.autonomy).toBe("propose");
    expect(contract.cooldownMs).toBe(defaultContract("x").cooldownMs);
    expect(contract.triggers).toEqual([]);
    expect(warnings).toHaveLength(3);
  });
  it('warns when autonomy is "act" but nothing is writable', () => {
    const raw2 = ["---", "autonomy: act", "---"].join("\n");
    expect(parseAgentSidecar(raw2, "x").warnings.join(" ")).toMatch(/no write globs/);
  });
  it("treats a missing enabled key as disabled (discovery grants no autonomy)", () => {
    expect(parseAgentSidecar(["---", "icon: bot", "---"].join("\n"), "x").contract.enabled).toBe(false);
  });
  it("round-trips through serializeAgentSidecar", () => {
    const original = parseAgentSidecar(raw, "ghostwriter").contract;
    const round = parseAgentSidecar(serializeAgentSidecar(original), "ghostwriter").contract;
    expect(round).toEqual(original);
  });
});

describe("serializeAgentSidecar", () => {
  it("scaffolds an inert contract with commented trigger examples", () => {
    const out = serializeAgentSidecar(defaultContract("vault-librarian"), brain("vault-librarian", { name: "Vault Librarian" }), "2026-08-01");
    expect(out).toContain("enabled: false");
    expect(out).toContain("agent: vault-librarian");
    expect(out).toContain("last_updated: 2026-08-01");
    expect(out).toContain("# - schedule daily 08");
    expect(out).toContain("# Vault Librarian");
    expect(parseAgentSidecar(out, "vault-librarian").contract.triggers).toEqual([]);
  });
});

describe("mergeAgents", () => {
  it("joins by slug and falls back to an inert contract", () => {
    const agents = mergeAgents([brain("a"), brain("b")], [{ ...defaultContract("a"), enabled: true }]);
    expect(agents.map((x) => x.brain.slug)).toEqual(["a", "b"]);
    expect(agents[0].contract.enabled).toBe(true);
    expect(agents[1].contract.enabled).toBe(false);
  });
  it("first brain wins on duplicate slugs (source precedence)", () => {
    const agents = mergeAgents([brain("a", { source: "vault", name: "Vault A" }), brain("a", { source: "user", name: "User A" })], []);
    expect(agents).toHaveLength(1);
    expect(agents[0].brain.source).toBe("vault");
  });
  it("sorts by display name", () => {
    const agents = mergeAgents([brain("z", { name: "Alpha" }), brain("a", { name: "Zulu" })], []);
    expect(agents.map((x) => x.brain.name)).toEqual(["Alpha", "Zulu"]);
  });
  it("drops contracts with no brain but reports them as orphans", () => {
    const contracts = [defaultContract("ghost")];
    expect(mergeAgents([brain("a")], contracts)).toHaveLength(1);
    expect(orphanContracts([brain("a")], contracts)).toEqual(["ghost"]);
  });
});

describe("reconcileInvocable", () => {
  const withInvocable = (slug: string, invocable: string) =>
    mergeAgents([brain(slug, { name: slug, invocable })], [])[0];

  it("adopts the engine's id when only the scope prefix drifted", () => {
    // Observed in the wild: installed_plugins.json keys the Vercel plugin by an
    // opaque id, so the on-disk prefix and the CLI's prefix disagree.
    const [out] = reconcileInvocable(
      [withInvocable("vercel:ai-architect", "vercel:ai-architect")],
      ["b95178c7d8df:ai-architect", "other:thing"]
    );
    expect(out.brain.invocable).toBe("b95178c7d8df:ai-architect");
  });

  it("leaves an already-exact id alone", () => {
    const [out] = reconcileInvocable([withInvocable("a", "Career Coach")], ["Career Coach", "coach"]);
    expect(out.brain.invocable).toBe("Career Coach");
  });

  it("refuses to guess when the suffix is ambiguous", () => {
    const [out] = reconcileInvocable([withInvocable("x", "one:thing")], ["two:thing", "three:thing"]);
    expect(out.brain.invocable).toBe("one:thing");
  });

  it("leaves an unmatched id alone rather than inventing one", () => {
    const [out] = reconcileInvocable([withInvocable("x", "nope")], ["a", "b"]);
    expect(out.brain.invocable).toBe("nope");
  });

  it("is a no-op without a capability snapshot", () => {
    const input = [withInvocable("x", "vercel:thing")];
    expect(reconcileInvocable(input, [])).toBe(input);
  });
});

describe("resolveAgent", () => {
  const agents = mergeAgents([brain("research-analyst", { name: "Research Analyst" }), brain("crm-keeper", { name: "CRM Keeper" })], []);
  it("resolves by slug, display name, @handle, and loose casing", () => {
    for (const q of ["research-analyst", "Research Analyst", "@research-analyst", "  Research   Analyst  "]) {
      expect(resolveAgent(agents, q)?.brain.slug).toBe("research-analyst");
    }
  });
  it("returns null for unknown and empty queries", () => {
    expect(resolveAgent(agents, "nobody")).toBeNull();
    expect(resolveAgent(agents, "  ")).toBeNull();
    expect(resolveAgent(agents, "@")).toBeNull();
  });
});

describe("agentsWithTrigger", () => {
  const withTriggers = (slug: string, enabled: boolean, lines: string[]) => ({
    ...defaultContract(slug),
    enabled,
    triggers: lines.map((l) => parseTrigger(l)!),
  });
  const agents = mergeAgents(
    [brain("a"), brain("b"), brain("c")],
    [
      withTriggers("a", true, ["schedule daily 08", "note-mention"]),
      withTriggers("b", false, ["schedule hourly"]),
      withTriggers("c", true, ["vault-event create _inbox/**"]),
    ]
  );
  it("returns one entry per matching trigger, skipping disabled agents", () => {
    expect(agentsWithTrigger(agents, "schedule").map((x) => x.agent.brain.slug)).toEqual(["a"]);
    expect(agentsWithTrigger(agents, "vault-event").map((x) => x.agent.brain.slug)).toEqual(["c"]);
    expect(agentsWithTrigger(agents, "tag")).toEqual([]);
  });
  it("narrows the trigger type", () => {
    const [hit] = agentsWithTrigger(agents, "vault-event");
    expect(hit.trigger.event).toBe("create");
    expect(hit.trigger.path).toBe("_inbox/**");
  });
});

describe("buildAgentBindingOutbound", () => {
  const def = mergeAgents(
    [brain("ghostwriter", { name: "Ghostwriter", invocable: "Ghostwriter", description: "Drafts posts in Mario's voice" })],
    [{ ...defaultContract("ghostwriter"), autonomy: "act", scope: { read: [], write: ["Posts/**"] } }]
  )[0];

  it("delegates to the INVOCABLE id, not the slug, and keeps the visible text last", () => {
    const out = buildAgentBindingOutbound(def, "write the launch post");
    expect(out).toContain('subagent_type: "Ghostwriter"');
    expect(out).not.toContain('subagent_type: "ghostwriter"');
    expect(out).toContain("Drafts posts in Mario's voice");
    expect(out.endsWith("write the launch post")).toBe(true);
    expect(out).toContain("provider-only instructions");
  });
  it("states the write scope, and refuses writes when none is declared", () => {
    expect(buildAgentBindingOutbound(def, "x")).toContain("only inside: Posts/**");
    const inert = mergeAgents([brain("x", { name: "X" })], [])[0];
    expect(buildAgentBindingOutbound(inert, "y")).toContain("no declared write scope");
  });
  it("carries the autonomy tier for non-act agents", () => {
    const notify = mergeAgents([brain("x", { name: "X" })], [{ ...defaultContract("x"), autonomy: "notify" }])[0];
    expect(buildAgentBindingOutbound(notify, "y")).toContain("report only");
  });
  it("uses Codex multi-agent primitives and includes the agent definition", () => {
    const codexDef = { ...def, brain: { ...def.brain, prompt: "You are the vault ghostwriter." } };
    const out = buildAgentBindingOutbound(codexDef, "write it", "codex");
    expect(out).toContain("spawn_agent");
    expect(out).toContain("wait_agent");
    expect(out).toContain("You are the vault ghostwriter.");
    expect(out).not.toContain("subagent_type");
  });
});

describe("parseAgentCommand", () => {
  it("binds, clears, and rejects the bare command", () => {
    expect(parseAgentCommand("/as ghostwriter")).toEqual({ kind: "bind", query: "ghostwriter" });
    expect(parseAgentCommand("/AS Research Analyst")).toEqual({ kind: "bind", query: "Research Analyst" });
    expect(parseAgentCommand("/as off")).toEqual({ kind: "clear" });
    expect(parseAgentCommand("/as none")).toEqual({ kind: "clear" });
    expect(parseAgentCommand("/as")?.kind).toBe("invalid");
  });
  it("leaves lookalikes as normal chat", () => {
    expect(parseAgentCommand("/ask something")).toBeNull();
    expect(parseAgentCommand("as ghostwriter")).toBeNull();
    expect(parseAgentCommand("tell me /as a joke")).toBeNull();
  });
});

describe("buildAgentBindingOutbound — synchronous delegation", () => {
  it("waits for the subagent instead of backgrounding it", () => {
    const def = mergeAgents([brain("gw", { name: "GW", invocable: "GW" })], [])[0];
    const out = buildAgentBindingOutbound(def, "write it");
    expect(out).toContain("run_in_background: false");
    expect(out).toMatch(/WAIT for its result/);
  });
});
