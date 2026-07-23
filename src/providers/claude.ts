import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEvent,
  AgentSession,
  ContextUsage,
  ModelOption,
  ProviderAdapter,
  SessionOpts,
} from "./types";

/** Built-in file tools disabled in "native-first" mode (use Obsidian tools). */
const NATIVE_FIRST_DISALLOW = ["Read", "Grep", "Glob", "LS", "Edit", "MultiEdit", "Write", "NotebookEdit"];

/** Fixed house rule prepended to the system-prompt append: Exo already renders
 *  every touched file as chips under each turn, so the agent restating them in
 *  prose duplicates the native UI. Kept to one short paragraph (cache-friendly). */
const EXO_HOUSE_RULES =
  'Exo renders every file you read, create, or edit as chips below your message. ' +
  'Do NOT restate them as a prose list, a "Files touched"/"File toccati" section, ' +
  'or a details/accordion — it duplicates the native UI.';

/**
 * A persistent Claude conversation: one long-lived SDK `query()` driven in
 * streaming-input mode. Follow-up turns push into the same input stream, so the
 * CLI process and context stay warm — no per-message cold start.
 */
type UserContent = string | Array<Record<string, unknown>>;

class ClaudeSession implements AgentSession {
  private q: Query;
  // Pending user messages fed into the live streaming-input generator. `priority:
  // "now"` marks a mid-turn steer (injected into the running turn) vs a normal
  // message that opens a fresh turn.
  private queue: { role: "user"; content: UserContent; priority?: "now" }[] = [];
  private wake: (() => void) | null = null;
  private disposed = false;
  /** True once the SDK message stream has ended (CLI process gone). A dead session
   *  can never emit a `result`, so sends against it must fail fast instead of
   *  parking forever (the view drops the session and the next message starts fresh). */
  private ended = false;
  private onEvent: ((e: AgentEvent) => void) | null = null;
  /** Latest system/init capability snapshot (skills/commands/agents/MCP). */
  caps: import("./types").SessionCaps | null = null;
  onCaps: ((caps: import("./types").SessionCaps) => void) | null = null;
  /** Latest Claude-plan quota snapshot from `rate_limit_event`. Stored so a late
   *  reader (tab switch) can render the badge without a fresh event. */
  rateLimit: import("./types").RateLimitInfo | null = null;
  private resolveTurn: (() => void) | null = null;
  private rejectTurn: ((e: unknown) => void) | null = null;
  private sessionId?: string;
  /** task_id → launching Workflow tool_use_id. task_updated events carry no
   *  tool_use_id, so the binding from task_started resolves them; doubles as
   *  the "this task IS a workflow" gate for task_progress. */
  private workflowTasks = new Map<string, string>();
  private permSeed = 0;
  /** Force-deny callback for an in-flight permission request, so interrupt/dispose
   *  unblock the SDK (otherwise parked waiting for canUseTool to resolve → turn hangs). */
  private denyPending: (() => void) | null = null;
  /** Per-turn tail of CLI stderr lines, surfaced when a turn ends in an error whose
   *  `result` is empty (e.g. error_during_execution). Cleared at the start of send(). */
  private stderrTail: string[] = [];
  /** True once WE interrupted the in-flight turn (Stop button, watchdog, dispose).
   *  The CLI reports any SDK interrupt as an `error_during_execution` result even
   *  though the process and session survive (verified on CLI 2.1.195–2.1.218:
   *  its clean-abort classification only covers aborted_streaming/aborted_tools,
   *  and an SDK interrupt lands outside both windows). This flag lets route()
   *  tell a requested abort from a genuine mid-turn failure. Cleared per send(). */
  private interruptRequested = false;
  /** input_tokens + output_tokens from the most recently completed turn's
   *  `result` message (W0 cost governance — real per-turn spend, not a strlen
   *  guess). Synchronous the instant `send()` resolves, unlike `contextUsage()`
   *  which is an async control round-trip that can race a short-lived
   *  utility session's `dispose()`. `null` until a `result` with `usage` arrives. */
  private lastResultUsage: { inputTokens: number; outputTokens: number } | null = null;

