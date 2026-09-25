import { describe, it, expect } from "vitest";
import {
  isExternalObsidianMcp,
  configuredMcpServers,
  obsidianMcpDenyList,
  claudeCliEnv,
  markSkippedObsidianMcp,
  DEFAULT_MCP_TOOL_IDLE_TIMEOUT_MS,
  OBSIDIAN_MCP_SKIP_REASON,
} from "../src/core/mcp-guard";

describe("isExternalObsidianMcp", () => {
  it("matches by server name", () => {
    expect(isExternalObsidianMcp("mcp-obsidian", { command: "uvx", args: ["mcp-obsidian"] })).toBe(true);
    expect(isExternalObsidianMcp("Obsidian Vault", { command: "node", args: ["server.js"] })).toBe(true);
    expect(isExternalObsidianMcp("my-notes", { type: "http", url: "https://example.com/obsidian/mcp" })).toBe(true);
  });

  it("matches by package or command even under a neutral name", () => {
    const cases: Record<string, unknown>[] = [
      { command: "uvx", args: ["mcp-obsidian"] },
      { command: "npx", args: ["-y", "obsidian-mcp", "/Users/me/Vault"] },
      { command: "npx", args: ["-y", "obsidian-mcp-server@latest"] },
      { command: "npx", args: ["-y", "@cyanheads/obsidian-mcp-server"] },
      { command: "cmd", args: ["/c", "npx", "-y", "mcp-obsidian"] },
      { command: "node", args: ["C:\\src\\mcp-obsidian\\dist\\index.js"] },
      { command: "/Users/me/Vault/.obsidian/plugins/mcp-tools/bin/mcp-server" },
      { command: "C:\\Users\\me\\Vault\\.obsidian\\plugins\\mcp-tools\\bin\\mcp-server.exe" },
      { type: "http", url: "https://127.0.0.1:27124/mcp" },
      { type: "sse", url: "http://localhost:27123/sse" },
    ];
    for (const config of cases) expect(isExternalObsidianMcp("notes", config)).toBe(true);
  });

  it("leaves unrelated servers alone, including a filesystem server pointed at a vault", () => {
    expect(isExternalObsidianMcp("playwright", { command: "npx", args: ["@playwright/mcp"] })).toBe(false);
    expect(isExternalObsidianMcp("fs", { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents/Obsidian Vault"] })).toBe(false);
    expect(isExternalObsidianMcp("context7", { type: "http", url: "https://mcp.context7.com/mcp" })).toBe(false);
  });

  it("never matches Exo's own server", () => {
    expect(isExternalObsidianMcp("obsidian", { type: "sdk", name: "obsidian" })).toBe(false);
    expect(isExternalObsidianMcp("obsidian", {})).toBe(false);
    expect(isExternalObsidianMcp("anything", { type: "sdk", name: "mcp-obsidian" })).toBe(false);
  });

  it("does match an external server that happens to be named like Exo's", () => {
    expect(isExternalObsidianMcp("obsidian", { command: "uvx", args: ["mcp-obsidian"] })).toBe(true);
  });
});

describe("configuredMcpServers", () => {
  const claudeJson = {
    mcpServers: { "mcp-obsidian": { command: "uvx", args: ["mcp-obsidian"] }, junk: "not-an-object" },
    projects: {
      "C:\\Users\\me\\Vault": { mcpServers: { local: { command: "node" } } },
      "/other/repo": { mcpServers: { elsewhere: { command: "node" } } },
    },
  };

  it("collects user, local (matching cwd) and project scopes", () => {
    const out = configuredMcpServers(claudeJson, { mcpServers: { proj: { command: "x" } } }, "C:/Users/me/Vault/");
    expect(out.map((s) => s.name)).toEqual(["mcp-obsidian", "local", "proj"]);
  });

  it("tolerates missing or malformed files", () => {
    expect(configuredMcpServers(undefined, undefined, "/v")).toEqual([]);
    expect(configuredMcpServers({ mcpServers: [] }, "nope", "/v")).toEqual([]);
  });
});

describe("obsidianMcpDenyList", () => {
  it("denies external Obsidian servers by name", () => {
    expect(
      obsidianMcpDenyList([
        { name: "mcp-obsidian", config: { command: "uvx", args: ["mcp-obsidian"] } },
        { name: "playwright", config: { command: "npx", args: ["@playwright/mcp"] } },
        { name: "mcp-obsidian", config: { command: "uvx", args: ["mcp-obsidian"] } },
      ]),
    ).toEqual([{ serverName: "mcp-obsidian" }]);
  });

  it("denies a server named like Exo's own by command or URL, never by name", () => {
    expect(obsidianMcpDenyList([{ name: "obsidian", config: { command: "uvx", args: ["mcp-obsidian"] } }])).toEqual([
      { serverCommand: ["uvx", "mcp-obsidian"] },
    ]);
    expect(obsidianMcpDenyList([{ name: "obsidian", config: { type: "http", url: "https://127.0.0.1:27124/mcp" } }])).toEqual([
      { serverUrl: "https://127.0.0.1:27124/mcp" },
    ]);
  });

  it("is empty when nothing matches", () => {
    expect(obsidianMcpDenyList([{ name: "context7", config: { type: "http", url: "https://mcp.context7.com/mcp" } }])).toEqual([]);
  });
});

describe("claudeCliEnv", () => {
  it("sets PATH and a default MCP idle timeout", () => {
    const env = claudeCliEnv({ HOME: "/h", PATH: "/usr/bin" }, "/enriched");
    expect(env.PATH).toBe("/enriched");
    expect(env.HOME).toBe("/h");
    expect(env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT).toBe(DEFAULT_MCP_TOOL_IDLE_TIMEOUT_MS);
  });

  it("keeps a user-set idle timeout, including 0 (disabled)", () => {
    expect(claudeCliEnv({ CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "600000" }, "").CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT).toBe("600000");
    expect(claudeCliEnv({ CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "0" }, "").CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT).toBe("0");
  });

  it("does not set MCP_TOOL_TIMEOUT (it would also cap Exo's own in-process tools)", () => {
    expect(claudeCliEnv({}, "").MCP_TOOL_TIMEOUT).toBeUndefined();
    expect(claudeCliEnv({ MCP_TOOL_TIMEOUT: "5000" }, "").MCP_TOOL_TIMEOUT).toBe("5000");
  });
});

describe("markSkippedObsidianMcp", () => {
  it("relabels loaded Obsidian servers and leaves the rest untouched", () => {
    const items = [
      { name: "mcp-obsidian", source: "claude-global", config: { command: "uvx", args: ["mcp-obsidian"] }, state: "have" },
      { name: "obsidian-mcp", source: "codex", config: { command: "npx", args: ["obsidian-mcp"] }, state: "importable" },
      { name: "obsidian", source: "plugin", state: "active", status: "connected" },
      { name: "playwright", source: "vault", config: { command: "npx", args: ["@playwright/mcp"] }, state: "active", status: "connected" },
    ];
    const out = markSkippedObsidianMcp(items);
    expect(out[0]).toMatchObject({ state: "active", status: "skipped", desc: OBSIDIAN_MCP_SKIP_REASON });
    expect(out.slice(1)).toEqual(items.slice(1));
  });
});
