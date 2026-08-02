import { spawn, type ChildProcess } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type {
  AgentEvent,
  AgentSession,
  ContextUsage,
  ImageAttachment,
  SessionCaps,
  SessionOpts,
} from "./types";

type RpcId = number | string;
type RpcMessage = {
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ThreadItem = {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  changes?: { path?: string; kind?: string }[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
};

const EXO_HOUSE_RULES =
  'Exo renders every file you read, create, or edit as chips below your message. ' +
  'Do NOT restate them as a prose list, a "Files touched"/"File toccati" section, ' +
  "or a details/accordion — it duplicates the native UI.";

const REQUEST_TIMEOUT_MS = 20_000;
const TURN_START_TIMEOUT_MS = 30_000;

export interface CodexSessionRuntime {
  spawn: typeof spawn;
  requestTimeoutMs: number;
  turnStartTimeoutMs: number;
}

const DEFAULT_RUNTIME: CodexSessionRuntime = {
  spawn,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  turnStartTimeoutMs: TURN_START_TIMEOUT_MS,
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function imageExt(mediaType: string): string {
  const match = /^image\/(png|jpe?g|gif|webp)$/i.exec(mediaType);
  const sub = match?.[1]?.toLowerCase() ?? "png";
  return sub === "jpeg" ? "jpg" : sub;
}

function approvalPolicy(value?: string): unknown {
  if (value === "granular") {
    return {
      granular: {
        sandbox_approval: true,
        rules: true,
        skill_approval: true,
        request_permissions: true,
        mcp_elicitations: true,
      },
    };
  }
  if (value === "untrusted" || value === "never") return value;
  // app-server removed the legacy on-failure variant. Keep its conservative
  // intent by upgrading it to the interactive policy.
  return "on-request";
}

function mcpOverride(bridge: { port: number; token: string; scriptPath: string }): string {
  const esc = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return (
    `mcp_servers.obsidian={command="node",args=["${esc(bridge.scriptPath)}"],` +
    `env={EXO_BRIDGE_PORT="${bridge.port}",EXO_BRIDGE_TOKEN="${esc(bridge.token)}"},` +
    "startup_timeout_sec=10,tool_timeout_sec=3600}"
  );
}

/** Persistent rich-client Codex transport. One app-server process owns one
 * conversation thread and stays warm across turns. */
export class CodexSession implements AgentSession {
  private child: ChildProcess | null = null;
  private threadId?: string;
  private activeTurnId?: string;
  private onEvent: ((event: AgentEvent) => void) | null = null;
  private onTurnComplete: (() => void) | null = null;
  private onTurnFailure: ((error: Error) => void) | null = null;
  private requestId = 0;
  private pending = new Map<RpcId, PendingRequest>();
  private approvalCancels = new Map<RpcId, () => void>();
  private stdoutBuffer = "";
  private stderrTail: string[] = [];
  private disposed = false;
  private ended = false;
  private turnInFlight = false;
  private interruptRequested = false;
  private streamedAgentItems = new Set<string>();
  private imagePaths: string[] = [];
  private usage: ContextUsage | null = null;
  private turnTokens: number | null = null;
  private ready: Promise<void>;
  private runtime: CodexSessionRuntime;
  private mcpStatuses = new Map<string, string>();

  caps: SessionCaps | null = null;
  onCaps: ((caps: SessionCaps) => void) | null = null;

  constructor(private opts: SessionOpts, runtime: Partial<CodexSessionRuntime> = {}) {
    this.runtime = { ...DEFAULT_RUNTIME, ...runtime };
    this.threadId = opts.resumeSessionId;
    this.ready = this.start();
    // Prewarm failures are delivered by send(); keep an early catch attached so
    // an idle tab never creates an unhandled rejection.
    void this.ready.catch(() => {});
  }

  private async start(): Promise<void> {
    const args = ["app-server", "--listen", "stdio://"];
    if (this.opts.fastStartup || !this.opts.toolsEnabled) args.push("-c", "mcp_servers={}");
    if (!this.opts.runHooks) args.push("-c", "features.hooks=false");
    if (!this.opts.toolsEnabled) {
      args.push(
        "-c", "features.shell_tool=false",
        "-c", "features.unified_exec=false",
        "-c", "features.multi_agent=false",
        "-c", 'web_search="disabled"',
      );
    }
    // Later overrides win: the native Obsidian bridge survives Fast startup.
    if (this.opts.toolsEnabled && this.opts.codexBridge) {
      args.push("-c", mcpOverride(this.opts.codexBridge));
    }

    try {
      const child = this.runtime.spawn(this.opts.cli.bin, args, {
        cwd: this.opts.cwd,
        env: { ...process.env, PATH: this.opts.cli.pathEnv },
      });
      this.child = child;
      child.stdout?.on("data", (chunk: Buffer | string) => this.consume(chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer | string) => this.captureStderr(chunk.toString()));
      child.stdin?.on("error", () => { /* close/error owns reporting */ });
      child.on("error", (error) => this.failTransport(error));
      child.on("close", (code, signal) => {
        if (this.disposed || this.ended) return;
        const detail = this.stderrTail.join("\n").trim();
        this.failTransport(new Error(
          detail || `codex app-server exited (code ${code ?? "null"}, signal ${signal ?? "none"})`,
        ));
      });

      await this.request("initialize", {
        clientInfo: { name: "exo_obsidian", title: "Exo for Obsidian", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
      this.notify("initialized", {});

      const developerInstructions = [EXO_HOUSE_RULES, this.opts.systemPrompt, this.opts.memoryPreamble]
        .filter(Boolean)
        .join("\n\n");
      const params: Record<string, unknown> = {
        ...(this.threadId ? { threadId: this.threadId } : {}),
        cwd: this.opts.cwd,
        approvalPolicy: approvalPolicy(this.opts.approvalPolicy),
        approvalsReviewer: "user",
        sandbox: this.opts.toolsEnabled ? this.opts.sandboxMode || "workspace-write" : "read-only",
        ...(this.opts.model && this.opts.model !== "default" ? { model: this.opts.model } : {}),
        ...(developerInstructions ? { developerInstructions } : {}),
      };
      const response = record(await this.request(this.threadId ? "thread/resume" : "thread/start", params));
      const thread = record(response.thread);
      if (typeof thread.id !== "string" || !thread.id) {
        throw new Error("Codex app-server did not return a thread id.");
      }
      this.threadId = thread.id;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.failTransport(failure);
      throw failure;
    }
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.route(JSON.parse(line) as RpcMessage);
      } catch {
        // A malformed diagnostic line must not poison the JSONL transport.
      }
    }
  }

  private captureStderr(chunk: string): void {
    for (const line of chunk.split("\n")) {
      const text = line.trim();
      if (!text) continue;
      this.stderrTail.push(text.length > 500 ? `${text.slice(0, 500)}…` : text);
      if (this.stderrTail.length > 16) this.stderrTail.shift();
    }
  }

  private route(message: RpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message || "request failed"}`));
      } else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.routeServerRequest(message);
      return;
    }
    if (message.method) this.routeNotification(message.method, message.params ?? {});
  }

  private routeServerRequest(message: RpcMessage): void {
    const method = message.method ?? "";
    const id = message.id;
    if (id === undefined) return;
    const params = message.params ?? {};
    const commandApproval = method === "item/commandExecution/requestApproval";
    const fileApproval = method === "item/fileChange/requestApproval";
    if (!commandApproval && !fileApproval) {
      this.sendRpc({ id, error: { code: -32601, message: `Unsupported app-server request: ${method}` } });
      return;
    }

    let settled = false;
    const finish = (decision: "accept" | "acceptForSession" | "decline" | "cancel") => {
      if (settled) return;
      settled = true;
      this.approvalCancels.delete(id);
      this.sendRpc({ id, result: { decision } });
    };
    this.approvalCancels.set(id, () => finish("cancel"));
    this.onEvent?.({
      kind: "permission-request",
      id: `codex-${String(id)}`,
      tool: commandApproval ? "Bash" : "Edit",
      input: commandApproval
        ? { command: params.command ?? "", cwd: params.cwd, reason: params.reason }
        : { file_path: params.grantRoot ?? "", reason: params.reason },
      resolve: (decision) => {
        if (decision.behavior === "allow") finish(decision.remember ? "acceptForSession" : "accept");
        else finish("decline");
      },
    });
  }

  private routeNotification(method: string, params: Record<string, unknown>): void {
    if (method === "turn/started") {
      const turn = record(params.turn);
      if (typeof turn.id === "string") this.activeTurnId = turn.id;
      return;
    }
    if (method === "item/agentMessage/delta") {
      const itemId = String(params.itemId ?? "");
      this.streamedAgentItems.add(itemId);
      if (typeof params.delta === "string" && params.delta) {
        this.onEvent?.({ kind: "text-delta", text: params.delta });
      }
      return;
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      if (typeof params.delta === "string" && params.delta) {
        this.onEvent?.({ kind: "thinking-delta", text: params.delta });
      }
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      this.routeItem(record(params.item) as ThreadItem, method === "item/completed");
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const tokenUsage = record(params.tokenUsage);
      const last = record(tokenUsage.last);
      const used = Number(last.totalTokens ?? 0);
      const total = Number(tokenUsage.modelContextWindow ?? 0);
      if (used > 0) this.turnTokens = used;
      if (used > 0 && total > 0) {
        this.usage = { used, total };
        this.onEvent?.({ kind: "usage", usage: this.usage });
      }
      return;
    }
    if (method === "thread/compacted") {
      this.onEvent?.({ kind: "compact" });
      return;
    }
    if (method === "warning") {
      this.onEvent?.({ kind: "notice", message: String(params.message ?? "Codex warning.") });
      return;
    }
    if (method === "mcpServer/startupStatus/updated") {
      const name = typeof params.name === "string" ? params.name : "";
      const raw = typeof params.status === "string" ? params.status : "unknown";
      if (name) {
        this.mcpStatuses.set(name, raw === "ready" ? "connected" : raw);
        this.publishCaps();
      }
      return;
    }
    if (method === "error") {
      const error = record(params.error);
      const message = typeof error.message === "string"
        ? error.message
        : typeof params.message === "string" ? params.message : "Codex app-server error.";
      this.onEvent?.({ kind: "error", message });
      return;
    }
    if (method === "turn/completed") {
      const turn = record(params.turn);
      const status = String(turn.status ?? "");
      if (status === "failed") {
        const error = record(turn.error);
        this.onEvent?.({
          kind: "error",
          message: typeof error.message === "string" ? error.message : "Codex turn failed.",
        });
      } else if (status === "interrupted" && !this.interruptRequested) {
        this.onEvent?.({ kind: "error", message: "Codex turn was interrupted." });
      }
      this.onEvent?.({ kind: "turn-end", sessionId: this.threadId });
      this.finishTurn();
    }
  }

  private routeItem(item: ThreadItem, done: boolean): void {
    const id = item.id || "codex-item";
    if (item.type === "agentMessage") {
      if (done && item.text && !this.streamedAgentItems.has(id)) {
        this.onEvent?.({ kind: "text-delta", text: item.text });
      }
      return;
    }
    if (item.type === "commandExecution") {
      if (done) {
        this.onEvent?.({
          kind: "tool-call-result",
          id,
          ok: item.status === "completed" && Number(item.exitCode ?? 0) === 0,
          output: item.aggregatedOutput ?? "",
        });
      } else {
        this.onEvent?.({ kind: "tool-call-start", id, name: "Bash", input: { command: item.command ?? "", cwd: item.cwd } });
      }
      return;
    }
    if (item.type === "fileChange") {
      for (const change of item.changes ?? []) {
        const path = change.path ?? "";
        this.onEvent?.(done
          ? { kind: "tool-call-result", id: `${id}:${path}`, ok: item.status !== "failed", output: "" }
          : { kind: "tool-call-start", id: `${id}:${path}`, name: "Edit", input: { file_path: path } });
      }
      return;
    }
    if (item.type === "mcpToolCall") {
      const name = `mcp__${item.server ?? "unknown"}__${item.tool ?? "tool"}`;
      this.onEvent?.(done
        ? { kind: "tool-call-result", id, ok: item.status === "completed", output: outputText(item.result ?? item.error) }
        : { kind: "tool-call-start", id, name, input: item.arguments });
    }
  }

  private publishCaps(): void {
    this.caps = {
      skills: this.caps?.skills ?? [],
      commands: this.caps?.commands ?? [],
      agents: this.caps?.agents ?? [],
      tools: this.caps?.tools ?? [],
      mcpServers: [...this.mcpStatuses].map(([name, status]) => ({ name, status })),
    };
    this.onCaps?.(this.caps);
  }

  private sendRpc(message: RpcMessage): void {
    if (this.ended || !this.child?.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.sendRpc({ method, params });
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.ended || !this.child) return Promise.reject(new Error("Codex app-server is not running."));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.runtime.requestTimeoutMs}ms.`));
      }, this.runtime.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.sendRpc({ id, method, params });
    });
  }

  async send(message: string, onEvent: (event: AgentEvent) => void, images?: ImageAttachment[]): Promise<void> {
    if (this.disposed) throw new Error("Session disposed.");
    if (this.turnInFlight) throw new Error("A turn is already in flight.");
    this.turnInFlight = true;
    this.onEvent = onEvent;
    this.interruptRequested = false;
    this.turnTokens = null;
    this.streamedAgentItems.clear();
    try {
      await this.ready;
      if (!this.threadId) throw new Error("Codex thread is not ready.");

      const input: Record<string, unknown>[] = [];
      this.imagePaths = [];
      for (const [index, image] of (images ?? []).entries()) {
        try {
          const path = join(tmpdir(), `exo-codex-img-${Date.now()}-${index}.${imageExt(image.mediaType)}`);
          await writeFile(path, Buffer.from(image.dataB64, "base64"));
          this.imagePaths.push(path);
          input.push({ type: "localImage", path });
        } catch {
          /* unwritable temp — send without this attachment */
        }
      }
      input.push({ type: "text", text: message, text_elements: [] });

      const completion = new Promise<void>((resolve, reject) => {
        this.onTurnComplete = resolve;
        this.onTurnFailure = reject;
      });
      const response = record(await this.request("turn/start", {
        threadId: this.threadId,
        input,
        cwd: this.opts.cwd,
        approvalPolicy: approvalPolicy(this.opts.approvalPolicy),
        approvalsReviewer: "user",
        ...(this.opts.model && this.opts.model !== "default" ? { model: this.opts.model } : {}),
        ...(this.opts.effort && this.opts.effort !== "default" ? { effort: this.opts.effort } : {}),
      }));
      const turn = record(response.turn);
      if (typeof turn.id === "string") this.activeTurnId = turn.id;

      if (!this.activeTurnId) {
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(() => reject(new Error(
            `turn/started timed out after ${this.runtime.turnStartTimeoutMs}ms.`,
          )), this.runtime.turnStartTimeoutMs);
          const poll = () => {
            if (this.activeTurnId) {
              clearTimeout(deadline);
              resolve();
            } else if (!this.ended) setTimeout(poll, 10);
          };
          poll();
        });
      }
      await completion;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!this.ended) this.failTransport(failure);
      throw failure;
    } finally {
      this.turnInFlight = false;
    }
  }

  steer(text: string, images?: ImageAttachment[]): boolean {
    if (this.disposed || this.ended || !this.threadId || !this.activeTurnId || images?.length) return false;
    void this.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: this.activeTurnId,
      input: [{ type: "text", text, text_elements: [] }],
    }).catch((error) => this.onEvent?.({ kind: "error", message: String(error) }));
    return true;
  }

  compact(_instructions?: string): void {
    if (this.disposed || this.ended || !this.threadId || this.activeTurnId) return;
    void this.request("thread/compact/start", { threadId: this.threadId })
      .catch((error) => this.onEvent?.({ kind: "error", message: String(error) }));
  }

  interrupt(): void {
    if (this.disposed || this.ended || !this.threadId || !this.activeTurnId) return;
    this.interruptRequested = true;
    this.cancelApprovals();
    void this.request("turn/interrupt", { threadId: this.threadId, turnId: this.activeTurnId }).catch(() => {});
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelApprovals();
    if (this.threadId && this.activeTurnId) {
      this.sendRpc({
        id: ++this.requestId,
        method: "turn/interrupt",
        params: { threadId: this.threadId, turnId: this.activeTurnId },
      });
    }
    this.rejectPending(new Error("Session disposed."));
    this.finishTurn(new Error("Session disposed."));
    try {
      this.child?.stdin?.end();
      this.child?.kill("SIGTERM");
    } catch { /* ignore */ }
    this.child = null;
    this.ended = true;
    this.cleanupImages();
  }

  async contextUsage(): Promise<ContextUsage | null> {
    return this.usage;
  }

  lastTurnTokens(): number | null {
    return this.turnTokens;
  }

  private finishTurn(error?: Error): void {
    const resolve = this.onTurnComplete;
    const reject = this.onTurnFailure;
    this.onTurnComplete = null;
    this.onTurnFailure = null;
    this.activeTurnId = undefined;
    this.cancelApprovals();
    this.cleanupImages();
    if (error) reject?.(error);
    else resolve?.();
  }

  private cancelApprovals(): void {
    for (const cancel of this.approvalCancels.values()) cancel();
    this.approvalCancels.clear();
  }

  private cleanupImages(): void {
    for (const path of this.imagePaths) void unlink(path).catch(() => {});
    this.imagePaths = [];
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private failTransport(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.rejectPending(error);
    if (this.onTurnComplete || this.onTurnFailure) {
      this.onEvent?.({ kind: "error", message: error.message });
      this.finishTurn(error);
    }
    try {
      this.child?.stdin?.end();
      this.child?.kill("SIGTERM");
    } catch { /* ignore */ }
    this.child = null;
  }
}
