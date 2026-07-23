#!/usr/bin/env node
/**
 * Smoke contract test — a RELEASE GATE, not CI. It runs a real (billable) Claude
 * session, so run it by hand before tagging: `pnpm test && pnpm smoke`.
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
 *      tool vanishes;
 *   3. the persistent-session contracts Exo's turn lifecycle leans on (verified
 *      on CLI 2.1.195–2.1.218 — see VERIFIED_CLAUDE_CLI in core/semver.ts):
 *      partial stream deltas arrive (includePartialMessages), `result.usage`
 *      carries per-turn tokens (W0 cost tracking), an SDK interrupt() comes
 *      back classified as `error_during_execution` (what route()'s
 *      interruptRequested flag decodes), and the session SURVIVES the
 *      interrupt (stop ≠ session death — the whole Stop/Esc UX rests on this).
 *
 * …and that a minimal streaming-input turn completes without an error result.
 * When a newer CLI passes all phases, bump VERIFIED_CLAUDE_CLI.maxVerified.
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

function resultErrorDetail(result) {
  const candidates = [
    result?.result,
    ...(Array.isArray(result?.errors) ? result.errors : []),
    ...(Array.isArray(result?.permission_denials) ? result.permission_denials : []),
  ];
  const detail = candidates
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .filter(Boolean)
    .join(" | ")
    .slice(0, 800);
  return detail || "no error detail supplied by Claude CLI";
}

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
    fail(
      `turn ended with an error result: subtype=${result.subtype} is_error=${result.is_error}; ${resultErrorDetail(result)}`
    );
  }
  ok(`turn completed: ${String(result.result).slice(0, 60)}`);

  await phase3(bin, cwd);

  console.log("\n✓ SMOKE PASS");
  process.exit(0);
}

/** Phase 3 — persistent streaming-input session (the shape ClaudeSession uses):
 *  three turns on ONE process. A: trivial, asserts partial deltas + result.usage.
 *  B: long output, interrupt() on the first delta, asserts the result comes back
 *  as `error_during_execution` (route()'s interruptRequested contract). C: a
 *  fresh turn on the SAME session, asserting it survived the interrupt. */
async function phase3(bin, cwd) {
  const queue = [];
  let wake = null;
  let ended = false;
  async function* input() {
    while (!ended) {
      if (queue.length === 0) await new Promise((r) => (wake = r));
      if (ended) return;
      const text = queue.shift();
      if (text == null) continue;
      yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    }
  }
  const send = (text) => {
    queue.push(text);
    const w = wake;
    wake = null;
    w?.();
  };

  const q = query({
    prompt: input(),
    options: {
      model: MODEL,
      systemPrompt: { type: "preset", preset: "claude_code" },
      cwd,
      includePartialMessages: true,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      mcpServers: {},
      strictMcpConfig: true,
      pathToClaudeCodeExecutable: bin,
    },
  });

  const timer = setTimeout(() => fail(`phase 3 timed out after ${(TIMEOUT_MS * 2) / 1000}s`), TIMEOUT_MS * 2);
  let phase = "A";
  let sawDelta = false;
  let interrupted = false;
  let resultA = null;
  let resultB = null;
  let resultC = null;

  send("Reply with exactly: OK");
  try {
    for await (const msg of q) {
      if (msg.type === "stream_event" && msg.event?.type === "content_block_delta") {
        sawDelta = true;
        // First sign of turn B's output → interrupt mid-turn, exactly like Stop/Esc.
        if (phase === "B" && !interrupted) {
          interrupted = true;
          q.interrupt().catch(() => {});
        }
      }
      if (msg.type === "result") {
        if (phase === "A") {
          resultA = msg;
          phase = "B";
          send("Count from 1 to 300, one number per line. Do not stop early.");
        } else if (phase === "B") {
          resultB = msg;
          phase = "C";
          send("Reply with exactly: STILL ALIVE");
        } else {
          resultC = msg;
          break;
        }
      }
    }
  } catch (e) {
    clearTimeout(timer);
    fail(`phase 3 query threw: ${e?.message || e}`);
  }
  clearTimeout(timer);
  ended = true;
  const w = wake;
  wake = null;
  w?.();
  try {
    q.close?.();
  } catch {
    /* ignore */
  }

  if (!sawDelta) fail("no partial stream deltas arrived (includePartialMessages contract)");
  ok("partial stream deltas arrive (includePartialMessages)");

  if (resultA?.subtype !== "success") fail(`phase 3 turn A failed: subtype=${resultA?.subtype}`);
  const usage = resultA.usage;
  if (typeof usage?.input_tokens !== "number" || typeof usage?.output_tokens !== "number") {
    fail("result.usage missing input/output tokens (W0 per-turn cost contract)");
  }
  ok(`result.usage present (in=${usage.input_tokens} out=${usage.output_tokens})`);

  if (!interrupted) fail("turn B produced no deltas to interrupt — cannot verify the interrupt contract");
  if (resultB?.subtype !== "error_during_execution") {
    fail(
      `interrupt was classified as "${resultB?.subtype}" — Exo's route() expects "error_during_execution" ` +
        "(interruptRequested contract). The CLI changed behavior: update route() and VERIFIED_CLAUDE_CLI."
    );
  }
  ok('interrupt() → result subtype "error_during_execution" (route() contract)');

  if (resultC?.subtype !== "success" || !/STILL ALIVE/i.test(String(resultC.result))) {
    fail(
      `session did NOT survive the interrupt (turn C: subtype=${resultC?.subtype}) — ` +
        "the Stop/Esc UX assumes the session lives on."
    );
  }
  ok("session survived the interrupt (turn C completed on the same process)");
}

main().catch((e) => fail(e?.message || String(e)));
