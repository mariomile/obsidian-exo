import { describe, it, expect } from "vitest";
import {
  normalizeCodexServer,
  scanCodexMcp,
  scanClaudeGlobalMcp,
  assignMcpState,
  scanSkillDirs,
  assignSkillState,
  scanLiveCaps,
  toolNamePrefix,
  type DiscoveryItem,
} from "../src/core/connections-scan";

describe("normalizeCodexServer", () => {
  it("maps url form to http config, keeping headers", () => {
    const out = normalizeCodexServer({ url: "https://mcp.context7.com/mcp", http_headers: { Authorization: "Bearer x" } });
    expect(out).toEqual({ type: "http", url: "https://mcp.context7.com/mcp", headers: { Authorization: "Bearer x" } });
  });
  it("maps command form to stdio config, keeping args and env", () => {
    const out = normalizeCodexServer({ command: "npx", args: ["-y", "posthog-mcp"], env: { KEY: "v" } });
    expect(out).toEqual({ command: "npx", args: ["-y", "posthog-mcp"], env: { KEY: "v" } });
  });
  it("drops codex-only per-tool gating keys", () => {
    const out = normalizeCodexServer({ args: ["@playwright/mcp@latest"], tools: { browser_run_code_unsafe: {} } });
    expect(out).toEqual({ args: ["@playwright/mcp@latest"] });
  });
  it("returns null when neither url nor command nor args present", () => {
    expect(normalizeCodexServer({ description: "x" })).toBeNull();
  });
});

describe("scanCodexMcp", () => {
  const TOML = `
[mcp_servers.context7]
url = "https://mcp.context7.com/mcp"
[mcp_servers.context7.http_headers]

[mcp_servers.posthog]
command = "npx"
args = [ "-y", "@posthog/mcp" ]

[mcp_servers.playwright]
args = [ "@playwright/mcp@latest" ]
[mcp_servers.playwright.tools.browser_run_code_unsafe]
`;
  it("returns one importable item per server with a usable transport", () => {
    const items = scanCodexMcp(TOML);
    const names = items.map((i) => i.name).sort();
    expect(names).toEqual(["context7", "playwright", "posthog"]);
    expect(items.every((i) => i.kind === "mcp" && i.source === "codex" && i.origin === "Codex")).toBe(true);
  });
  it("normalizes the http server config", () => {
    const ctx = scanCodexMcp(TOML).find((i) => i.name === "context7")!;
    expect(ctx.config).toEqual({ type: "http", url: "https://mcp.context7.com/mcp" });
  });
  it("normalizes the stdio server config and drops tool gating", () => {
    const pw = scanCodexMcp(TOML).find((i) => i.name === "playwright")!;
    expect(pw.config).toEqual({ args: ["@playwright/mcp@latest"] });
  });
});

describe("scanClaudeGlobalMcp", () => {
  it("splits top-level and per-project servers with origins", () => {
    const items = scanClaudeGlobalMcp({
      mcpServers: { context7: { type: "http", url: "u" } },
      projects: { "/Users/m/Dev Projects/thymer": { mcpServers: { thymer: { command: "t" } } } },
    });
    expect(items.find((i) => i.name === "context7")!.origin).toBe("Claude global");
    expect(items.find((i) => i.name === "thymer")!.origin).toBe("Claude · thymer");
  });
});

describe("assignMcpState", () => {
  it("marks dupes across tools as have, codex-only as importable", () => {
    const codex = scanCodexMcp(`
[mcp_servers.context7]
url = "https://mcp.context7.com/mcp"

[mcp_servers.posthog]
command = "npx"
args = [ "-y", "@posthog/mcp" ]
`);
    const claude = scanClaudeGlobalMcp({ mcpServers: { context7: { type: "http", url: "u" } } });
    const all = assignMcpState([...claude, ...codex], {
      activeNames: new Set<string>(),
      inheritedNames: new Set(["context7"]),
    });
    const byName = new Map(all.map((i) => [i.name, i]));
    expect(byName.size).toBe(2); // deduped context7
    expect(byName.get("context7")!.state).toBe("have");
    expect(byName.get("posthog")!.state).toBe("importable");
  });
  it("marks names in activeNames as active", () => {
    const items = assignMcpState(
      [{ kind: "mcp", name: "ft", source: "codex", origin: "Codex", state: "importable" }],
      { activeNames: new Set(["ft"]), inheritedNames: new Set() },
    );
    expect(items[0].state).toBe("active");
  });
});