  constructor(opts: SessionOpts) {
    this.sessionId = opts.resumeSessionId;
    const self = this;
    async function* input(): AsyncGenerator<{
      type: "user";
      message: { role: "user"; content: UserContent };
      parent_tool_use_id: null;
      priority?: "now" | "next" | "later";
    }> {
      while (!self.disposed) {
        if (self.queue.length === 0) {
          await new Promise<void>((r) => (self.wake = r));
          if (self.disposed) return;
        }
        // Split the SDK-visible message from Exo's private `priority` marker so
        // the marker never leaks into MessageParam.
        const { priority, ...message } = self.queue.shift()!;
        yield { type: "user", message, parent_tool_use_id: null, ...(priority ? { priority } : {}) };
      }
    }

    this.q = query({
      // The generator yields structurally-valid SDKUserMessages, but our internal
      // UserContent (`Array<Record<string, unknown>>`, built in send() where image
      // blocks carry `media_type: string`) is intentionally looser than the SDK's
      // strict `MessageParam.content` (`ContentBlockParam[]` with a media-type
      // union) — so it's a downcast to the streaming-input type the SDK expects,
      // not `any`.
      prompt: input() as AsyncIterable<SDKUserMessage>,
      options: {
        cwd: opts.cwd,
        // Load filesystem settings (CLAUDE.md + .claude/settings.json) explicitly —
        // parity with the bare Claude Code CLI. Pinned rather than relying on the
        // SDK's implicit "omitted = load all" default, which has flipped between SDK
        // majors: this keeps CLAUDE.md honored on ANY vault, even one with no
        // memory scaffold at all. Must include "project" for CLAUDE.md (SDK docs).
        settingSources: ["user", "project", "local"],
        ...(opts.model && opts.model !== "default" ? { model: opts.model } : {}),
        ...(opts.effort && opts.effort !== "default"
          ? { effort: opts.effort as "low" | "medium" | "high" | "xhigh" | "max" }
          : {}),
        ...(opts.autoCompact ? { autoCompactEnabled: true } : {}),
        // Adaptive thinking is already the default for supporting models (Opus
        // 4.6+/Fable 5), but those models default the *display* to `omitted`, so
        // thinking-delta events arrive with EMPTY text and the Reasoning block
        // renders blank. Setting `display: "summarized"` only unhides the summary
        // — it does not change whether the model thinks. Harmless on older models.
        thinking: { type: "adaptive", display: "summarized" },
        ...(() => {
          // Use Claude Code's OWN default system prompt (tool discipline,
          // conciseness — which keeps token use down — plan/todo behavior, and a
          // cache-friendly prefix) and APPEND Exo's memory + optional user prompt.
          // Passing a bare string here would REPLACE CC's system prompt, turning the
          // agent into a raw, more verbose Claude that behaves nothing like CC.
          const append = [EXO_HOUSE_RULES, opts.systemPrompt, opts.memoryPreamble].filter(Boolean).join("\n\n");
          return {
            systemPrompt: {
              type: "preset" as const,
              preset: "claude_code" as const,
              ...(append ? { append } : {}),
            },
          };
        })(),
        ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
        pathToClaudeCodeExecutable: opts.cli.bin,
        // Obsidian (a GUI app) doesn't inherit the login-shell PATH, so external
        // MCP stdio servers the CLI spawns (e.g. `npx @playwright/mcp`, plugin
        // `.cjs` runners needing `node`) fail to launch and surface as "isn't
        // connected". Pass the enriched PATH that cli.ts already resolves — the
        // same fix the Codex provider carries (codex.ts). HTTP servers (e.g. a
        // local Thymer port) are unaffected: those fail only when their app is down.
        env: { ...process.env, PATH: opts.cli.pathEnv },
        includePartialMessages: true,
        // Keep a short tail of CLI stderr so an opaque execution error (empty
        // `result`) can still surface actionable detail. Bounded ring buffer.
        stderr: (data: string) => {
          for (const line of data.split("\n")) {
            const t = line.trim();
            if (!t) continue;
            this.stderrTail.push(t.length > 400 ? t.slice(0, 400) + "…" : t);
            if (this.stderrTail.length > 12) this.stderrTail.shift();
          }
        },
        // In-process Obsidian tools (if enabled). strictMcpConfig keeps only
        // this server (no external MCP) for a fast, predictable cold start.
        ...(opts.obsidianServer
          ? {
              mcpServers: {
                obsidian: opts.obsidianServer as import("@anthropic-ai/claude-agent-sdk").McpServerConfig,
              },
            }
          : {}),
        // Hooks are controlled solely by runHooks (CC parity — CC runs hooks by
        // default). Fast startup now only skips external MCP servers.
        ...(opts.runHooks ? {} : { disableAllHooks: true }),
        ...(opts.fastStartup
          ? { strictMcpConfig: true, ...(opts.obsidianServer ? {} : { mcpServers: {} }) }
          : {}),
        ...(opts.toolsEnabled
          ? {
              permissionMode: opts.permissionMode,
              canUseTool: (toolName, toolInput, ctx) =>
                new Promise((resolve) => {
                  const suggestions = ctx?.suggestions;
                  let settled = false;
                  const finish = (d: import("./types").PermissionDecision) => {
                    if (settled) return;
                    settled = true;
                    this.denyPending = null;
                    if (d.behavior === "allow") {
                      resolve({
                        behavior: "allow",
                        updatedInput: toolInput,
                        ...(d.remember && suggestions ? { updatedPermissions: suggestions } : {}),
                      });
                    } else {
                      resolve({ behavior: "deny", message: d.message || "Denied by user." });
                    }
                  };
                  // If the turn is interrupted/disposed while this is pending, deny so the
                  // SDK can unwind and emit a result (instead of parking forever).
                  this.denyPending = () => finish({ behavior: "deny", message: "Interrupted." });
                  this.onEvent?.({
                    kind: "permission-request",
                    id: `perm-${++this.permSeed}`,
                    tool: toolName,
                    input: toolInput,
                    resolve: finish,
                  });
                }),
              // When the Obsidian server is active, ALIAS the built-in
              // AskUserQuestion to our ask_user card UI instead of disallowing it:
              // a disallowedTools entry is treated as a user deny rule, and the
              // permission classifier extends that deny to mcp__obsidian__ask_user
              // (same intent, different tool) — blocking BOTH question paths.
              ...(opts.obsidianServer
                ? {
                    toolAliases: { AskUserQuestion: "mcp__obsidian__ask_user" },
                    ...(opts.nativeFirst ? { disallowedTools: NATIVE_FIRST_DISALLOW } : {}),
                  }
                : {}),
            }
          : // Pure-chat (tools off): use the SDK's `tools: []` switch ("disable all
            // built-in tools") rather than a hand-maintained disallowedTools denylist.
            // A denylist can drift as the SDK adds tools and — worse — a deny is read
            // as a user rule the permission classifier extends to same-intent tools
            // (the exact cascade that silently killed ask_user). `tools: []` can't drift
            // or cascade.
            { tools: [] }),
      },
    });

    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.q as AsyncIterable<ClaudeMsg>) {
        if (this.disposed) break;
        this.route(msg);
      }
      // The stream can complete WITHOUT a `result` for an in-flight turn (CLI
      // process exited mid-turn). Nothing else will ever settle that send() —
      // the view would wait forever with the composer stuck on "streaming".
      // No-op when the turn already settled or on dispose (handles are null).
      this.denyPending?.();
      this.settleTurn(new Error("Claude session ended unexpectedly."));
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.denyPending?.();
      this.onEvent?.({ kind: "error", message: m });
      this.settleTurn(err instanceof Error ? err : new Error(m));
    } finally {
      this.ended = true;
    }
  }

  /** Workflow background-run progress (`system/task_*`). task_started binds
   *  task_id → the launching Workflow tool_use; task_progress carries the
   *  incremental agent roster; task_updated carries the terminal status.
   *  Progress events carry their own tool_use_id, so the binding is also
   *  registered lazily — a missed task_started (e.g. no listener attached at
   *  that moment) doesn't mute the rest of the run. Non-workflow background
   *  tasks (shells) pass through untouched: they never carry
   *  workflow_progress and never enter the binding map. */
  private routeTaskEvent(msg: ClaudeMsg, taskId: string, emit: (e: AgentEvent) => void): void {
    if (msg.subtype === "task_started") {
      if (msg.task_type === "local_workflow" && msg.tool_use_id) {
        this.workflowTasks.set(taskId, msg.tool_use_id);
        emit({ kind: "workflow-progress", toolUseId: msg.tool_use_id, taskId, name: msg.workflow_name, entries: [] });
      }
    } else if (msg.subtype === "task_progress") {
      const toolUseId = msg.tool_use_id ?? this.workflowTasks.get(taskId);
      if (toolUseId && msg.workflow_progress?.length) {
        this.workflowTasks.set(taskId, toolUseId); // lazy binding for task_updated
        emit({ kind: "workflow-progress", toolUseId, taskId, entries: msg.workflow_progress });
      }
    } else if (msg.subtype === "task_updated") {
      const toolUseId = this.workflowTasks.get(taskId);
      if (toolUseId && msg.patch?.status) {
        emit({ kind: "workflow-progress", toolUseId, taskId, entries: [], status: msg.patch.status });
        if (msg.patch.status === "completed" || msg.patch.status === "failed") this.workflowTasks.delete(taskId);
      }
    }
  }

  private route(msg: ClaudeMsg): void {
    if (msg.session_id) this.sessionId = msg.session_id;

    // Capability snapshot — arrives at process start, typically BEFORE the first
    // send (prewarm), so it must be captured ahead of the onEvent guard below.
    if (msg.type === "system" && msg.subtype === "init") {
      this.caps = {
        skills: msg.skills ?? [],
        commands: msg.slash_commands ?? [],
        agents: msg.agents ?? [],
        tools: msg.tools ?? [],
        mcpServers: (msg.mcp_servers ?? []).flatMap((s) =>
          s?.name ? [{ name: s.name, status: s.status ?? "unknown" }] : []
        ),
      };
      this.onCaps?.(this.caps);
      return;
    }

    // Rate-limit snapshot (claude.ai subscription only). Can arrive during
    // prewarm before the first send (onEvent null), so — like the init snapshot —
    // store it unconditionally and emit only when a listener is attached.
    if (msg.type === "rate_limit_event") {
      const info = msg.rate_limit_info;
      if (info && typeof info.status === "string") {
        this.rateLimit = {
          status: info.status,
          utilization: info.utilization,
          resetsAt: info.resetsAt,
          windowType: info.rateLimitType,
        };
        this.onEvent?.({
          kind: "rate-limit",
          status: info.status,
          utilization: info.utilization,
          resetsAt: info.resetsAt,
          windowType: info.rateLimitType,
        });
      }
      return;
    }

    const emit = this.onEvent;
    if (!emit) return;

    if (msg.type === "system" && msg.subtype === "compact_boundary") {
      emit({ kind: "compact", summary: msg.compact_summary });
      return;
    }
    if (msg.type === "system" && msg.task_id && msg.subtype?.startsWith("task_")) {
      this.routeTaskEvent(msg, msg.task_id, emit);
      return;
    }
    if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev?.type === "content_block_delta") {
        if (ev.delta?.type === "text_delta" && ev.delta.text) {
          emit({ kind: "text-delta", text: ev.delta.text });
        } else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
          emit({ kind: "thinking-delta", text: ev.delta.thinking });
        }
      }
    } else if (msg.type === "assistant") {
      // Subagent (Task) tool activity carries the parent Task's tool_use id so the
      // view can nest it under that card instead of rendering flat top-level cards.
      const pid = msg.parent_tool_use_id ?? undefined;
      for (const b of msg.message?.content ?? []) {
        if (b.type === "tool_use") {
          emit({ kind: "tool-call-start", id: b.id ?? "", name: b.name ?? "", input: b.input, parentId: pid });
        }
      }
    } else if (msg.type === "user") {
      const pid = msg.parent_tool_use_id ?? undefined;
      const c = msg.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === "tool_result") {
            emit({
              kind: "tool-call-result",
              id: b.tool_use_id ?? "",
              ok: !b.is_error,
              output: stringifyToolResult(b.content),
              parentId: pid,
            });
          }
        }
      }
    } else if (msg.type === "result") {
      const interrupted = this.interruptRequested;
      this.interruptRequested = false;
      // W0: capture the real per-turn token count synchronously, BEFORE the
      // async contextUsage() round-trip below (which a short-lived utility
      // session may dispose() before it ever resolves).
      this.lastResultUsage = msg.usage
        ? { inputTokens: msg.usage.input_tokens ?? 0, outputTokens: msg.usage.output_tokens ?? 0 }
        : null;
      // A locally-requested interrupt comes back as error_during_execution (see
      // interruptRequested): the session is healthy, so skip the fake "CLI
      // crashed" error and settle the turn quietly like a clean abort.
      const failed = msg.is_error === true || (!!msg.subtype && msg.subtype !== "success");
      if (failed && !(interrupted && msg.subtype === "error_during_execution")) {
        let message = msg.result || `Claude ended: ${msg.subtype}`;
        if (this.stderrTail.length) {
          message += "\n\nCLI stderr (tail):\n" + this.stderrTail.slice(-6).join("\n");
        }
        emit({ kind: "error", message });
      }
      emit({ kind: "turn-end", sessionId: this.sessionId });
      this.settleTurn();
      // Context usage is a control round-trip — fetch after the turn resolves
      // so it never delays the UI; emit when (and if) it returns.
      void this.contextUsage().then((u) => {
        if (u) emit({ kind: "usage", usage: u });
      });
    }
  }

  /** Resolve (or reject) the in-flight turn exactly once and clear its handles. */
  private settleTurn(err?: unknown): void {
    const resolve = this.resolveTurn;
    const reject = this.rejectTurn;
    this.resolveTurn = this.rejectTurn = null;
    if (err !== undefined) reject?.(err);
    else resolve?.();
  }

  send(
    message: string,
    onEvent: (e: AgentEvent) => void,
    images?: import("./types").ImageAttachment[]
  ): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Session disposed."));
    // A dead stream can never answer: fail fast so the view drops this session
    // and the next message starts a fresh one (instead of parking forever — the
    // idle-session variant of this is a pre-warmed CLI that died while idle).
    if (this.ended) return Promise.reject(new Error("Claude session ended — sending again starts a fresh session."));
    // Guard against overlapping turns: a second send() while one is in flight would
    // orphan the first promise (its resolve/reject would be overwritten).
    if (this.resolveTurn) return Promise.reject(new Error("A turn is already in flight."));
    this.stderrTail = []; // per-turn tail — drop any lines from a prior turn
    this.interruptRequested = false; // an old interrupt must not excuse this turn's errors
    this.onEvent = onEvent;
    const content: UserContent =
      images && images.length
        ? [
            ...images.map((img) => ({
              type: "image",
              source: { type: "base64", media_type: img.mediaType, data: img.dataB64 },
            })),
            { type: "text", text: message },
          ]
        : message;
    return new Promise<void>((resolve, reject) => {
      this.resolveTurn = resolve;
      this.rejectTurn = reject;
      this.queue.push({ role: "user", content });
      const w = this.wake;
      this.wake = null;
      w?.();
    });
  }

  /** Mid-turn steering (Claude Code parity): inject a user message into the turn
   *  that's currently in flight instead of opening a new one. Pushes onto the same
   *  streaming-input generator the SDK is actively draining, tagged `priority:
   *  "now"` so the CLI folds it into the running turn. Returns false (caller falls
   *  back to queuing) when there's no in-flight turn or the session can't accept
   *  input — a dead/disposed stream, or no turn to steer.
   *
   *  Safe because this is exactly how `compact()` already pushes a mid-turn user
   *  message, and the SDK's streaming-input contract accepts multiple user
   *  messages during a turn (SDKUserMessage carries a `priority: 'now'|'next'|
   *  'later'` field for precisely this). The in-flight turn's single `result`
   *  still settles the original send()'s promise. */
  steer(text: string, images?: import("./types").ImageAttachment[]): boolean {
    if (this.disposed || this.ended) return false;
    // Steering is text-only — decline when images are attached so the caller falls
    // back to queuing (which sends them as a normal multimodal turn). Keeping this
    // here makes the shared send() path provider-agnostic.
    if (images?.length) return false;
    // Only steer when a turn is actually running; otherwise the caller should
    // send() normally (which opens a fresh turn and tracks its resolve/reject).
    if (!this.resolveTurn) return false;
    this.queue.push({ role: "user", content: [{ type: "text", text }], priority: "now" });
    const w = this.wake;
    this.wake = null;
    w?.();
    return true;
  }

  /** Change the permission mode live (e.g. toggling plan mode). */
  setPermissionMode(mode: import("./types").PermissionMode): void {
    if (this.disposed) return;
    try {
      const p = this.q.setPermissionMode?.(mode);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* ignore */
    }
  }

  /** Trigger conversation compaction via the CLI's /compact command, optionally
   *  steered by free-text instructions.
   *
   *  The Agent SDK exposes NO dedicated compaction method: the `Query` interface
   *  (sdk.d.ts) offers interrupt / setModel / setPermissionMode / setMcpPermission…
   *  / getContextUsage etc., but nothing for compaction. `/compact` is a *local
   *  slash command* the CLI intercepts, so the supported form is to push it as a
   *  user message on the streaming-input queue — with any instructions appended
   *  as `/compact <instructions>` (the same shape the interactive CLI accepts). */
  compact(instructions?: string): void {
    if (this.disposed) return;
    const trimmed = instructions?.trim();
    const content = trimmed ? `/compact ${trimmed}` : "/compact";
    this.queue.push({ role: "user", content });
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  /** Call q.interrupt() and swallow both sync throws and promise rejections
   *  (it rejects when the query has already ended — harmless). */
  private safeInterrupt(): void {
    this.interruptRequested = true;
    try {
      const p = this.q.interrupt?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* ignore */
    }
  }

  interrupt(): void {
    if (this.disposed) return;
    // Unblock a pending permission first so the SDK can unwind and emit a result.
    this.denyPending?.();
    // Only interrupt when a turn is actually running — calling q.interrupt() on an
    // idle/closed transport throws "ProcessTransport is not ready for writing".
    if (this.resolveTurn) this.safeInterrupt();
  }

  dispose(): void {
    if (this.disposed) return; // idempotent — dispose may be called more than once
    this.disposed = true;
    this.denyPending?.();
    try {
      this.wake?.();
    } catch {
      /* ignore */
    }
    // Interrupt only if a turn is in flight (avoids the transport error on idle teardown).
    if (this.resolveTurn) this.safeInterrupt();
    // The pump loop breaks on `disposed` without emitting a result, so settle here
    // to ensure any awaiting send() promise is released.
    this.settleTurn(new Error("Session disposed."));
  }

  /** W0 cost governance: input_tokens + output_tokens from the most recently
   *  completed turn's `result` message, or `null` before any turn has completed
   *  or when that turn's `result` carried no `usage`. Prefer this over
   *  `contextUsage()` for recording a single utility pass's spend — it's
   *  synchronous (no control round-trip) and reflects exactly this turn, not
   *  the whole session's running context-window occupancy. */
  lastTurnTokens(): number | null {
    if (!this.lastResultUsage) return null;
    return this.lastResultUsage.inputTokens + this.lastResultUsage.outputTokens;
  }

  async contextUsage(): Promise<ContextUsage | null> {
    try {
      const u = await this.q.getContextUsage?.();
      if (u && typeof u.totalTokens === "number" && typeof u.maxTokens === "number" && u.maxTokens > 0) {
        const result: ContextUsage = { used: u.totalTokens, total: u.maxTokens };
        // Session cost is an experimental SDK control request — best-effort only.
        // Any failure (older CLI, API-key session without cost data, shape
        // change) must never block or break the context bar; just omit cost.
        try {
          const usage = await this.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.();
          if (typeof usage?.session?.total_cost_usd === "number") {
            result.costUsd = usage.session.total_cost_usd;
          }
        } catch {
          /* cost unavailable — omit silently */
        }
        return result;
      }
    } catch {
      /* not available */
    }
    return null;
  }
}

