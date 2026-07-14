import type { ResolvedCli } from "../cli";

export type ProviderId = "claude" | "codex";

export interface ModelOption {
  id: string; // value passed to the CLI ("" / "default" = CLI default)
  label: string;
}

/** Permission decision returned to the CLI for a tool-use request (Phase 2). */
export type PermissionDecision =
  | { behavior: "allow"; remember?: boolean }
  | { behavior: "deny"; message?: string };

export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";

/**
 * Normalized event stream produced by every provider adapter, so the chat UI is
 * provider-agnostic. Phase 1 emits text-delta / turn-end / error; the tool and
 * permission events are wired in Phase 2.
 */
export type AgentEvent =
  | { kind: "text-delta"; text: string }
  | { kind: "thinking-delta"; text: string }
  | { kind: "tool-call-start"; id: string; name: string; input: unknown; parentId?: string }
  | { kind: "tool-call-result"; id: string; ok: boolean; output: string; parentId?: string }
  | {
      kind: "permission-request";
      id: string;
      tool: string;
      input: unknown;
      resolve: (d: PermissionDecision) => void;
    }
  | { kind: "usage"; usage: ContextUsage }
  | { kind: "compact"; summary?: string }
  | { kind: "rate-limit"; status: RateStatus; utilization?: number; resetsAt?: number; windowType?: string }
  | { kind: "turn-end"; sessionId?: string }
  | { kind: "error"; message: string };

export type RateStatus = "allowed" | "allowed_warning" | "rejected";

/** Latest Claude-plan quota snapshot, derived from the SDK's `rate_limit_event`
 *  (claude.ai subscription sessions only — API-key users never receive one).
 *  `utilization` is passed through as the SDK reports it (a 0-1 fraction in
 *  practice); `core/rate-limit.ts` normalizes it. `resetsAt` is the SDK's raw
 *  epoch (seconds in practice), also normalized downstream. */
export interface RateLimitInfo {
  status: RateStatus;
  utilization?: number;
  resetsAt?: number;
  windowType?: string;
}

export interface ContextUsage {
  used: number;
  total: number;
  /** Estimated session cost in USD, when the provider/SDK exposes it. Claude
   *  only, via an experimental SDK control request; omitted (not zero) when
   *  unavailable — the UI must degrade gracefully, never show a fake $0.00. */
  costUsd?: number;
}

/** An image attached to a user turn (base64), for multimodal input. */
export interface ImageAttachment {
  mediaType: string; // e.g. "image/png"
  dataB64: string; // base64, no data: prefix
  name?: string;
}

/** Everything fixed for the lifetime of a conversation session. */
export interface SessionOpts {
  cli: ResolvedCli;
  /** Model id, or "" / "default" for the CLI's configured default. */
  model: string;
  /** Reasoning effort: "default" | low | medium | high | xhigh | max. */
  effort: string;
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** Working directory for the agent — the vault root. */
  cwd: string;
  permissionMode: PermissionMode;
  /** Whether tools (Read/Write/Edit/Bash/…) are enabled at all. */
  toolsEnabled: boolean;
  /** Skip external MCP servers for faster cold start. */
  fastStartup: boolean;
  /** Run Claude Code hooks (.claude/settings.json). CC parity — on by default. */
  runHooks?: boolean;
  /** Resume a prior on-disk session id when (re)creating the session. */
  resumeSessionId?: string;
  /** In-process Obsidian MCP server (createSdkMcpServer return). Claude only. */
  obsidianServer?: unknown;
  /** Disable built-in file tools so the agent uses Obsidian-native ones. */
  nativeFirst?: boolean;
  /** Vault `_system/` memory preamble appended to the system prompt. */
  memoryPreamble?: string;
  /** Auto-compact the conversation when the context window fills (token saver). */
  autoCompact?: boolean;
  /** Codex sandbox: read-only | workspace-write | danger-full-access. */
  sandboxMode?: string;
  /** Codex approval policy: untrusted | on-request | on-failure | never. */
  approvalPolicy?: string;
  /** Codex ↔ Obsidian tools bridge (Tranche B1): loopback executor coordinates
   *  + the generated stdio script path. Present only for Codex sessions with
   *  obsidian tools enabled. */
  codexBridge?: { port: number; token: string; scriptPath: string };
}

/** Capability snapshot from the CLI's `system/init` message — the real skills /
 *  commands / agents / MCP servers this session sees (global + plugin + vault),
 *  far beyond what a vault-folder scan can discover. Emitted by CLI ≥2.1.199 in
 *  streaming-input mode too; older CLIs never deliver it (treat as enrichment,
 *  never a gate). */
export interface SessionCaps {
  skills: string[];
  commands: string[];
  agents: string[];
  mcpServers: { name: string; status: string }[];
}

/**
 * A live conversation. For Claude this wraps a single long-lived SDK `query()`
 * in streaming-input mode — follow-up turns reuse the same process/context
 * (no per-message cold start). For Codex it spawns `codex exec` per turn.
 */
export interface AgentSession {
  /** Latest capability snapshot (see SessionCaps); null until init arrives. */
  caps?: SessionCaps | null;
  /** Latest Claude-plan quota snapshot (see RateLimitInfo); null until (and
   *  unless) a `rate_limit_event` arrives — only claude.ai subscription
   *  sessions ever get one. Stored so a view can read it after switching tabs. */
  rateLimit?: RateLimitInfo | null;
  /** Invoked once when the init snapshot lands (may be before the first send). */
  onCaps?: ((caps: SessionCaps) => void) | null;
  /** Send one user turn; resolves when that turn completes. */
  send(message: string, onEvent: (e: AgentEvent) => void, images?: ImageAttachment[]): Promise<void>;
  /** Inject a user message into the in-flight turn (mid-turn steering, Claude
   *  Code parity). Returns true when it was accepted into a running turn, false
   *  when there's nothing to steer or the provider can't steer this input (caller
   *  should queue instead). The provider owns the capability contract: Codex has
   *  no steer at all, and Claude declines when `images` are attached (steer is
   *  text-only). Claude only. */
  steer?(text: string, images?: ImageAttachment[]): boolean;
  /** Interrupt the in-flight turn. */
  interrupt(): void;
  /** Compact the conversation context (best-effort; Claude supports /compact).
   *  Optional free-text `instructions` steer what the compaction summary keeps
   *  (appended to the /compact slash command). */
  compact?(instructions?: string): void;
  /** Change the permission mode live (Claude); used by the plan-mode toggle. */
  setPermissionMode?(mode: PermissionMode): void;
  /** Tear down the session (kills any live process). */
  dispose(): void;
  /** Current context-window usage, if the provider exposes it. */
  contextUsage(): Promise<ContextUsage | null>;
  /** W0 cost governance: input_tokens + output_tokens from the most recently
   *  completed turn, if the provider exposes it (Claude only — synchronous,
   *  no control round-trip, unlike `contextUsage()`). */
  lastTurnTokens?(): number | null;
}

export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  /** Fixed brand accent, theme-independent. */
  brandColor: string;
  models(): ModelOption[];
  createSession(opts: SessionOpts): AgentSession;
}
