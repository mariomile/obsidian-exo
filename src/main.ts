import { Editor, FileSystemAdapter, FuzzySuggestModal, MarkdownView, Notice, Plugin, WorkspaceLeaf, addIcon, requestUrl } from "obsidian";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ChatView, VIEW_TYPE, EXO_ICON } from "./view";
import { DEFAULT_SETTINGS, MVASettingTab, type MVASettings } from "./settings";
import { ADAPTERS } from "./providers/registry";
import { resolveCli } from "./cli";
import { InlineEditModal } from "./ui/inline-edit";
import type { AgentEvent } from "./providers/types";
import {
  computePlan,
  applyPlan,
  applyLlmPlan,
  mergeSnapshots,
  undoPlan,
  DreamSnapshotPersistenceError,
  type DreamSnapshot,
} from "./obsidian/dream";
import { runDreamLlm, type DreamLlmResult } from "./obsidian/dream-llm";
import { readUnimportedObservations, advanceAndPersistWatermark } from "./obsidian/claudemem";
import { formatDreamSummary } from "./core/dream-proposals";
import { resetIfNewDay, canSpend, recordSpend } from "./core/background-budget";
import { DreamModal } from "./ui/dream-modal";
import { runHeadlessPlaybook, writeReport } from "./headless";
import { parseConversationsSource } from "./core/persistence";
import { sanitizeTitle } from "./core/title";
import { buildEditPrompt, buildContinuePrompt } from "./core/inline-ai";
import { inlineAiExtension } from "./editor/inline-ai";
import { selectionObserverExtension } from "./editor/selection-observer";
import { WriteQueue } from "./core/write-queue";
import { makeTolerantSetMaxListeners, isTolerantShim } from "./core/node-interop";
import {
  initialAutoCommitState,
  recordVaultWrite,
  isCommitDue,
  shouldCommitNow,
  afterCommitCheck,
  formatCommitMessage,
  type AutoCommitState,
} from "./core/git-autocommit";

const execFileAsync = promisify(execFile);

export default class ExoPlugin extends Plugin {
  settings!: MVASettings;

  /**
   * THE ONE shared write path for every append to the Memory Union Store
   * (`_system/memory/store/`). Plugin-scoped so all store writers — the
   * `remember` tool, the Self-Writing Memory observer (append + undo), and any
   * future dream pass — enqueue on the SAME FIFO and never interleave a
   * read-modify-write cycle (w1-1 contract). Injected into both
   * `createObsidianToolServer` and `MemoryObserver`.
   */
  readonly memoryWriteQueue = new WriteQueue();
  /** Serialize temp/backup rotation for conversation history. Multiple views and
   *  rapid UI updates may call saveConversations concurrently; sharing the same
   *  .tmp path without a queue can regress or temporarily remove the main file. */
  private readonly conversationWriteQueue = new WriteQueue();
  private readonly dreamSnapshotWriteQueue = new WriteQueue();

  /** Git auto-commit safety net — debounce/cadence bookkeeping (in-memory
   *  only; resets on reload, which is fine, it's just scheduling state). */
  private gitAutoCommitState: AutoCommitState = initialAutoCommitState();
  /** Fires at most once per session — repeated failures log to console but
   *  never spam the user with Notices. */
  private gitAutoCommitNoticeShown = false;
  /** Quiet period after a tracked write before a commit check runs (fixed —
   *  keeping this predictable rather than another setting to tune). */
  private static readonly AUTO_COMMIT_DEBOUNCE_MS = 2 * 60 * 1000;
  /** How often the periodic checker ticks. Actual git calls only run when
   *  `isCommitDue` says a debounce or cadence window has elapsed, so most
   *  ticks are a free no-op. */
  private static readonly AUTO_COMMIT_CHECK_INTERVAL_MS = 20 * 1000;