describe("scanSkillDirs + assignSkillState", () => {
  const dirs = [
    { origin: "deepagent-saas", source: "other-project" as const, skills: [
      { name: "rag-pipelines", path: "/p/deepagent-saas/.claude/skills/rag-pipelines", desc: "RAG" },
      { name: "brainstorming", path: "/p/deepagent-saas/.claude/skills/brainstorming" },
    ]},
    { origin: "PH_Pilot", source: "other-project" as const, skills: [
      { name: "pitch-deck", path: "/p/PH_Pilot/.claude/skills/pitch-deck" },
    ]},
    { origin: "Codex", source: "codex" as const, skills: [
      { name: "gpt-taste", path: "/Users/m/.codex/skills/gpt-taste" },        // codex-exclusive
      { name: "rag-pipelines", path: "/Users/m/.codex/skills/rag-pipelines" }, // mirror — deduped
    ]},
  ];
  it("flattens dirs into skill items carrying their source", () => {
    const items = scanSkillDirs(dirs);
    expect(items.find((i) => i.name === "gpt-taste")!.source).toBe("codex");
    expect(items.find((i) => i.name === "gpt-taste")!.origin).toBe("Codex");
    expect(items.find((i) => i.name === "pitch-deck")!.source).toBe("other-project");
  });
  it("never offers to import a skill we already have (dedup across all sources)", () => {
    const items = scanSkillDirs(dirs);
    const out = assignSkillState(items, new Set(["brainstorming", "rag-pipelines"]), new Set(["pitch-deck"]));
    const byName = new Map(out.map((i) => [i.name, i]));
    expect(byName.get("brainstorming")!.state).toBe("have");      // in ~/.claude/skills → greyed
    expect(byName.get("rag-pipelines")!.state).toBe("have");      // Codex mirror of a Claude skill → greyed
    expect(byName.get("pitch-deck")!.state).toBe("active");        // already in vault
    expect(byName.get("gpt-taste")!.state).toBe("importable");     // Codex-exclusive → genuinely new
  });
});

describe("scanLiveCaps", () => {
  const caps = [
    { name: "context7", status: "connected" },              // covered by config → skip
    { name: "claude.ai Slack", status: "connected" },
    { name: "claude.ai Gmail", status: "needs-auth" },
    { name: "plugin:claude-mem:mcp-search", status: "connected" },
    { name: "obsidian", status: "connected" },
  ];
  it("adds only caps servers not already covered, classified by origin", () => {
    const items = scanLiveCaps(caps, new Set(["context7"]));
    const byName = new Map(items.map((i) => [i.name, i]));
    expect(byName.has("context7")).toBe(false); // covered by a config item → not duplicated
    expect(byName.get("Slack")).toMatchObject({ source: "claude-connector", origin: "claude.ai", state: "active", status: "connected" });
    expect(byName.get("Gmail")).toMatchObject({ origin: "claude.ai", status: "needs-auth" });
    expect(byName.get("claude-mem")).toMatchObject({ source: "plugin", origin: "Plugin" });
    expect(byName.get("obsidian")).toMatchObject({ source: "plugin", origin: "Exo" });
  });
});

describe("toolNamePrefix", () => {
  const item = (over: Partial<DiscoveryItem> = {}): DiscoveryItem => ({
    kind: "mcp", name: "notion", source: "vault", origin: "vault", state: "active", ...over,
  });

  it("uses the config key verbatim for file-backed servers", () => {
    expect(toolNamePrefix(item({ name: "notion", source: "vault" }))).toBe("mcp__notion__");
    expect(toolNamePrefix(item({ name: "granola", source: "codex" }))).toBe("mcp__granola__");
  });

  it("rebuilds the raw name for claude.ai connectors — display name alone under-matches", () => {
    // scanLiveCaps strips "claude.ai " off the raw server name into `display`;
    // the SDK's tool names are sanitized from the RAW name, not the display one.
    expect(toolNamePrefix(item({ name: "Craft", source: "claude-connector" }))).toBe("mcp__claude_ai_Craft__");
    expect(toolNamePrefix(item({ name: "Gmail", source: "claude-connector" }))).toBe("mcp__claude_ai_Gmail__");
  });

  it("collapses any run of non-word characters to a single underscore", () => {
    expect(toolNamePrefix(item({ name: "my.weird name!!", source: "vault" }))).toBe("mcp__my_weird_name___");
  });
});
