import { afterAll, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SessionOpts } from "../src/providers/types";

const fake = {
  interrupt: vi.fn(() => Promise.resolve()),
  [Symbol.asyncIterator]() {
    return { next: () => new Promise<IteratorResult<unknown>>(() => {}) };
  },
};

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn(() => fake) }));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeAdapter } from "../src/providers/claude";

const vault = mkdtempSync(join(tmpdir(), "exo-mcp-guard-"));
writeFileSync(
  join(vault, ".mcp.json"),
  JSON.stringify({ mcpServers: { "vault-obsidian": { command: "uvx", args: ["mcp-obsidian"] }, other: { command: "node" } } }),
);
afterAll(() => rmSync(vault, { recursive: true, force: true }));

const OPTS: SessionOpts = {
  cli: { bin: "claude", pathEnv: "/enriched" },
  model: "default",
  effort: "default",
  cwd: vault,
  permissionMode: "default",
  toolsEnabled: false,
  fastStartup: false,
};

type CapturedOptions = { settings?: { deniedMcpServers?: unknown[] }; strictMcpConfig?: boolean; env?: Record<string, string> };
const lastOptions = (): CapturedOptions =>
  (vi.mocked(query).mock.calls.at(-1)![0] as unknown as { options: CapturedOptions }).options;

describe("Claude session MCP guard", () => {
  test("with external MCP on, denies external Obsidian servers via flag settings", () => {
    claudeAdapter.createSession(OPTS).dispose();
    const o = lastOptions();
    expect(o.settings?.deniedMcpServers).toContainEqual({ serverName: "vault-obsidian" });
    expect(o.settings?.deniedMcpServers).not.toContainEqual({ serverName: "other" });
    expect(o.settings?.deniedMcpServers).not.toContainEqual({ serverName: "obsidian" });
  });

  test("with fast startup (strict MCP) no deny list is needed", () => {
    claudeAdapter.createSession({ ...OPTS, fastStartup: true }).dispose();
    const o = lastOptions();
    expect(o.strictMcpConfig).toBe(true);
    expect(o.settings).toBeUndefined();
  });

  test("passes the enriched PATH and the MCP idle timeout to the CLI", () => {
    claudeAdapter.createSession(OPTS).dispose();
    const o = lastOptions();
    expect(o.env?.PATH).toBe("/enriched");
    expect(o.env?.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT).toBeTruthy();
  });
});
