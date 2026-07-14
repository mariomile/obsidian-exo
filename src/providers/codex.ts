import { spawn, type ChildProcess } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type {
  AgentEvent,
  AgentSession,
  ContextUsage,
  ImageAttachment,
  ModelOption,
  ProviderAdapter,
  SessionOpts,
} from "./types";

/** File extension for an image attachment's media type (codex -i needs a path). */
function imageExt(mediaType: string): string {
  const m = /^image\/(png|jpe?g|gif|webp)$/i.exec(mediaType);
  const sub = m?.[1]?.toLowerCase() ?? "png";
  return sub === "jpeg" ? "jpg" : sub;
}

/** GPT-5-family input context window — the ring's denominator for Codex.
 *  A constant, not per-model: close enough for a fill gauge, and the JSONL
 *  stream doesn't report the window size. */
const CODEX_CONTEXT_WINDOW = 272_000;

/** TOML inline-table override that registers the bridge as codex's `obsidian`
 *  MCP server. Values are TOML basic strings — escape backslashes and quotes. */
export function codexMcpOverride(b: { port: number; token: string; scriptPath: string }): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return (
    `mcp_servers.obsidian={command="node",args=["${esc(b.scriptPath)}"],` +
    `env={EXO_BRIDGE_PORT="${b.port}",EXO_BRIDGE_TOKEN="${esc(b.token)}"}}`
  );
}

export interface CodexParseState {
  sessionId?: string;
  streamed: boolean;
  finalText: string;
}

/**
 * Parse one JSONL line from `codex exec --json` and emit AgentEvents.
 * Handles both the current schema (0.142+: thread.started / item.* / turn.*)
 * and the legacy one ({msg:{type:...}}) so older CLIs keep working.
 */