  async onload(): Promise<void> {
    // Electron-renderer interop, BEFORE anything can spawn a session: the Agent
    // SDK hands its (DOM-realm) AbortSignals to Node's events.setMaxListeners,
    // which throws ERR_INVALID_ARG_TYPE in Obsidian's renderer and kills every
    // Claude session at query() setup (first hit: dream-llm, 2026-07-06 — but it
    // breaks chat and headless identically). Mutating the module object is what
    // makes the bundled SDK see the shim (esbuild namespace getters are live).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeEvents = require("node:events") as { setMaxListeners: (n?: number, ...t: unknown[]) => void };
    if (!isTolerantShim(nodeEvents.setMaxListeners)) {
      nodeEvents.setMaxListeners = makeTolerantSetMaxListeners(nodeEvents.setMaxListeners.bind(nodeEvents));
    }

    await this.loadSettings();

    // Exo brand mark — a concave 4-point star (matches the product logo).
    // addIcon wraps this in an svg with viewBox "0 0 100 100".
    addIcon(
      EXO_ICON,
      '<path fill="currentColor" d="M50 3 Q 50 50 97 50 Q 50 50 50 97 Q 50 50 3 50 Q 50 50 50 3 Z"/>'
    );

    this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this));

    // In-note AI: a floating toolbar over the selection (Edit / Continue / Ask
    // Exo). Registered once; gated live behind the `inlineAi` setting, so
    // toggling it off makes the extension inert without a reload.
    this.registerEditorExtension(inlineAiExtension(this));

    // Selection observer: reports the active editor's selection to the composer
    // so it shows an ambient "Selection" chip. Registered once; gated live
    // behind `showSelectionChip`, so toggling it off makes it inert.
    this.registerEditorExtension(selectionObserverExtension(this));

    this.addRibbonIcon(EXO_ICON, "Open Exo", () => this.activateView());

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => this.activateView(),
    });

    const withView = (fn: (v: ChatView) => void) => () => {
      const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
      if (view instanceof ChatView) fn(view);
      else void this.activateView();
    };
    this.addCommand({ id: "new-tab", name: "New tab", callback: withView((v) => v.cmdNewTab()) });
    this.addCommand({
      id: "new-session",
      name: "New session (clear current tab)",
      callback: withView((v) => v.cmdNewSession()),
    });
    this.addCommand({ id: "close-tab", name: "Close current tab", callback: withView((v) => v.cmdCloseTab()) });
    this.addCommand({
      id: "fork-conversation",
      name: "Fork conversation into new tab",
      callback: withView((v) => v.cmdForkConversation()),
    });
    this.addCommand({
      id: "compact",
      name: "Compact conversation (free up context)",
      callback: withView((v) => v.cmdCompact()),
    });
    this.addCommand({
      id: "toggle-plan",
      name: "Toggle plan mode",
      callback: withView((v) => v.cmdTogglePlan()),
    });

    this.addCommand({
      id: "inline-edit",
      name: "Inline edit selection",
      editorCallback: (editor: Editor, ctx) => {
        if (!(ctx instanceof MarkdownView)) return;
        this.inlineEdit(editor);
      },
    });

    this.addCommand({
      id: "memory-dream-pass",
      name: "Run memory dream pass (consolidate _system/memory)",
      callback: () => void this.openDreamPass(),
    });
    this.addCommand({
      id: "memory-dream-undo",
      name: "Undo last memory dream pass",
      callback: async () => {
        const snap = await this.loadDreamSnapshot();
        if (!snap) {
          new Notice("No dream pass to undo.");
          return;
        }
        const n = await undoPlan(this.app, snap);
        await this.clearDreamSnapshot();
        new Notice(`Undid the dream pass — restored ${n} file(s).`);
      },
    });
    // Hourly check; runs a scheduled pass only when due per settings.
    this.registerInterval(window.setInterval(() => void this.maybeScheduledDreamPass(), 60 * 60 * 1000));

    this.addCommand({
      id: "run-playbook",
      name: "Run playbook now (headless, read-only)",
      callback: () => {
        const prompts = this.settings.customPrompts;
        if (!prompts.length) {
          new Notice("No custom prompts yet — add some in Exo settings.");
          return;
        }
        new PlaybookPicker(this.app, prompts, (p) => void this.runPlaybook(p.name, p.prompt)).open();
      },
    });
    this.registerInterval(window.setInterval(() => void this.checkScheduledRuns(), 30 * 60 * 1000));

    // Git auto-commit safety net: ticks frequently, but only ever runs git
    // commands once the pure debounce/cadence decision says a check is due —
    // no-op (and silent) whenever the setting is off, the vault isn't a git
    // repo, or the worktree is clean. See core/git-autocommit.ts.
    this.registerInterval(
      window.setInterval(() => void this.maybeAutoCommit(), ExoPlugin.AUTO_COMMIT_CHECK_INTERVAL_MS)
    );

    this.addSettingTab(new MVASettingTab(this.app, this));

    // Daily, non-blocking Claude-CLI update check (failures silent).
    void this.maybeCheckCliUpdate();
  }

  /**
   * Check npm for a newer Claude CLI, at most once per day. Caches the result in
   * settings (`cliLatestKnown` + `cliUpdateCheckAt`) so the settings tab can show
   * an update button without a network round-trip on every render. Uses
   * Obsidian's `requestUrl` (not node fetch — desktop CSP/proxy safe). Never
   * throws; a failed check just records the attempt so we don't hammer the API.
   */
  async maybeCheckCliUpdate(force = false): Promise<void> {
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    if (!force && this.settings.cliUpdateCheckAt && now - this.settings.cliUpdateCheckAt < DAY) return;
    try {
      const res = await requestUrl({
        url: "https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
      });
      const version = (res.json as { version?: unknown } | undefined)?.version;
      if (typeof version === "string" && version) this.settings.cliLatestKnown = version;
    } catch {
      /* offline / registry down — silent */
    } finally {
      this.settings.cliUpdateCheckAt = now;
      await this.saveSettings();
    }
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
      if (leaf.view instanceof ChatView) leaf.view.focusComposer();
    }
  }

  /**
   * Public cross-plugin entry point: reveal Exo and start a new default-model
   * chat seeded with `query` (sent immediately unless `autoSend` is false).
   * Consumed by sibling plugins — e.g. Sonar's "Search with Exo" row — so they
   * don't have to reach into ChatView internals. Safe to call before the view
   * exists; it's created on demand.
   */
  async askExo(query: string, autoSend = true): Promise<void> {
    await this.activateView();
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    if (view instanceof ChatView) view.askInNewConversation(query, autoSend);
  }

  private vaultPath(): string {
    const a = this.app.vault.adapter;
    return a instanceof FileSystemAdapter ? a.getBasePath() : ".";
  }

  /**
   * Git auto-commit safety net — record that a turn wrote `fileCount` file(s).
   * Called from ChatView at turn end (any turn that touched the write-tool
   * set), regardless of whether the turn succeeded, errored, or was stopped.
   *
   * Purely bookkeeping: synchronous, in-memory, no I/O — so this can never
   * slow down or block a chat turn. The actual `git add`/`git commit` (if
   * ever due) happens later, off a periodic timer (`maybeAutoCommit`), fully
   * decoupled from any turn. No-ops entirely when the setting is off.
   */
  noteVaultWrite(fileCount: number): void {
    if (!this.settings.vaultAutoCommit) return;
    this.gitAutoCommitState = recordVaultWrite(this.gitAutoCommitState, Date.now(), fileCount);
  }

  /**
   * Periodic tick for the git auto-commit safety net (see core/git-autocommit
   * for the pure decision logic). Cheap on every tick that isn't due; only
   * once the debounce (after a write) or cadence (periodic fallback) window
   * has elapsed does this actually shell out to `git`. Fully async and
   * fire-and-forget from the caller — a failure here is caught, logged, and
   * (at most once per session) surfaced as a single Notice; it never throws
   * back into a chat turn because nothing calls this from inside one.
   */
  private async maybeAutoCommit(): Promise<void> {
    if (!this.settings.vaultAutoCommit) return;
    const cwd = this.vaultPath();
    if (cwd === ".") return; // no real filesystem adapter (e.g. mobile) — silent no-op

    const debounceMs = ExoPlugin.AUTO_COMMIT_DEBOUNCE_MS;
    const cadenceMs = Math.max(1, this.settings.vaultAutoCommitIntervalMinutes) * 60 * 1000;
    const now = Date.now();
    // Cheap pure check first — most ticks bail out here with zero git calls.
    if (!isCommitDue(this.gitAutoCommitState, now, debounceMs, cadenceMs)) return;

    try {
      const { isGitRepo, gitAvailable } = await checkGitRepo(cwd);
      const worktreeDirty = isGitRepo && gitAvailable ? await isWorktreeDirty(cwd) : false;
      const pendingFileCount = this.gitAutoCommitState.pendingWriteCount;
      const commit = shouldCommitNow({
        enabled: this.settings.vaultAutoCommit,
        isGitRepo,
        gitAvailable,
        worktreeDirty,
        state: this.gitAutoCommitState,
        now,
        debounceMs,
        cadenceMs,
      });
      if (commit) await runGitCommit(cwd, formatCommitMessage(pendingFileCount));
    } catch (err) {
      // Never let a failed commit break anything — log it and surface at most
      // one Notice ever (repeated failures would otherwise spam every tick).
      console.error("[Exo] git auto-commit failed:", err);
      if (!this.gitAutoCommitNoticeShown) {
        this.gitAutoCommitNoticeShown = true;
        new Notice("Exo: git auto-commit failed once — see the developer console for details.");
      }
    } finally {
      // Whether it committed, found the tree clean, or errored — the check
      // itself happened, so reset the debounce/cadence bookkeeping for the
      // next cycle. (On error, this also prevents a hard-failing repo from
      // being hammered every single tick.)
      this.gitAutoCommitState = afterCommitCheck(this.gitAutoCommitState, now);
    }
  }

  /**
   * Core of every one-shot text transform: a transient, tool-less session that
   * streams `text-delta` chunks to `onDelta` and resolves with the full text.
   * The session is disposed on abort and on completion. Shared by `oneShot`
   * (modal), `oneShotStream` (inline Edit) and `continueStream` (inline
   * Continue) so there's one place that owns the CLI session lifecycle.
   */
  private async runStream(
    prompt: string,
    signal: AbortSignal,
    onDelta: (text: string) => void
  ): Promise<string> {
    const provider = this.settings.provider;
    const bin = provider === "claude" ? this.settings.claudeBin : this.settings.codexBin;
    const cli = await resolveCli(provider, bin);
    const session = ADAPTERS[provider].createSession({
      cli,
      model: provider === "claude" ? this.settings.claudeModel : this.settings.codexModel,
      effort: "default",
      cwd: this.vaultPath(),
      permissionMode: "default",
      toolsEnabled: false, // pure text transform — no tools needed
      fastStartup: true,
    });
    signal.addEventListener("abort", () => {
      try {
        session.dispose();
      } catch {
        /* already torn down */
      }
    });
    let out = "";
    try {
      await session.send(prompt, (e: AgentEvent) => {
        if (e.kind === "text-delta") {
          out += e.text;
          onDelta(e.text);
        }
      });
    } finally {
      session.dispose();
    }
    return out;
  }

  /** One-shot text transform (no streaming): returns the trimmed result. Used by
   *  the legacy inline-edit modal. */
  private async oneShot(instruction: string, text: string, signal: AbortSignal): Promise<string> {
    return (await this.runStream(buildEditPrompt(instruction, text), signal, () => {})).trim();
  }

  /** Streaming Edit: rewrite `text` per `instruction`, emitting live chunks via
   *  `onDelta`. Resolves with the full (untrimmed — the diff needs raw text)
   *  result. Used by the in-note floating toolbar's Edit action. */
  async oneShotStream(
    instruction: string,
    text: string,
    signal: AbortSignal,
    onDelta: (text: string) => void
  ): Promise<string> {
    return this.runStream(buildEditPrompt(instruction, text), signal, onDelta);
  }

  /** Streaming Continue: keep writing from `precedingText`, emitting live chunks
   *  via `onDelta`. Resolves with the continuation only. Used by the in-note
   *  Continue action. */
  async continueStream(
    precedingText: string,
    signal: AbortSignal,
    onDelta: (text: string) => void
  ): Promise<string> {
    return this.runStream(buildContinuePrompt(precedingText), signal, onDelta);
  }

  /** Reveal the Exo chat and seed the given selection as a quoted context block
   *  in the composer, then focus it — the in-note "Ask Exo" action. */
  async attachSelectionToChat(text: string, sourcePath: string): Promise<void> {
    await this.activateView();
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    if (view instanceof ChatView) view.attachSelection(text, sourcePath);
  }

  /** Forward the active editor's current selection to the open chat view so it
   *  renders an ambient "Selection" chip in the composer (`text=""` clears it).
   *  Unlike `attachSelectionToChat`, this never reveals/activates the view — it's
   *  passive ambient state: if no ChatView is open there's simply nothing to show. */
  reportSelection(text: string, sourcePath: string): void {
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    if (view instanceof ChatView) view.setCurrentSelection(text, sourcePath);
  }

  /** Generate a concise 3-6 word chat title with Haiku. ALWAYS runs on the Claude
   *  CLI (its own model), regardless of the conversation's provider — a cheap,
   *  latency-sensitive one-liner. Transient, tool-less session (same shape as
   *  `oneShot`). Never throws: if the Claude CLI can't be resolved or the call
   *  errors/aborts/times out it resolves to "" and the caller keeps the truncated
   *  placeholder. An internal 15s timeout (plus the caller's `signal`) guarantees
   *  a hung call can't leak. */
  async generateTitle(userText: string, assistantText: string, signal: AbortSignal): Promise<string> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort);
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const cli = await resolveCli("claude", this.settings.claudeBin);
      const session = ADAPTERS.claude.createSession({
        cli,
        model: "claude-haiku-4-5", // product default — cheap/fast one-liner
        effort: "default",
        cwd: this.vaultPath(),
        permissionMode: "default",
        toolsEnabled: false, // title only — no tools
        fastStartup: true,
      });
      ctrl.signal.addEventListener("abort", () => {
        try {
          session.dispose();
        } catch {
          /* already torn down */
        }
      });
      // Cap the input (~1500 chars total) so the call stays cheap and fast.
      const user = userText.replace(/\s+/g, " ").trim().slice(0, 800);
      const asst = assistantText.replace(/\s+/g, " ").trim().slice(0, 700);
      const prompt =
        "Write a short, specific title for this chat. Rules: 3-6 words, plain text only, " +
        "no surrounding quotes, no backticks, no trailing punctuation, and no preamble " +
        '(never "Chat about…", "Title:", etc). Return ONLY the title.\n\n' +
        `User: ${user}\n\nAssistant: ${asst}`;
      let out = "";
      try {
        await session.send(prompt, (e: AgentEvent) => {
          if (e.kind === "text-delta") out += e.text;
        });
      } finally {
        session.dispose();
      }
      return sanitizeTitle(out);
    } catch {
      return ""; // CLI missing / errored / aborted — keep the placeholder
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Run a prompt on a cheap, transient, tool-less Claude CLI session (same
   * lifecycle shape as {@link generateTitle}). The reusable chassis behind every
   * background utility pass — the Self-Writing Memory observer and the Dream Pass
   * v2 LLM stage. Returns the raw model text, or "" on any failure — never throws,
   * aborts silently. A hard timeout plus the caller's `signal` guarantees a hung
   * call can't leak.
   *
   * @param opts.model    Cheap model id (defaults to Haiku — the observer's model
   *                      by product policy; the dream stage passes a Sonnet id).
   * @param opts.timeoutMs Hard ceiling (default 15s).
   * @param opts.onUsage  W0 cost governance: invoked once with the real
   *                      input+output token count for this call, read from the
   *                      session synchronously right after `send()` resolves
   *                      (before dispose) — see `ClaudeSession.lastTurnTokens()`.
   *                      Never invoked if the provider doesn't expose it.
   */
  async runUtilityPass(
    prompt: string,
    opts: { signal: AbortSignal; model?: string; timeoutMs?: number; onUsage?: (tokens: number) => void }
  ): Promise<string> {
    // Model floor is Sonnet (product policy: never Haiku for background
    // passes) — default to the W0 backgroundModel setting, not a hardcoded id.
    const { signal, timeoutMs = 15_000, onUsage } = opts;
    const model = opts.model || this.settings.backgroundModel || "claude-sonnet-5";
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort);
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const cli = await resolveCli("claude", this.settings.claudeBin);
      const session = ADAPTERS.claude.createSession({
        cli,
        model,
        effort: "default",
        cwd: this.vaultPath(),
        permissionMode: "default",
        toolsEnabled: false, // read-only extraction — no tools
        fastStartup: true,
      });
      ctrl.signal.addEventListener("abort", () => {
        try {
          session.dispose();
        } catch {
          /* already torn down */
        }
      });
      let out = "";
      try {
        await session.send(prompt, (e: AgentEvent) => {
          if (e.kind === "text-delta") out += e.text;
        });
        // Read BEFORE dispose — contextUsage() is an async control round-trip
        // that a disposed session may never resolve; lastTurnTokens() is
        // populated synchronously by the `result` message that just settled
        // send() above.
        const tokens = session.lastTurnTokens?.();
        if (typeof tokens === "number") onUsage?.(tokens);
      } finally {
        session.dispose();
      }
      return out;
    } catch (err) {
      // Caller treats "" as no-op, but NEVER swallow the reason silently —
      // an instantly-empty utility pass is indistinguishable from a healthy
      // empty answer without this line (bit us on the first dream-llm run).
      console.warn("[Exo] utility pass failed:", err);
      return "";
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Rough fallback estimate (chars/4-equivalent order of magnitude) for the
   *  observer's budget pre-check and for `recordBackgroundSpend` when the
   *  provider's real per-turn token count (`lastTurnTokens`) isn't available. */
  private static readonly OBSERVER_TOKEN_ESTIMATE = 1500;

  /** Back-compat thin wrapper around the observer chassis. Kept so
   *  ChatView keeps calling `runObserver(prompt, signal)` with unchanged behavior.
   *
   *  Callers gate with `canRunObserver()` before dispatch. This method records the
   *  real per-turn token count from the SDK result (or a bounded fallback) exactly
   *  once after the call. */
  async runObserver(prompt: string, signal: AbortSignal): Promise<string> {
    let tokens: number | null = null;
    const out = await this.runUtilityPass(prompt, {
      signal,
      timeoutMs: 90_000, // long-transcript extraction can exceed the 15s default
      onUsage: (t) => {
        tokens = t;
      },
    });
    this.recordBackgroundSpend(tokens ?? ExoPlugin.OBSERVER_TOKEN_ESTIMATE);
    return out;
  }

  canRunObserver(): boolean {
    return this.checkBackgroundBudget(ExoPlugin.OBSERVER_TOKEN_ESTIMATE);
  }

  private inlineEdit(editor: Editor): void {
    const selection = editor.getSelection();
    const text = selection || editor.getLine(editor.getCursor().line);
    if (!text.trim()) {
      new Notice("Select some text (or place the cursor on a non-empty line) to edit.");
      return;
    }
    const hadSelection = selection.length > 0;
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const line = editor.getCursor().line;
    new InlineEditModal(this.app, text, (instr, t, sig) => this.oneShot(instr, t, sig), (next) => {
      if (hadSelection) {
        editor.replaceRange(next, from, to);
      } else {
        editor.replaceRange(next, { line, ch: 0 }, { line, ch: editor.getLine(line).length });
      }
    }).open();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Migrate the old "Default" model option (empty id — silently let the CLI's
    // own default apply): the picker no longer offers an ambiguous unlabeled
    // state, so an empty saved id resolves to that provider's first real model.
    if (!this.settings.claudeModel) this.settings.claudeModel = ADAPTERS.claude.models()[0].id;
    if (!this.settings.codexModel) this.settings.codexModel = ADAPTERS.codex.models()[0].id;
    // Seed a few example reusable prompts on first run (once) so "Your prompts"
    // isn't empty. They're editable/deletable in Settings; never re-seeded.
    if (!this.settings.seededPrompts && this.settings.customPrompts.length === 0) {
      this.settings.customPrompts = [
        { name: "Distill", prompt: "Distill this note to its 3 core ideas, each as one crisp sentence." },
        { name: "Devil's advocate", prompt: "Argue the strongest case against the main claim in this note." },
        { name: "Next actions", prompt: "Turn this note into a short checklist of concrete next actions." },
      ];
      this.settings.seededPrompts = true;
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private convoFile(): string {
    return `${this.manifest.dir}/conversations.json`;
  }

  /**
   * Persisted conversation history (separate from settings/data.json).
   *
   * Recovery-aware: reads the main file AND its `.bak` rotation, then defers the
   * trust decision to the pure `parseConversationsSource`. When the main file
   * exists but is corrupt it is NEVER deleted — it's renamed aside as
   * `<file>.corrupt-<epoch>` for forensics, and the user is told whether history
   * was recovered from backup or lost.
   */
  async loadConversations(): Promise<unknown[]> {
    const adapter = this.app.vault.adapter;
    const p = this.convoFile();
    const bak = `${p}.bak`;
    const readOrNull = async (path: string): Promise<string | null> => {
      try {
        return (await adapter.exists(path)) ? await adapter.read(path) : null;
      } catch {
        return null;
      }
    };
    const mainRaw = await readOrNull(p);
    const bakRaw = await readOrNull(bak);
    const { data, source, mainCorrupt } = parseConversationsSource(mainRaw, bakRaw);
    if (mainCorrupt) {
      // Preserve the corrupt file — never start silently empty over a bad file.
      try {
        if (await adapter.exists(p)) await adapter.rename(p, `${p}.corrupt-${Date.now()}`);
      } catch {
        /* best effort — recovery still proceeds */
      }
      new Notice(
        source === "bak"
          ? "Exo recovered conversation history from a backup — the main file was corrupted (kept for recovery)."
          : "Exo couldn't read conversation history — the file was corrupted and no usable backup existed (kept for recovery)."
      );
    }
    return data;
  }

  /**
   * Atomic, backup-rotating write. Returns false (never throws) if it failed, so
   * callers can surface it. Sequence — at no intermediate step are BOTH the main
   * file and its `.bak` missing/incomplete:
   *   1. write the payload to `<file>.tmp` (main + bak stay intact)
   *   2. rotate the current main file to `<file>.bak` (one generation)
   *   3. rename `.tmp` over the main path
   */
  async saveConversations(data: unknown[]): Promise<boolean> {
    // Snapshot the payload at call time; the caller's arrays keep mutating while
    // this request waits behind earlier saves.
    const json = JSON.stringify(data);
    return this.conversationWriteQueue.enqueue(async () => {
      const adapter = this.app.vault.adapter;
      const p = this.convoFile();
      const tmp = `${p}.tmp`;
      const bak = `${p}.bak`;
      try {
        // 1. Stage the new content. A crash here leaves main (and bak) untouched.
        await adapter.write(tmp, json);
        // 2. Rotate the live main file to .bak before replacing it. Rename can't
        //    overwrite an existing target on every platform, so clear the old bak
        //    first. Main is still present throughout this step.
        if (await adapter.exists(p)) {
          if (await adapter.exists(bak)) await adapter.remove(bak);
          await adapter.rename(p, bak);
        }
        // 3. Move the staged file over the (now absent) main path.
        await adapter.rename(tmp, p);
        return true;
      } catch {
        // Drop a stray tmp so a half-written file can't be mistaken for real data.
        try {
          if (await adapter.exists(tmp)) await adapter.remove(tmp);
        } catch {
          /* ignore */
        }
        return false;
      }
    });
  }

  private dreamFile(): string {
    return `${this.manifest.dir}/dream-snapshot.json`;
  }
  async saveDreamSnapshot(s: DreamSnapshot): Promise<boolean> {
    const json = JSON.stringify(s);
    return this.dreamSnapshotWriteQueue.enqueue(async () => {
      try {
        await this.app.vault.adapter.write(this.dreamFile(), json);
        return true;
      } catch {
        return false;
      }
    });
  }

  private async requireDreamSnapshot(s: DreamSnapshot): Promise<void> {
    if (!(await this.saveDreamSnapshot(s))) throw new DreamSnapshotPersistenceError();
  }
  async loadDreamSnapshot(): Promise<DreamSnapshot | null> {
    try {
      const p = this.dreamFile();
      if (await this.app.vault.adapter.exists(p)) return JSON.parse(await this.app.vault.adapter.read(p)) as DreamSnapshot;
    } catch {
      /* corrupt/missing */
    }
    return null;
  }
  async clearDreamSnapshot(): Promise<void> {
    try {
      const p = this.dreamFile();
      if (await this.app.vault.adapter.exists(p)) await this.app.vault.adapter.remove(p);
    } catch {
      /* ignore */
    }
  }
  /**
   * Manual dream pass: compute the deterministic plan, optionally run the Dream
   * Pass v2 LLM proposal stage (when `dreamLlmEnabled`), and open the preview
   * modal. Nothing mutates until the user clicks Apply.
   */
  private async openDreamPass(): Promise<void> {
    const plan = computePlan(this.app);
    const llm = await this.maybeRunDreamLlm();
    new DreamModal(this.app, plan, llm, async () => {
      const ranAt = new Date().toISOString();
      let snap = await applyPlan(this.app, plan, ranAt, (partial) => this.requireDreamSnapshot(partial));

      if (llm && (llm.writePlan.storeEntries.length || llm.writePlan.ruleDrafts.length)) {
        const llmSnap = await applyLlmPlan(
          this.app,
          llm.writePlan,
          this.memoryWriteQueue,
          ranAt,
          (partial) => this.requireDreamSnapshot(mergeSnapshots(snap, partial))
        );
        snap = mergeSnapshots(snap, llmSnap);
        // Watermark advances ONLY on apply (never on propose/preview).
        if (llm.writePlan.importedIds.length) {
          await advanceAndPersistWatermark(this.app, this.memoryWriteQueue, llm.writePlan.importedIds, ranAt);
        }
        // Persist applied keys so the next run's gate culls duplicates.
        this.settings.appliedProposalKeys = [...this.settings.appliedProposalKeys, ...llm.writePlan.keys].slice(-500);
        await this.saveSettings();
        // Descriptive memory commit (Letta context-repositories).
        await this.commitDreamApply(formatDreamSummary(llm.writePlan.summary));
      }

      await this.requireDreamSnapshot(snap);
      const s = llm?.writePlan.summary;
      const llmBit = s ? `; LLM: merged ${s.merged}, superseded ${s.superseded}, drafts ${s.ruleDrafts}, imported ${s.imported}` : "";
      new Notice(
        `Dream pass: ${plan.promote.length} promoted, ${plan.dedup.length} merged, ${plan.stale.length} marked stale${llmBit}. Undo from the command palette.`
      );
    }).open();
  }

  /**
   * Run the Dream Pass v2 LLM proposal stage, or null when it should not run
   * (toggle off, non-Claude provider, or the background budget is exhausted —
   * checked BEFORE the LLM call). Never throws.
   */
  private async maybeRunDreamLlm(): Promise<DreamLlmResult | null> {
    const s = this.settings;
    if (!s.dreamLlmEnabled) return null;
    if (s.provider !== "claude") return null;

    // W0 budget: check BEFORE the LLM call.
    const estimate = 8000;
    if (!this.checkBackgroundBudget(estimate)) {
      console.info("[Exo] dream-llm skipped: background budget exhausted or disabled.");
      return null;
    }

    try {
      const controller = new AbortController();
      const observations = await readUnimportedObservations(this.app, {
        projects: s.claudememProjects,
        limit: 100,
      });
      const result = await runDreamLlm({
        app: this.app,
        // Generating a full proposal batch over store+learnings+observations
        // takes far longer than the 15s utility default — give it real room.
        runUtilityPass: (p, o) => this.runUtilityPass(p, { ...o, timeoutMs: 300_000 }),
        queue: this.memoryWriteQueue,
        observations,
        appliedKeys: new Set(s.appliedProposalKeys),
        memoryFileBudget: s.memoryFileBudget,
        signal: controller.signal,
        now: Date.now(),
        session: "dream",
        model: s.backgroundModel,
      });
      // Record spend (rough estimate: prompt overhead + output length).
      this.recordBackgroundSpend(estimate + Math.ceil((result.raw?.length ?? 0) / 4));
      return result;
    } catch (err) {
      console.warn("[Exo] dream-llm stage failed (no-op):", err);
      return null;
    }
  }

  /** Roll the daily ledger and answer whether a background pass may spend `estimate`.
   *  Not `private`: the observer-cadence step passes (view.ts, W2-3) gate through
   *  this same W0 ledger as the dream-LLM stage does. */
  checkBackgroundBudget(estimate: number): boolean {
    const s = this.settings;
    const now = Date.now();
    s.backgroundBudgetLedger = resetIfNewDay(s.backgroundBudgetLedger, now);
    return canSpend(s.backgroundBudgetLedger, estimate, {
      enabled: s.backgroundPassesEnabled,
      dailyBudget: s.backgroundDailyTokenBudget,
      now,
    });
  }

  /** Add `tokens` to the daily background ledger and persist. Not `private` —
   *  see {@link checkBackgroundBudget}. */
  recordBackgroundSpend(tokens: number): void {
    const s = this.settings;
    s.backgroundBudgetLedger = recordSpend(s.backgroundBudgetLedger, tokens, Date.now());
    void this.saveSettings();
  }

  /** Fire one descriptive git commit for an applied dream pass. Gated on the same
   *  opt-in git safety-net setting; a no-op when the vault isn't a git repo. */
  private async commitDreamApply(summary: string): Promise<void> {
    if (!this.settings.vaultAutoCommit) return;
    const cwd = this.vaultPath();
    if (cwd === ".") return;
    try {
      const { isGitRepo, gitAvailable } = await checkGitRepo(cwd);
      if (isGitRepo && gitAvailable) await runGitCommit(cwd, formatCommitMessage(undefined, summary));
    } catch (err) {
      console.error("[Exo] dream commit failed:", err);
    }
  }

  /** Epoch ms of the most recent `exo: auto-commit` in the vault's git log, or
   *  null when it can't be determined (not a repo, git missing, no such commit).
   *  Read-only, never throws — same execFile discipline as the auto-commit path.
   *  Used by the Actions hub (W2-UX) to show the last auto-commit time; the panel
   *  calls it once per open and async-fills, so a slow git call never blocks render. */
  async lastAutoCommitEpoch(): Promise<number | null> {
    const cwd = this.vaultPath();
    if (cwd === ".") return null;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["log", "-1", "--format=%ct", "--grep", "exo: auto-commit"],
        { cwd }
      );
      const secs = parseInt(stdout.trim(), 10);
      return Number.isFinite(secs) ? secs * 1000 : null;
    } catch {
      return null;
    }
  }

  private async maybeScheduledDreamPass(): Promise<void> {
    const sched = this.settings.dreamPassSchedule;
    if (sched === "off") return;
    const now = Date.now();
    const period = sched === "daily" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    if (this.settings.lastDreamPass && now - this.settings.lastDreamPass < period) return;
    const plan = computePlan(this.app);
    if (plan.promote.length + plan.dedup.length + plan.stale.length === 0) {
      this.settings.lastDreamPass = now;
      await this.saveSettings();
      return;
    }
    try {
      const ranAt = new Date().toISOString();
      const snap = await applyPlan(this.app, plan, ranAt, (partial) => this.requireDreamSnapshot(partial));
      await this.requireDreamSnapshot(snap);
    } catch (err) {
      console.error("[Exo] scheduled dream pass failed:", err);
      new Notice(err instanceof Error ? err.message : "Scheduled dream pass failed; see the developer console.");
      return;
    }
    this.settings.lastDreamPass = now;
    await this.saveSettings();
    new Notice(
      `Scheduled dream pass: ${plan.promote.length} promoted, ${plan.dedup.length} merged, ${plan.stale.length} stale. Undo from the command palette.`
    );
  }

  /** Run one playbook headlessly and write its report. */
  private async runPlaybook(name: string, prompt: string): Promise<void> {
    if (/\{\{\s*[\w-]+\s*\}\}/.test(prompt)) {
      new Notice(`"${name}" has {{variables}} — run it from the composer instead.`);
      return;
    }
    new Notice(`Running playbook "${name}"…`);
    const result = await runHeadlessPlaybook(this.app, this.settings, prompt);
    const path = await writeReport(this.app, name, result);
    new Notice(
      result.ok ? `Playbook "${name}" done → ${path}` : `Playbook "${name}" failed (report: ${path})`
    );
  }

  /** Run any scheduled playbooks that are due (off by default — empty list). */
  private async checkScheduledRuns(): Promise<void> {
    const lines = this.settings.scheduledRuns.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const now = Date.now();
    for (const line of lines) {
      const i = line.lastIndexOf("|");
      if (i < 0) continue;
      const name = line.slice(0, i).trim();
      const cadence = line.slice(i + 1).trim().toLowerCase();
      const period = cadence === "daily" ? 20 * 60 * 60 * 1000 : cadence === "weekly" ? 6.5 * 24 * 60 * 60 * 1000 : 0;
      if (!period || !name) continue;
      const p = this.settings.customPrompts.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!p) continue;
      const last = this.settings.scheduledLastRun[p.name] ?? 0;
      if (now - last < period) continue;
      this.settings.scheduledLastRun[p.name] = now;
      await this.saveSettings();
      await this.runPlaybook(p.name, p.prompt); // sequential — one at a time
    }
  }
}

