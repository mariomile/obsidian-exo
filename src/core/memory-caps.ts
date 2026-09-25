/**
 * The one owner of "what can memory do right now".
 *
 * Every memory call site (tool registry, boot preamble, capture, recall, UI)
 * asks `memoryCaps(settings, env)` instead of reading the raw flags, so a rule
 * like "headless runs never write memory" or "a read-only Codex sandbox gets no
 * write tools" lives in exactly one place. Pure: no Obsidian import.
 */

/** The settings this module reads. A structural slice of `MVASettings`, so
 *  tests can pass a literal. */
export interface MemorySettings {
  memoryReadEnabled: boolean;
  memoryWriteEnabled: boolean;
  agentFolderEnabled: boolean;
  autoMemory: boolean;
  backgroundPassesEnabled: boolean;
}

/** Where the capability is being asked for. */
export interface MemoryEnv {
  /** "chat" = an interactive conversation (or the plugin itself, for capture);
   *  "headless" = an unattended automation/playbook run, which reads memory but
   *  never writes it. */
  surface: "chat" | "headless";
  /** Codex read-only sandbox: bridge writes bypass the sandbox, so none are offered. */
  readOnlySandbox?: boolean;
}

export interface MemoryCaps {
  /** Read vault memory (context, preferences, rules, loops) into the boot preamble. */
  bootRead: boolean;
  /** Prepend the agent folder (SOUL/USER/NOW) to the boot preamble. */
  identity: boolean;
  /** Explicit ledger writes: `capture_decision`, `open_loop`, `close_loop`, and
   *  the setup/seed commands. */
  ledgerWrite: boolean;
  /** `rethink_memory` on the agent folder. */
  rethink: boolean;
  /** Memory harvest: after a chat goes idle, extract facts and write them into notes. */
  autoCapture: boolean;
  /** Per-turn recall: related notes and past chats injected before each message. */
  autoRecall: boolean;
  /** `recent_chats`: read the plugin's own conversation store. */
  chatSearch: boolean;
  /** `undo_memory_write`: revert a harvest. */
  undo: boolean;
}

export function memoryCaps(s: MemorySettings, env: MemoryEnv): MemoryCaps {
  const interactive = env.surface === "chat";
  const write = s.memoryWriteEnabled && interactive && !env.readOnlySandbox;
  return {
    bootRead: s.memoryReadEnabled,
    identity: s.memoryReadEnabled && s.agentFolderEnabled,
    ledgerWrite: write,
    rethink: write && s.agentFolderEnabled,
    autoCapture: s.autoMemory && s.memoryWriteEnabled && s.backgroundPassesEnabled && interactive,
    autoRecall: s.autoMemory && s.memoryReadEnabled && interactive,
    chatSearch: s.memoryReadEnabled,
    undo: write,
  };
}
