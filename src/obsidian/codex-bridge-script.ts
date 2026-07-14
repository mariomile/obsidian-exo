/**
 * The stdio MCP server codex spawns (written to the plugin dir by main.ts).
 * Dependency-free .mjs: newline-delimited JSON-RPC 2.0 on stdio; forwards
 * tools/list and tools/call to the plugin's loopback executor via fetch
 * (node ≥18 global). Env: EXO_BRIDGE_PORT, EXO_BRIDGE_TOKEN.
 */
export const CODEX_BRIDGE_SCRIPT = `#!/usr/bin/env node
// Exo ↔ Codex obsidian-tools bridge (generated — do not edit; regenerated on plugin load).
const PORT = process.env.EXO_BRIDGE_PORT;
const TOKEN = process.env.EXO_BRIDGE_TOKEN;
const BASE = "http://127.0.0.1:" + PORT;
const HEADERS = { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" };

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
const replyErr = (id, code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });
const errResult = (text) => ({ content: [{ type: "text", text }], isError: true });

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification — ignore
  try {
    if (method === "initialize") {
      reply(id, {
        protocolVersion: (params && params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "exo-obsidian-bridge", version: "1.0.0" },
      });
    } else if (method === "tools/list") {
      const r = await fetch(BASE + "/tools", { headers: HEADERS });
      reply(id, { tools: await r.json() });
    } else if (method === "tools/call") {
      const body = JSON.stringify({ tool: params && params.name, input: (params && params.arguments) || {} });
      const r = await fetch(BASE + "/call", { method: "POST", headers: HEADERS, body });
      reply(id, await r.json());
    } else if (method === "ping") {
      reply(id, {});
    } else {
      replyErr(id, -32601, "Method not found: " + method);
    }
  } catch (e) {
    // Executor unreachable (plugin reloaded?) — degrade as a tool error.
    if (method === "tools/call") reply(id, errResult("Obsidian bridge unreachable: " + (e && e.message)));
    else replyErr(id, -32603, "Bridge error: " + (e && e.message));
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // not JSON — ignore
    }
    void handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
`;