export function handleCodexLine(
  line: string,
  state: CodexParseState,
  onEvent: (e: AgentEvent) => void,
): void {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  const topType = String(obj.type ?? "");

  if (topType === "thread.started" && typeof obj.thread_id === "string") {
    state.sessionId = obj.thread_id;
    return;
  }

  if (topType === "turn.failed") {
    const err = (obj.error ?? {}) as Record<string, unknown>;
    if (typeof err.message === "string") onEvent({ kind: "error", message: err.message });
    return;
  }

  if (topType === "turn.completed") {
    // `usage.input_tokens` counts the FULL prompt of this turn (system +
    // transcript + tools), so input+output approximates current context
    // occupancy — good enough to drive the context ring for Codex too.
    const usage = (obj.usage ?? {}) as Record<string, unknown>;
    const input = Number(usage.input_tokens ?? 0);
    const output = Number(usage.output_tokens ?? 0);
    if (input > 0) {
      onEvent({ kind: "usage", usage: { used: input + output, total: CODEX_CONTEXT_WINDOW } });
    }
    return;
  }

  if (topType === "item.started" || topType === "item.completed") {
    const item = (obj.item ?? {}) as Record<string, unknown>;
    const itemType = String(item.type ?? "");
    const id = String(item.id ?? "cx");
    const done = topType === "item.completed";

    if (itemType === "agent_message" && done && typeof item.text === "string") {
      onEvent({ kind: "text-delta", text: state.streamed ? `\n\n${item.text}` : item.text });
      state.streamed = true;
    } else if (itemType === "reasoning" && done && typeof item.text === "string") {
      onEvent({ kind: "thinking-delta", text: item.text });
    } else if (itemType === "command_execution") {
      if (done) {
        onEvent({
          kind: "tool-call-result",
          id,
          ok: Number(item.exit_code ?? 0) === 0,
          output: String(item.aggregated_output ?? ""),
        });
      } else {
        onEvent({ kind: "tool-call-start", id, name: "Bash", input: { command: String(item.command ?? "") } });
      }
    } else if (itemType === "file_change") {
      const changes = Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : [];
      const ok = item.status !== "failed";
      for (const c of changes) {
        const path = String(c.path ?? "");
        if (done) onEvent({ kind: "tool-call-result", id: `${id}:${path}`, ok, output: "" });
        else onEvent({ kind: "tool-call-start", id: `${id}:${path}`, name: "Edit", input: { file_path: path } });
      }
    } else if (itemType === "error" && done && typeof item.message === "string") {
      onEvent({ kind: "error", message: item.message });
    }
    return;
  }

  // Legacy schema: {id, session_id, msg:{type:...}}
  const msg = (obj.msg ?? obj) as Record<string, unknown>;
  const type = String(msg.type ?? "");
  const sid = (obj.session_id ?? msg.session_id) as string | undefined;
  if (sid) state.sessionId = sid;

  if (type === "agent_message_delta" && typeof msg.delta === "string") {
    state.streamed = true;
    onEvent({ kind: "text-delta", text: msg.delta });
  } else if (type === "agent_reasoning_delta" && typeof msg.delta === "string") {
    onEvent({ kind: "thinking-delta", text: msg.delta });
  } else if (type === "agent_message" && typeof msg.message === "string") {
    state.finalText = msg.message;
  } else if (type === "exec_command_begin") {
    const id = String(msg.call_id ?? msg.id ?? "cx");
    const command = Array.isArray(msg.command)
      ? (msg.command as unknown[]).join(" ")
      : String(msg.command ?? "");
    onEvent({ kind: "tool-call-start", id, name: "Bash", input: { command } });
  } else if (type === "exec_command_end") {
    const id = String(msg.call_id ?? msg.id ?? "");
    const out = String(msg.aggregated_output ?? msg.stdout ?? msg.output ?? "");
    onEvent({ kind: "tool-call-result", id, ok: Number(msg.exit_code ?? 0) === 0, output: out });
  } else if (type === "patch_apply_begin") {
    const changes = (msg.changes ?? {}) as Record<string, unknown>;
    for (const path of Object.keys(changes)) {
      onEvent({
        kind: "tool-call-start",
        id: `${msg.call_id ?? "patch"}:${path}`,
        name: "Edit",
        input: { file_path: path },
      });
    }
  } else if (type === "patch_apply_end") {
    const changes = (msg.changes ?? {}) as Record<string, unknown>;
    const ok = msg.success !== false;
    for (const path of Object.keys(changes)) {
      onEvent({ kind: "tool-call-result", id: `${msg.call_id ?? "patch"}:${path}`, ok, output: "" });
    }
  } else if (type === "error" && typeof msg.message === "string") {
    onEvent({ kind: "error", message: msg.message });
  }
}

/**
 * Codex session. Codex has no persistent streaming-input protocol wired here,
 * so each turn spawns `codex exec --json`, resuming the prior session id for
 * conversation continuity. Tools run inside Codex's sandbox (workspace-write).
 */
class CodexSession implements AgentSession {
  private child: ChildProcess | null = null;
  private sessionId?: string;

  constructor(private opts: SessionOpts) {
    this.sessionId = opts.resumeSessionId;
  }

