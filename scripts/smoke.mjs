#!/usr/bin/env node
/**
 * Smoke contract test — a RELEASE GATE, not CI. It runs a real (billable) Claude
 * session, so run it by hand before tagging: `npm test && npm run smoke`.
 *
 * It deliberately does NOT import plugin source: `src/*` pulls in `obsidian`,
 * which won't load under plain node. Instead it drives
 * `@anthropic-ai/claude-agent-sdk` directly — the SAME dependency version the
 * plugin bundles — to verify the two contracts the plugin leans on hardest:
 *
 *   1. the `claude` binary resolves and `--version` succeeds;
 *   2. a per-session `createSdkMcpServer`'s tool is actually registered — the
 *      init/system message must list it. This guards the whole
 *      "createSdkMcpServer instances bind to their first query() session" class
 *      of regression, where the server silently fails to attach and every custom
 *      tool vanishes.
 *
 * …and that a minimal streaming-input turn completes without an error result.
 *
 * Exit code 0 = pass, 1 = fail, with clear console output either way.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const TIMEOUT_MS = 120_000;
// Cheapest model allowed by the owner's standing rule (never Haiku for our own
// workflows). Sonnet 4-6 is the floor here.
const MODEL = "claude-sonnet-4-6";
const DUMMY_TOOL = "mcp__smoke__ping";

const ok = (m) => console.log(`✓ ${m}`);
const fail = (m) => {
  console.error(`✗ SMOKE FAIL: ${m}`);
  process.exit(1);
};

/** Minimal inline binary resolution (can't import src/cli.ts — it pulls obsidian). */
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const home = homedir();
  for (const c of [
    `${home}/.claude/local/claude`,
    `${home}/.local/bin/claude`,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ]) {
    if (existsSync(c)) return c;
  }
  return "claude"; // fall back to PATH
}

function probeVersion(bin) {
  return new Promise((resolve) => {
    try {
      const c = spawn(bin, ["--version"], { env: process.env });
      let out = "";
      c.stdout.on("data", (d) => (out += d.toString()));
      c.on("error", () => resolve(null));
      c.on("close", (code) => {
        const m = out.match(/\d+\.\d+\.\d+[\w.-]*/);
        resolve(code === 0 && m ? m[0] : null);
      });
      setTimeout(() => {
        try {
          c.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve(null);
      }, 10_000);
    } catch {
      resolve(null);
    }
  });
}

async function* singleUserMessage(text) {
  yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

async function main() {
  // 1. Binary resolves + --version.
  const bin = resolveClaudeBin();
  ok(`resolved claude binary: ${bin}`);
  const version = await probeVersion(bin);
  if (!version) fail(`\`${bin} --version\` did not report a version`);
  ok(`claude --version -> ${version}`);

  // 2. Per-session MCP server with one dummy tool.
  const server = createSdkMcpServer({
    name: "smoke",
    version: "0.0.0",
    tools: [
      tool("ping", "Smoke-test dummy tool.", { value: z.string() }, async () => ({
        content: [{ type: "text", text: "pong" }],
      })),
    ],
  });

  const cwd = mkdtempSync(join(tmpdir(), "exo-smoke-"));
  let sawDummyTool = false;
  let result = null;

  const q = query({
    prompt: singleUserMessage("Reply with exactly: OK"),
    options: {
      model: MODEL,
      systemPrompt: { type: "preset", preset: "claude_code" },
      mcpServers: { smoke: server },
      strictMcpConfig: true,
      cwd,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 1,
      pathToClaudeCodeExecutable: bin,
    },
  });

  const timer = setTimeout(() => fail(`timed out after ${TIMEOUT_MS / 1000}s`), TIMEOUT_MS);
  try {
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        const tools = Array.isArray(msg.tools) ? msg.tools : [];
        const servers = Array.isArray(msg.mcp_servers) ? msg.mcp_servers.map((s) => s.name) : [];
        if (tools.includes(DUMMY_TOOL) || servers.includes("smoke")) sawDummyTool = true;
      }
      if (msg.type === "result") {
        result = msg;
        break;
      }
    }
  } catch (e) {
    clearTimeout(timer);
    fail(`query threw: ${e?.message || e}`);
  }
  clearTimeout(timer);
  try {
    q.close?.();
  } catch {
    /* ignore */
  }

  if (!sawDummyTool) {
    fail("init message did not list the per-session dummy MCP tool (createSdkMcpServer-per-session regression)");
  }
  ok("init message registered the per-session MCP tool");

  if (!result) fail("no result message received");
  if (result.subtype !== "success" || result.is_error) {
    fail(`turn ended with an error result: subtype=${result.subtype} is_error=${result.is_error}`);
  }
  ok(`turn completed: ${String(result.result).slice(0, 60)}`);

  console.log("\n✓ SMOKE PASS");
  process.exit(0);
}

main().catch((e) => fail(e?.message || String(e)));