/* --------------------------- playbook picker --------------------------- */
class PlaybookPicker extends FuzzySuggestModal<{ name: string; prompt: string }> {
  constructor(
    app: import("obsidian").App,
    private prompts: { name: string; prompt: string }[],
    private onPick: (p: { name: string; prompt: string }) => void
  ) {
    super(app);
    this.setPlaceholder("Run a playbook (read-only, report to _system/reports/)…");
  }
  getItems(): { name: string; prompt: string }[] {
    return this.prompts;
  }
  getItemText(p: { name: string; prompt: string }): string {
    return p.name;
  }
  onChooseItem(p: { name: string; prompt: string }): void {
    this.onPick(p);
  }
}

/* -------------------- git auto-commit — impure shell -------------------- */
// Argument arrays only, explicit cwd, never a shell string — no interpolation
// of any path or message into a command line. See core/git-autocommit.ts for
// the pure decision logic these merely execute.

/** Best-effort text of a node `child_process` error, for matching known-benign
 *  git outcomes (e.g. "nothing to commit"). Never throws. */
function errText(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const e = err as { message?: unknown; stdout?: unknown; stderr?: unknown };
  return [e.message, e.stdout, e.stderr]
    .filter((x): x is string => typeof x === "string")
    .join("\n");
}

/** Is `cwd` inside a git working tree, and is the `git` binary itself
 *  available? A single `git rev-parse` call answers both: ENOENT means the
 *  binary is missing; any other failure (exit 128, "not a git repository")
 *  means git ran fine but this path isn't a repo. Neither case throws — both
 *  are normal, silent no-op conditions, not failures. */
async function checkGitRepo(cwd: string): Promise<{ isGitRepo: boolean; gitAvailable: boolean }> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    return { isGitRepo: stdout.trim() === "true", gitAvailable: true };
  } catch (err) {
    const code = (err as { code?: unknown } | undefined)?.code;
    if (code === "ENOENT") return { isGitRepo: false, gitAvailable: false }; // git binary not found
    return { isGitRepo: false, gitAvailable: true }; // git ran, just not (cleanly) a repo here
  }
}

/** `git status --porcelain` — non-empty output means the worktree is dirty. */
async function isWorktreeDirty(cwd: string): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
  return stdout.trim().length > 0;
}

/** Stage everything and commit with `message`. A concurrent process (another
 *  Exo tick, a manual commit) can beat us to it between the dirty-check and
 *  here — `git commit` then exits non-zero with "nothing to commit", which is
 *  swallowed as benign; any other failure propagates to the caller. */
async function runGitCommit(cwd: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd });
  try {
    await execFileAsync("git", ["commit", "-m", message], { cwd });
  } catch (err) {
    if (/nothing to commit/i.test(errText(err))) return; // race — benign, silent
    throw err;
  }
}