export const claudeAdapter: ProviderAdapter = {
  id: "claude",
  displayName: "Claude",
  brandColor: "#d97757",

  models(): ModelOption[] {
    // Pinned, verified model IDs (checked 2026-07-03 against the claude-api
    // reference). Add newer ones here as they ship. Users can also type any
    // custom model id in settings.
    return [
      { id: "claude-fable-5", label: "Fable 5" },
      { id: "claude-opus-4-8", label: "Opus 4.8" },
      { id: "claude-opus-4-7", label: "Opus 4.7" },
      { id: "claude-sonnet-5", label: "Sonnet 5" },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
      { id: "claude-haiku-4-5", label: "Haiku 4.5" },
    ];
  },

  createSession(opts: SessionOpts): AgentSession {
    return new ClaudeSession(opts);
  },
};

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
      .join("");
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

interface ClaudeMsg {
  type?: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  result?: string;
  /** Root-level result failure flag. The CLI can emit `subtype: "success"`
   *  together with `is_error: true` (for example when authentication is
   *  missing), so subtype alone is not a reliable success signal. */
  is_error?: boolean;
  compact_summary?: string;
  // Per-turn token usage on the `result` message (SDKResultMessage.usage in the
  // Agent SDK's types — verified against node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts).
  usage?: { input_tokens?: number; output_tokens?: number };
  // rate_limit_event payload (claude.ai subscription sessions only).
  rate_limit_info?: {
    status: import("./types").RateStatus;
    utilization?: number;
    resetsAt?: number;
    rateLimitType?: string;
  };
  // system/task_* background-run progress (workflow runs surface ONLY here —
  // per-agent activity never appears as tool_use events; probe 2026-07-21)
  task_id?: string;
  tool_use_id?: string;
  task_type?: string;
  workflow_name?: string;
  workflow_progress?: import("../core/workflow-progress").WorkflowProgressEntry[];
  patch?: { status?: string };
  // system/init capability snapshot (CLI ≥2.1.199 emits it in streaming-input too)
  skills?: string[];
  slash_commands?: string[];
  agents?: string[];
  tools?: string[];
  mcp_servers?: Array<{ name?: string; status?: string }>;
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
  message?: {
    content?: Array<{
      type?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      is_error?: boolean;
      content?: unknown;
    }>;
  };
}