  async send(message: string, onEvent: (e: AgentEvent) => void, images?: ImageAttachment[]): Promise<void> {
    const o = this.opts;
    const args = ["exec", "--json", "--skip-git-repo-check", "-C", o.cwd];
    if (this.sessionId) args.splice(1, 0, "resume", this.sessionId);
    // Memory/identity boot (Tranche A parity): Codex has no system-prompt seam,
    // so the preamble rides the session's FIRST turn as a prefixed block — the
    // resumed transcript carries it from then on. Never re-injected on resume.
    if (!this.sessionId && o.memoryPreamble) {
      message = `<boot-context>\n${o.memoryPreamble}\n</boot-context>\n\n${message}`;
    }
    // Images (Tranche A parity): `codex exec -i <file>` on both fresh and
    // resumed prompts. Attachments arrive as base64 — spill to temp files,
    // best-effort cleanup after the child exits.
    const imgPaths: string[] = [];
    for (const [i, img] of (images ?? []).entries()) {
      try {
        const p = join(tmpdir(), `exo-codex-img-${Date.now()}-${i}.${imageExt(img.mediaType)}`);
        await writeFile(p, Buffer.from(img.dataB64, "base64"));
        imgPaths.push(p);
      } catch {
        /* unwritable temp — send the turn without this image */
      }
    }
    for (const p of imgPaths) args.push("-i", p);
    // Sandbox: forced read-only when tools are off; otherwise the chosen mode.
    const sandbox = o.toolsEnabled ? o.sandboxMode || "workspace-write" : "read-only";
    args.push("-s", sandbox);
    // `codex exec` dropped the `-a/--ask-for-approval` flag (removed by 0.142);
    // the config key is the stable way to set the policy across CLI versions.
    if (o.approvalPolicy && /^[a-z-]+$/.test(o.approvalPolicy)) {
      args.push("-c", `approval_policy="${o.approvalPolicy}"`);
    }
    if (o.model && o.model !== "default" && /^[A-Za-z0-9._-]+$/.test(o.model)) args.push("-m", o.model);
    if (o.effort && o.effort !== "default" && /^[a-z]+$/.test(o.effort)) {
      args.push("-c", `model_reasoning_effort="${o.effort}"`);
    }
    if (o.fastStartup) args.push("-c", "mcp_servers={}");
    // Obsidian tools over the loopback bridge. Ordering matters: this comes
    // AFTER the fastStartup blanket `mcp_servers={}` so the obsidian server
    // survives it (later -c overrides win in codex config layering).
    if (o.codexBridge) args.push("-c", codexMcpOverride(o.codexBridge));

    return new Promise<void>((resolve, reject) => {
      const child = spawn(o.cli.bin, args, {
        cwd: o.cwd,
        env: { ...process.env, PATH: o.cli.pathEnv },
      });
      this.child = child;

      let buf = "";
      let stderr = "";
      const state: CodexParseState = { sessionId: this.sessionId, streamed: false, finalText: "" };

      child.on("error", (err) => reject(err));

      child.stdout?.on("data", (chunk: Buffer | string) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          handleCodexLine(line, state, onEvent);
          this.sessionId = state.sessionId;
        }
      });

      child.stderr?.on("data", (d: Buffer | string) => (stderr += d.toString()));

      child.on("close", (code) => {
        this.child = null;
        for (const p of imgPaths) void unlink(p).catch(() => {});
        if (code !== 0 && code !== null) {
          const m = stderr.trim() || `codex exited with code ${code}`;
          onEvent({ kind: "error", message: m });
          // Don't hard-reject on non-zero (e.g. interrupted) — end the turn.
        }
        if (!state.streamed && state.finalText) onEvent({ kind: "text-delta", text: state.finalText });
        onEvent({ kind: "turn-end", sessionId: this.sessionId });
        resolve();
      });

      child.stdin?.on("error", () => {
        /* broken pipe — handled via close */
      });
      child.stdin?.write(message);
      child.stdin?.end();
    });
  }

  interrupt(): void {
    try {
      this.child?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    this.interrupt();
  }

  async contextUsage(): Promise<ContextUsage | null> {
    return null;
  }
}

export const codexAdapter: ProviderAdapter = {
  id: "codex",
  displayName: "Codex",
  brandColor: "#19c37d",

  models(): ModelOption[] {
    // Verified via `codex debug models` on codex-cli 0.144.1 (checked 2026-07-10),
    // in catalog priority order. Users can also type any custom model id in settings.
    return [
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
      { id: "gpt-5.5", label: "GPT-5.5" },
      { id: "gpt-5.4", label: "GPT-5.4" },
      { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
    ];
  },

  createSession(opts: SessionOpts): AgentSession {
    return new CodexSession(opts);
  },
};
