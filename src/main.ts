import { Editor, FileSystemAdapter, FuzzySuggestModal, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf, addIcon, requestUrl } from "obsidian";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ChatView, VIEW_TYPE, EXO_ICON } from "./view";
import { DiagLog } from "./core/diag";
import { handoffPrefix } from "./core/handoff";
import { BoardView, BOARD_VIEW_TYPE, BOARD_ICON } from "./ui/board-view";
import { CockpitView, COCKPIT_VIEW_TYPE, COCKPIT_ICON } from "./ui/cockpit-view";
import { DEFAULT_SETTINGS, MVASettingTab, type MVASettings } from "./settings";
import { ADAPTERS } from "./providers/registry";
import { resolveCli, cliDiagnostics, updateClaudeCli } from "./cli";
import { cliVerifyStatus, compareSemver, VERIFIED_CLAUDE_CLI } from "./core/semver";
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
import {
  AGENT_DIR,
  AGENT_BLOCK_NAMES,
  buildSeedPrompt,
  parseSeedBlocks,
  manifestContent,
} from "./core/agent-self";
import { SCAFFOLD_ITEMS, parentFolder } from "./core/vault-setup";
import { readUnimportedObservations, advanceAndPersistWatermark } from "./obsidian/claudemem";
import { formatDreamSummary } from "./core/dream-proposals";
import { resetIfNewDay, canSpend, recordSpend } from "./core/background-budget";
import { DreamModal } from "./ui/dream-modal";
import { runHeadlessPlaybook, writeReport, restoreRun, type HeadlessResult } from "./headless";
import { automationLastRunKey, migrateScheduledRuns, isDue, pruneRuns, type AutomationConfig, type AutomationRunRecord } from "./core/automations";
import { AutomationsModal } from "./ui/automations-modal";
import { drainExoQueue, countPendingQueue } from "./queue";
import { parseConversationsSource } from "./core/persistence";
import { sanitizeTitle } from "./core/title";
import { buildEditPrompt, buildContinuePrompt } from "./core/inline-ai";
import { inlineAiExtension } from "./editor/inline-ai";
import { mentionsExtension } from "./mentions/editor";
import { selectionObserverExtension } from "./editor/selection-observer";
import { WriteQueue } from "./core/write-queue";
import { startCodexBridge, type CodexBridge } from "./obsidian/codex-bridge";
import { CODEX_BRIDGE_SCRIPT } from "./obsidian/codex-bridge-script";
import { promoteToTaskCommandVisible, TASKS_PATH } from "./core/tasks";
import {
  ConvoStateChannel,
  type ConvoState,
  type ConvoStateReason,
  type ConvoStateListener,
  type Unsubscribe,
} from "./core/convo-state";
import { TaskStore, adaptAppToTaskVault } from "./obsidian/task-store";
import { makeTolerantSetMaxListeners, isTolerantShim } from "./core/node-interop";
import {
  ProposalStore,
  type PendingProposals,
  type ProposalAcceptResult,
} from "./obsidian/proposal-store";
import { routeAcceptedProposal, type ProposalAcceptanceDeps } from "./obsidian/proposal-router";
import {
  createProposalAcceptanceDeps,
  OPEN_LOOPS_PATH,
  type ProposalTargetVaultAdapter,
} from "./obsidian/proposal-targets";
import { parseLoopsFile } from "./core/open-loops";
import {
  DailyPulseSlotRunner,
  dailyPulseReviewAfterRun,
  isDailyPulseAutomation,
  seedDailyPulseAutomation,
} from "./core/daily-pulse";
import {
  generateAndWriteDailyPulse,
  DAILY_PULSE_TARGET_PATH,
  type DailyPulseCollectionWarning,
} from "./obsidian/daily-pulse";
import {
  produceTurnProposals,
  type ProposalProducerResult,
  type ProposalTurnInput,
} from "./obsidian/proposal-producer";
import { ProposalsModal } from "./ui/proposals-modal";
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

/** Snapshot-size cap per file in a persisted automation-run record (same bloat
 *  guard as the chat's MAX_CHECKPOINT_FILE — oversized edits aren't restorable). */
const MAX_AUTOMATION_SNAPSHOT = 64_000;

/** Seeded "Morning Digest" playbook — Dia-style: vault + connected external
 *  tools (MCP, read-only). Sources degrade gracefully; the wording keeps the
 *  report short and phone-readable. Editable like any custom prompt. */
const MORNING_DIGEST_PROMPT = `Sei il mio chief of staff. Prepara il MORNING DIGEST di oggi, in italiano, leggibile da telefono: righe corte, liste, niente tabelle. Massimo ~60 righe.

Raccogli dalle fonti in quest'ordine. Se una fonte non è disponibile (tool assente o permesso negato), scrivi "— non disponibile" nella sua sezione e prosegui senza fermarti.

IMPORTANTE: non scrivere NULLA prima del digest — niente premesse, niente narrazione del processo. La tua risposta deve iniziare esattamente con "# ☀️ Morning Digest". Eventuali caveat sulle fonti vanno solo nella riga "Stato fonti" in fondo.

1. VAULT — leggi: _system/memory/open-loops.md (loop attivi e scaduti), _system/orchestration/tasks.md (task running / needs-input / review), conteggio note in _inbox/, la daily note di ieri e di oggi in Journal/Daily/ se esistono.
2. CALENDAR — con i tool MCP di Google Calendar: gli eventi di oggi, con orari.
3. GMAIL — con i tool MCP di Gmail: cerca i thread NON letti o importanti delle ultime 24 ore; riporta al massimo 5: mittente — oggetto — perché conta in una riga.
4. SLACK — con i tool MCP di Slack: mention e messaggi rilevanti delle ultime 24 ore; al massimo 5 conversazioni: canale — sintesi in una riga.
5. LETTURE — con il tool MCP di Readwise (search): 2-3 highlight recenti se disponibili.

Poi scrivi il digest ESATTAMENTE in questo formato:

# ☀️ Morning Digest

## 🎯 Oggi
(agenda essenziale + le 3 priorità che proponi tu, ognuna con un perché di una riga)

## ✅ Da fare
(loop scaduti, task fermi in needs-input/review, "N note in inbox da processare" se >0)

## 📧 Mail da guardare

## 💬 Slack da considerare

## 📚 Letture

---
Stato fonti: (una riga: quali fonti hai letto e quali erano non disponibili)`;

export default class ExoPlugin extends Plugin {
  settings!: MVASettings;

  /** Turn-lifecycle diagnostics ring buffer (see core/diag.ts). The view logs
   *  the critical path into it; "Copy diagnostics" pastes it for bug reports. */
  readonly diag = new DiagLog();

  /** Latest capability snapshot from any session's system/init (pushed by the
   *  view) — lets settings show live per-server MCP status. Best-effort: null
   *  until a session has spawned this app run. */
  lastSessionCaps: import("./providers/types").SessionCaps | null = null;

  /** Codex ↔ Obsidian tools bridge (lazy singleton; stopped on unload). */
  private codexBridge: CodexBridge | null = null;
  private codexBridgeScriptPath: string | null = null;

  /** One-time guard for the codex-bridge node preflight Notice. */
  private nodeWarned = false;
  /** Deferred boot maintenance must never outlive a hot unload/reload. */
  private startupMaintenanceTimer: number | null = null;
  private unloaded = false;

  /** Latest Claude-plan quota snapshot (pushed by the chat view) — the Cockpit
   *  renders it in the System tile. Null for API-key sessions. */
  lastRateLimit: import("./providers/types").RateLimitInfo | null = null;

  /**
   * THE ONE shared write path for every append to the Memory Union Store
   * (`_system/memory/store/`). Plugin-scoped so all store writers — the
   * `remember` tool, the Self-Writing Memory observer (append + undo), and any
   * future dream pass — enqueue on the SAME FIFO and never interleave a
   * read-modify-write cycle (w1-1 contract). Injected into both
   * `createObsidianToolServer` and `MemoryObserver`.
   */
  readonly memoryWriteQueue = new WriteQueue();
  /** One shared write path for `_system/memory/open-loops.md` across every
   *  Claude/Codex conversation. Each session gets a fresh tool registry, so a
   *  queue created inside that registry cannot prevent lost updates. */
  readonly loopsWriteQueue = new WriteQueue();
  /** Serialize temp/backup rotation for conversation history. Multiple views and
   *  rapid UI updates may call saveConversations concurrently; sharing the same
   *  .tmp path without a queue can regress or temporarily remove the main file. */
  private readonly conversationWriteQueue = new WriteQueue();
  /** Settings share one JSON file; serialize snapshots so background update
   *  checks and interactive settings changes cannot race saveData(). */
  private readonly settingsWriteQueue = new WriteQueue();
  private readonly dreamSnapshotWriteQueue = new WriteQueue();
  /**
   * THE ONE shared write path for every append to the Orchestration Board
   * tasks ledger (`_system/orchestration/tasks.md`). Both the `add_task` SDK
   * tool (chat-driven) and the "Promote to task" command enqueue on this SAME
   * queue — same contract as `memoryWriteQueue` above — so board and
   * chat-driven task creation never interleave a read-modify-write cycle.
   * Injected into `createObsidianToolServer` (src/view.ts) and used directly
   * by `ChatView.cmdPromoteToTask`.
   */
  readonly tasksWriteQueue = new WriteQueue();
  /** Single mutation boundary for the plugin-dir proposal inbox. */
  private readonly proposalWriteQueue = new WriteQueue();
  /** Settings mutation + persistence boundary for accepted playbooks. */
  private readonly proposalPlaybookWriteQueue = new WriteQueue();
  /** One serialized read-modify-write boundary for `_system/review.md`. */
  private readonly dailyPulseWriteQueue = new WriteQueue();
  private readonly dailyPulseSlotRunner = new DailyPulseSlotRunner();
  /**
   * THE ONE shared `TaskStore` instance — the typed load/create/update/move/
   * archive API over the same ledger (`_system/orchestration/tasks.md`),
   * built on `tasksWriteQueue` above so it can never race a caller still
   * using the lower-level `createBacklogTask` directly. Constructed in
   * `onload()` (needs `this.app`); the future board view/driver should read
   * and mutate tasks ONLY through this instance.
   */
  taskStore!: TaskStore;
  proposalStore!: ProposalStore;
  private proposalAcceptanceDeps!: ProposalAcceptanceDeps;
  private readonly proposalRouteErrors = new Map<string, string>();
  private readonly proposalAbort = new AbortController();
  private static readonly PROPOSAL_TOKEN_ESTIMATE = 2500;

  /**
   * THE ONE plugin-level convo-state notification channel — how ChatView tells
   * the (optional) Orchestration Board how each conversation's turn lifecycle is
   * moving (turn-start / turn-end / needs-input / stopped / error). Synchronous,
   * in-memory, one-way (board observes; chat never depends on it). Guarded on
   * `orchestrationEnabled`: a strict no-op when the flag is off, so chat runtime
   * behavior is identical to a build without the board. See
   * src/core/convo-state.ts and the isolation contract in
   * docs/superpowers/specs/2026-07-08-orchestration-board-design.md.
   */
  readonly convoState = new ConvoStateChannel(() => this.settings.orchestrationEnabled);

  /** Ribbon-icon handle for the Orchestration Board — created only while
   *  `orchestrationEnabled` is on, removed when it's toggled off, so the entry
   *  point disappears entirely (not just disabled) on hot-disable. */
  private boardRibbonEl: HTMLElement | null = null;
  /** Last-applied orchestration flag, so `saveSettings` can detect a toggle and
   *  re-sync entry points + tear down the board on disable. */
  private orchestrationApplied = false;

  /** Git auto-commit safety net — debounce/cadence bookkeeping (in-memory
   *  only; resets on reload, which is fine, it's just scheduling state). */
  private gitAutoCommitState: AutoCommitState = initialAutoCommitState();
  /** Vault-relative paths written by Exo and eligible for the next commit.
   *  Versions prevent a commit finishing in the background from clearing a
   *  newer write to the same path. Never stage unrelated worktree changes. */
  private readonly gitAutoCommitPaths = new Map<string, number>();
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
    this.unloaded = false;
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
    // Seed the capability snapshot from the last app run, so menus and panels
    // are rich before the first session's init arrives (refreshed on every init).
    this.lastSessionCaps = this.settings.cachedSessionCaps ?? null;

    // ONE shared TaskStore for the whole plugin — built on `tasksWriteQueue` so
    // it can never race the lower-level `createBacklogTask` call in
    // `src/view.ts`/`src/obsidian/tools.ts`, which enqueues on the same queue.
    this.taskStore = new TaskStore(adaptAppToTaskVault(this.app), this.tasksWriteQueue);

    const proposalRoot = this.manifest.dir;
    const adapter = this.app.vault.adapter;
    this.proposalStore = new ProposalStore({
      read: async (relativePath) => {
        const path = `${proposalRoot}/${relativePath}`;
        return await adapter.exists(path) ? adapter.read(path) : null;
      },
      write: (relativePath, content) => adapter.write(`${proposalRoot}/${relativePath}`, content),
    }, this.proposalWriteQueue);
    const targetVault: ProposalTargetVaultAdapter = {
      getFile: (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? file : null;
      },
      read: (path) => adapter.read(path),
      create: async (path, content) => {
        await this.app.vault.create(path, content);
      },
      modify: async (path, content) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
        await this.app.vault.modify(file, content);
      },
      ensureFolder: (path) => this.ensureParentFolders(path),
    };
    this.proposalAcceptanceDeps = createProposalAcceptanceDeps({
      tasks: this.taskStore,
      vault: targetVault,
      loopsWriteQueue: this.loopsWriteQueue,
      playbooksWriteQueue: this.proposalPlaybookWriteQueue,
      playbooks: {
        settings: () => this.settings,
        saveSettings: () => this.saveSettings(),
      },
    });

    // Exo brand mark — a concave 4-point star (matches the product logo).
    // addIcon wraps this in an svg with viewBox "0 0 100 100".
    addIcon(
      EXO_ICON,
      '<path fill="currentColor" d="M50 3 Q 50 50 97 50 Q 50 50 50 97 Q 50 50 3 50 Q 50 50 50 3 Z"/>'
    );

    this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this));
    // The board view is always REGISTERED (so a leaf restored from the saved
    // workspace layout can render) but only ENTERED via a gated ribbon/command.
    // If it opens while orchestration is off it renders a "disabled" placeholder
    // and never starts the driver (see BoardView.onOpen).
    this.registerView(BOARD_VIEW_TYPE, (leaf) => new BoardView(leaf, this));
    this.registerView(COCKPIT_VIEW_TYPE, (leaf) => new CockpitView(leaf, this));

    // In-note AI: a floating toolbar over the selection (Edit / Continue / Ask
    // Exo). Registered once; gated live behind the `inlineAi` setting, so
    // toggling it off makes the extension inert without a reload.
    this.registerEditorExtension(inlineAiExtension(this));

    // Selection observer: reports the active editor's selection to the composer
    // so it shows an ambient "Selection" chip. Registered once; gated live
    // behind `showSelectionChip`, so toggling it off makes it inert.
    this.registerEditorExtension(selectionObserverExtension(this));

    // In-document Connections: underline outgoing unlinked mentions + a
    // bottom suggested-links block. Registered once; both surfaces are gated
    // live behind settings (default off) so the extension is inert until
    // enabled — no reload needed to toggle.
    this.registerEditorExtension(mentionsExtension(this));

    this.addRibbonIcon(EXO_ICON, "Open Exo", () => this.activateView());

    this.addCommand({
      id: "review-connections",
      name: "Review connections of the active note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) {
          void this.askExo(
            `Review the connections of [[${file.path}]]: call get_connections, judge which unlinked mentions are real references (vs coincidental strings), and propose which to link with link_mentions or dismiss with ignore_mention. Show me your reasoning before acting.`,
            true,
            { source: "review-connections" },
          );
        }
        return true;
      },
    });

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => this.activateView(),
    });

    // Paste-ready turn-lifecycle diagnostics (names/kinds/counts only — never
    // vault content). The first thing to ask for when "Exo si è bloccato".
    this.addCommand({
      id: "copy-diagnostics",
      name: "Copy diagnostics",
      callback: () => {
        const report = this.diag.dump({
          version: this.manifest.version,
          platform: process.platform,
          generated: new Date().toISOString(),
        });
        void navigator.clipboard.writeText(report);
        new Notice("Exo — diagnostics copied to clipboard");
      },
    });

    // One-click CLI update, discoverable from the palette (the settings pane
    // has its own button, but nobody should have to dig for it).
    this.addCommand({
      id: "update-claude-cli",
      name: "Update Claude CLI",
      callback: () => void this.runCliUpdate(),
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

    // Orchestration Board — flag-gated the same way the setting says: OFF by
    // default, and invisible (not just disabled) in the command palette when
    // off, via checkCallback returning false. Never touches chat when off.
    this.addCommand({
      id: "promote-to-task",
      name: "Promote to task (add to Orchestration Board backlog)",
      checkCallback: (checking) => {
        if (!promoteToTaskCommandVisible(this.settings)) return false;
        if (!checking) withView((v) => void v.cmdPromoteToTask())();
        return true;
      },
    });

    // Orchestration Board open command — invisible in the palette when the flag
    // is off (checkCallback returns false), mirroring "Promote to task".
    this.addCommand({
      id: "open-orchestration-board",
      name: "Open orchestration board",
      checkCallback: (checking) => {
        if (!this.settings.orchestrationEnabled) return false;
        if (!checking) void this.activateBoard();
        return true;
      },
    });

    // Ribbon icon (added/removed on flag toggle). Establishes the baseline for
    // the current flag state so a later toggle in settings re-syncs correctly.
    this.orchestrationApplied = this.settings.orchestrationEnabled;
    this.syncBoardRibbon();

    this.addCommand({
      id: "open-cockpit",
      name: "Open Cockpit",
      callback: () => void this.openCockpit(),
    });
    this.addCommand({
      id: "open-proposals",
      name: "Review suggestions",
      checkCallback: (checking) => {
        if (!this.settings.proposalKernelEnabled) return false;
        if (!checking) void this.openProposalsModal();
        return true;
      },
    });
    this.addRibbonIcon(COCKPIT_ICON, "Open Exo Cockpit", () => void this.openCockpit());
    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      if (this.settings.cockpitOnStartup && this.app.workspace.getLeavesOfType(COCKPIT_VIEW_TYPE).length === 0) {
        void this.openCockpit();
      }
      this.scheduleStartupMaintenance();
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
      id: "seed-agent-folder",
      name: "Seed agent folder",
      // Visible whenever vault-memory writes are allowed. Seeding is safe with the
      // agent-folder flag OFF (boot ignores the folder until it's flipped on) — it
      // IS the natural rollout: seed → review human.md → enable the flag.
      checkCallback: (checking: boolean) => {
        if (!this.settings.memoryWriteEnabled) return false;
        if (!checking) void this.seedAgentFolder();
        return true;
      },
    });

    this.addCommand({
      id: "setup-vault-memory",
      name: "Set up vault memory",
      // Same gate as seed-agent-folder: pointless (and confusing) to offer
      // scaffolding when the user has turned vault-memory writes off.
      checkCallback: (checking: boolean) => {
        if (!this.settings.memoryWriteEnabled) return false;
        if (!checking) void this.runVaultSetup();
        return true;
      },
    });

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
    this.addCommand({
      id: "automations",
      name: "Automations…",
      callback: () => this.openAutomationsModal(),
    });
    this.addCommand({
      id: "open-daily-pulse",
      name: "Open Daily Pulse",
      callback: () => void this.openDailyPulse(),
    });
    this.registerObsidianProtocolHandler("exo-daily-pulse", (params) => {
      void this.openDailyPulseTarget(params);
    });
    this.registerInterval(window.setInterval(() => void this.checkScheduledRuns(), 30 * 60 * 1000));
    void this.checkScheduledRuns();

    this.addCommand({
      id: "queue-drain",
      name: "Drain Exo Queue now",
      callback: () => {
        if (!this.settings.exoQueueEnabled) {
          new Notice("Exo Queue is off — enable it in settings.");
          return;
        }
        new Notice("Draining Exo Queue…");
        void this.maybeDrainExoQueue();
      },
    });
    this.addCommand({
      id: "queue-new-request",
      name: "New Exo Queue request",
      callback: () => void this.createQueueRequest(),
    });

    // Exo Queue ("Exo in tasca"): evade le note-richiesta arrivate via Sync.
    // Poll leggero ogni 60s (list di una cartella); drain sequenziale con
    // flag busy — mai due giri concorrenti (una richiesta può durare minuti).
    this.registerInterval(window.setInterval(() => void this.maybeDrainExoQueue(), 60 * 1000));

    // Git auto-commit safety net: ticks frequently, but only ever runs git
    // commands once the pure debounce/cadence decision says a check is due —
    // no-op (and silent) whenever the setting is off, the vault isn't a git
    // repo, or the worktree is clean. See core/git-autocommit.ts.
    this.registerInterval(
      window.setInterval(() => void this.maybeAutoCommit(), ExoPlugin.AUTO_COMMIT_CHECK_INTERVAL_MS)
    );

    this.addSettingTab(new MVASettingTab(this.app, this));

  }

  /** Keep process spawning and the registry request off Obsidian's critical
   *  startup path. The work remains best-effort and runs once after layout is
   *  ready; the timer is cancelled on hot unload. */
  private scheduleStartupMaintenance(): void {
    if (this.startupMaintenanceTimer !== null || this.unloaded) return;
    this.startupMaintenanceTimer = window.setTimeout(() => {
      this.startupMaintenanceTimer = null;
      if (this.unloaded) return;
      void this.checkCliVerified();
      void this.maybeCheckCliUpdate().then(() => this.maybeOfferCliUpdate());
    }, 2_000);
  }

  /** One-click Claude-CLI update, shared by the command and the boot notice.
   *  Wraps the existing updateClaudeCli() (npm install -g, 3-min cap) with
   *  progress + result notices and a diag entry. New sessions pick the new
   *  binary up automatically (the resolve caches are cleared on success). */
  private async runCliUpdate(): Promise<void> {
    this.diag.push("cli", "one-click update started");
    new Notice("Exo — updating Claude CLI…");
    const { ok, output } = await updateClaudeCli();
    if (ok) {
      this.diag.push("cli", "one-click update ok");
      new Notice("Exo — Claude CLI updated. New sessions use it automatically.", 8000);
    } else {
      const tail = output.split("\n").filter(Boolean).slice(-4).join("\n");
      this.diag.push("cli", "one-click update FAILED");
      new Notice(`Exo — CLI update failed:\n${tail || "unknown error"}`, 10000);
    }
  }

  /** If the daily check found a newer published CLI, surface a persistent
   *  notice with an Update button — once per published version (localStorage
   *  marker), so Mario never has to dig into Settings to stay current. */
  private async maybeOfferCliUpdate(): Promise<void> {
    try {
      const latest = this.settings.cliLatestKnown;
      if (!latest) return;
      const d = await cliDiagnostics("claude", this.settings.claudeBin); // cached — shared with checkCliVerified
      if (!d.version || compareSemver(d.version, latest) >= 0) return; // unknown or already current
      const KEY = "exo-cli-update-offered";
      if (this.app.loadLocalStorage(KEY) === latest) return; // offered once already
      this.app.saveLocalStorage(KEY, latest);
      this.diag.push("cli", `update available ${d.version} → ${latest}`);
      const frag = document.createDocumentFragment();
      const span = document.createElement("span");
      span.textContent = `Exo — Claude CLI ${latest} available (installed ${d.version}). `;
      const btn = document.createElement("button");
      btn.textContent = "Update now";
      frag.append(span, btn);
      const n = new Notice(frag, 0); // sticky until clicked/dismissed
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = "Updating…";
        await this.runCliUpdate();
        n.hide();
      };
    } catch {
      /* best-effort — never noise the boot */
    }
  }

  /**
   * Check npm for a newer Claude CLI, at most once per day. Caches the result in
   * settings (`cliLatestKnown` + `cliUpdateCheckAt`) so the settings tab can show
   * an update button without a network round-trip on every render. Uses
   * Obsidian's `requestUrl` (not node fetch — desktop CSP/proxy safe). Never
   * throws; a failed check just records the attempt so we don't hammer the API.
   */
  /** One-shot (per CLI version) drift notice: probe `claude --version` and warn
   *  when it falls outside {@link VERIFIED_CLAUDE_CLI}. The "already noticed"
   *  marker lives in Obsidian localStorage (not settings/data.json) so it never
   *  collides with settings writes and never syncs across devices. Best-effort:
   *  a failed probe is silent ("unknown" never nags). */
  private async checkCliVerified(): Promise<void> {
    try {
      const d = await cliDiagnostics("claude", this.settings.claudeBin);
      const status = cliVerifyStatus(d.version, VERIFIED_CLAUDE_CLI);
      if (status === "verified" || status === "unknown") return;
      const KEY = "exo-cli-verify-noticed";
      if (this.app.loadLocalStorage(KEY) === d.version) return; // told once already
      this.app.saveLocalStorage(KEY, d.version);
      this.diag.push("cli", `version ${d.version} ${status} (verified ${VERIFIED_CLAUDE_CLI.min}–${VERIFIED_CLAUDE_CLI.maxVerified})`);
      new Notice(
        status === "newer"
          ? `Exo — Claude CLI ${d.version} is newer than the verified range (≤ v${VERIFIED_CLAUDE_CLI.maxVerified}). If turns misbehave, run "Copy diagnostics" and check for an Exo update.`
          : `Exo — Claude CLI ${d.version} is older than the minimum verified v${VERIFIED_CLAUDE_CLI.min}. Please update the CLI.`,
        10000
      );
    } catch {
      /* best-effort — never block or noise the boot */
    }
  }

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
   * Open the Orchestration Board in the MAIN workspace pane (a new tab, not the
   * sidebar). Reuses an already-open board leaf if present. Only ever invoked
   * from the gated ribbon/command, so the flag is on by the time we get here.
   */
  async activateBoard(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(BOARD_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      // Main-area tab (not the sidebar) — the board is a full-width surface.
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: BOARD_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async openCockpit(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(COCKPIT_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: COCKPIT_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  /** Add or remove the board ribbon icon so it matches the flag exactly. */
  private syncBoardRibbon(): void {
    if (this.settings.orchestrationEnabled) {
      if (!this.boardRibbonEl) {
        this.boardRibbonEl = this.addRibbonIcon(BOARD_ICON, "Open orchestration board", () =>
          void this.activateBoard()
        );
      }
    } else if (this.boardRibbonEl) {
      this.boardRibbonEl.remove();
      this.boardRibbonEl = null;
    }
  }

  /**
   * React to an `orchestrationEnabled` toggle (called from `saveSettings`).
   * Hot-disable must be SAFE: it stops the driver (by detaching every open board
   * leaf — `BoardView.onClose` calls `driver.stop()`, dropping runtime state and
   * leaving running conversations alive as normal chats), hides entry points
   * (ribbon + palette command — the latter via its own checkCallback), and
   * touches NO markdown. Hot-enable just re-shows the ribbon.
   */
  private applyOrchestrationToggle(): void {
    const now = this.settings.orchestrationEnabled;
    if (now === this.orchestrationApplied) return;
    this.orchestrationApplied = now;
    this.syncBoardRibbon();
    if (!now) {
      // Detach any open board leaves — their onClose stops the driver and drops
      // in-memory orchestration state. No file writes, no chat impact.
      for (const leaf of this.app.workspace.getLeavesOfType(BOARD_VIEW_TYPE)) {
        leaf.detach();
      }
    }
  }

  /**
   * Public cross-plugin entry point: reveal Exo and start a new default-model
   * chat seeded with `query` (sent immediately unless `autoSend` is false).
   * Consumed by sibling plugins — e.g. Sonar's "Search with Exo" row — so they
   * don't have to reach into ChatView internals. Safe to call before the view
   * exists; it's created on demand. `opts.source` declares where the query came
   * from (e.g. "sonar-intent") and maps to a hidden steering directive.
   */
  async askExo(query: string, autoSend = true, opts?: { source?: string }): Promise<void> {
    await this.activateView();
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    if (view instanceof ChatView)
      view.askInNewConversation(query, autoSend, { sendPrefix: handoffPrefix(opts?.source) });
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
  noteVaultWrite(paths: readonly string[]): void {
    if (!this.settings.vaultAutoCommit) return;
    const cwd = this.vaultPath().replace(/\/$/, "");
    const normalized = paths
      .map((raw) => {
        let path = raw.trim().replace(/\\/g, "/");
        if (!path) return null;
        if (path.startsWith(cwd + "/")) path = path.slice(cwd.length + 1);
        else if (path.startsWith("/")) return null;
        path = path.replace(/^\.\//, "");
        if (!path || path.split("/").includes("..")) return null;
        return path;
      })
      .filter((path): path is string => path !== null);
    if (!normalized.length) return;
    for (const path of normalized) this.gitAutoCommitPaths.set(path, (this.gitAutoCommitPaths.get(path) ?? 0) + 1);
    this.gitAutoCommitState = recordVaultWrite(this.gitAutoCommitState, Date.now(), normalized.length);
  }

  /**
   * Convo-state notification — modeled on `noteVaultWrite()` above: synchronous,
   * in-memory, and unable to block, delay, or throw back into a chat turn (the
   * channel guards on `orchestrationEnabled` and try/catches every listener). The
   * ChatView hook sites call THIS at the exact points they already flip
   * `streaming` / open a pending card / stop, so a board crash is invisible to
   * chat and toggling the flag off makes it a strict no-op.
   */
  emitConvoState(convoId: string, state: ConvoState, detail?: { reason?: ConvoStateReason }): void {
    this.convoState.emit(convoId, state, detail);
  }

  /** Register a convo-state listener (the board driver). Returns an unsubscribe
   *  handle. Listeners never influence chat — throwing is swallowed. */
  onConvoState(listener: ConvoStateListener): Unsubscribe {
    return this.convoState.subscribe(listener);
  }

  /**
   * Read API for board reconciliation (workstream B5): given a convo id, report
   * whether it still exists in the live view and whether it's mid-turn / waiting
   * on input. Returns `{ exists: false }` when the view isn't open or the convo
   * is gone. Pure read — never mutates chat state.
   */
  readConvoState(convoId: string): { exists: boolean; streaming: boolean; hasPending: boolean } {
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    if (view instanceof ChatView) return view.readConvoState(convoId);
    return { exists: false, streaming: false, hasPending: false };
  }

  /**
   * Make sure a ChatView leaf EXISTS without revealing or focusing anything —
   * the background counterpart to `activateView`. Spawning is a system action
   * (the orchestrator consuming its queue), so it must never move the UI; only
   * an explicit user action (`revealConversation`) may reveal. The leaf is
   * created inactive in the right sidebar; the sidebar stays collapsed.
   */
  private async ensureChatView(): Promise<void> {
    const { workspace } = this.app;
    if (workspace.getLeavesOfType(VIEW_TYPE).length > 0) return;
    const leaf = workspace.getRightLeaf(false);
    await leaf?.setViewState({ type: VIEW_TYPE, active: false });
  }

  /**
   * Plugin-level wrapper around `ChatView.startTaskConversation` for callers that
   * don't hold the view (e.g. the Orchestration Board driver). Spawns a fresh
   * conversation seeded with `prompt` WITHOUT revealing Exo or stealing focus
   * (2026-07-08: was `activateView`, which yanked the sidebar open on every
   * queued-task start). The view is created hidden on demand; if it still can't
   * be resolved it returns "".
   */
  async startTaskConversation(prompt: string, opts?: { model?: string }): Promise<string> {
    await this.ensureChatView();
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    return view instanceof ChatView ? view.startTaskConversation(prompt, opts) : "";
  }

  /**
   * Plugin-level wrapper around `ChatView.revealConversation` for the
   * Orchestration Board: reveal Exo (in the sidebar) and focus the tab holding
   * `convoId`, so clicking a board card jumps to that task's chat. Creates the
   * view on demand. Returns false if the convo can't be found. Pure reveal —
   * never spawns a conversation.
   */
  async revealConversation(convoId: string): Promise<boolean> {
    await this.activateView();
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    return view instanceof ChatView ? view.revealConversation(convoId) : false;
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

    const stateAtStart = this.gitAutoCommitState;
    const pathVersions = [...this.gitAutoCommitPaths.entries()];
    // Mark this check before async git I/O. Any write that lands while git is
    // running records a fresh debounce instead of being erased in `finally`.
    this.gitAutoCommitState = afterCommitCheck(stateAtStart, now);
    if (!pathVersions.length) return;
    const paths = pathVersions.map(([path]) => path);
    let completed = false;

    try {
      const { isGitRepo, gitAvailable } = await checkGitRepo(cwd);
      const worktreeDirty = isGitRepo && gitAvailable ? await isWorktreeDirty(cwd, paths) : false;
      const pendingFileCount = paths.length;
      const commit = shouldCommitNow({
        enabled: this.settings.vaultAutoCommit,
        isGitRepo,
        gitAvailable,
        worktreeDirty,
        state: stateAtStart,
        now,
        debounceMs,
        cadenceMs,
      });
      if (commit) await runGitCommit(cwd, paths, formatCommitMessage(pendingFileCount));
      completed = true;
    } catch (err) {
      // Never let a failed commit break anything — log it and surface at most
      // one Notice ever (repeated failures would otherwise spam every tick).
      console.error("[Exo] git auto-commit failed:", err);
      if (!this.gitAutoCommitNoticeShown) {
        this.gitAutoCommitNoticeShown = true;
        new Notice("Exo: git auto-commit failed once — see the developer console for details.");
      }
    } finally {
      if (completed) {
        for (const [path, version] of pathVersions) {
          if (this.gitAutoCommitPaths.get(path) === version) this.gitAutoCommitPaths.delete(path);
        }
      }
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

  /**
   * The Agent Is the Folder — seeder (design §6). Read the vault's existing
   * scattered identity sources, distill the three blocks with the CHAT's default
   * (frontier) model — NOT the background floor: this is a one-shot, high-stakes
   * distillation — and write ONLY the block files that don't already exist (never
   * overwrite a hand-authored block). Also (re)writes the manifest and opens
   * `human.md` for review. Runs regardless of the `agentFolderEnabled` flag: with
   * the flag off the folder is simply never read, which is the safe rollout path.
   */
  private async seedAgentFolder(): Promise<void> {
    const readSource = async (path: string): Promise<string> => {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) {
        try {
          return await this.app.vault.cachedRead(f);
        } catch {
          /* unreadable — treat as empty */
        }
      }
      return "";
    };

    const sources = {
      mentalModel: await readSource("_system/memory/mental-model.md"),
      preferences: await readSource("_system/memory/preferences/preferences.md"),
      vaultContext: await readSource("_system/vault-context.md"),
    };
    if (!sources.mentalModel && !sources.preferences && !sources.vaultContext) {
      new Notice("Nothing to seed from — the _system/ source files are empty or missing.");
      return;
    }

    new Notice("Seeding the agent folder — distilling identity blocks…");
    const ctrl = new AbortController();
    // The CHAT's default model (settings' provider default), not backgroundModel:
    // seeding is one-shot and high-stakes, so it uses the frontier model.
    const raw = await this.runUtilityPass(buildSeedPrompt(sources), {
      signal: ctrl.signal,
      model: this.settings.claudeModel,
      timeoutMs: 120_000,
    });
    const blocks = parseSeedBlocks(raw);
    if (Object.keys(blocks).length === 0) {
      new Notice("Seeding failed — the model returned no usable blocks. Try again.");
      return;
    }

    // Manifest first (contract doc), then only the MISSING block files.
    let written = 0;
    const writtenPaths: string[] = [];
    let skipped = 0;
    await this.ensureFolder(AGENT_DIR);
    const manifestPath = `${AGENT_DIR}/manifest.md`;
    await this.writeIfMissing(manifestPath, manifestContent(), () => {}, true);
    writtenPaths.push(manifestPath);
    for (const name of AGENT_BLOCK_NAMES) {
      const content = blocks[name];
      if (!content) continue;
      const path = `${AGENT_DIR}/${name}.md`;
      const existed = this.app.vault.getAbstractFileByPath(path) instanceof TFile;
      if (existed) {
        skipped++;
        continue;
      }
      await this.app.vault.create(path, `${content.replace(/\s+$/, "")}\n`);
      written++;
      writtenPaths.push(path);
    }

    // Seeded blocks nudge the git-autocommit debounce like any other vault
    // write (integration audit 2026-07-10) — the fresh identity should reach
    // git on the fast path, not only the periodic cadence.
    if (writtenPaths.length > 0) this.noteVaultWrite(writtenPaths);

    new Notice(
      `Agent folder seeded — wrote ${written} block(s)${skipped ? `, kept ${skipped} existing` : ""}. Review human.md, then enable "The agent is the folder" in settings.`
    );
    // Open human.md for review (the block most worth a human check).
    const humanPath = `${AGENT_DIR}/human.md`;
    if (this.app.vault.getAbstractFileByPath(humanPath) instanceof TFile) {
      await this.app.workspace.openLinkText(humanPath, "", true);
    }
  }

  /** Vault setup — create every `_system/` path Exo reads/writes that's
   *  currently missing (Global Constraints: never touches what already
   *  exists). Shared by the `setup-vault-memory` command and the empty-state
   *  banner (ChatView calls this directly, hence no `private`). */
  async runVaultSetup(): Promise<void> {
    let written = 0;
    let skipped = 0;
    let failed = 0;
    const writtenPaths: string[] = [];
    for (const item of SCAFFOLD_ITEMS) {
      const existed = !!this.app.vault.getAbstractFileByPath(item.path);
      if (existed) {
        skipped++;
        continue;
      }
      try {
        if (item.kind === "folder") {
          await this.ensureFolder(item.path);
        } else {
          const parent = parentFolder(item.path);
          if (parent) await this.ensureFolder(parent);
          await this.app.vault.create(item.path, item.content ?? "");
        }
        written++;
        writtenPaths.push(item.path);
      } catch (err) {
        failed++;
        console.error(`[Exo] vault setup failed to create ${item.path}:`, err);
      }
    }
    if (writtenPaths.length > 0) this.noteVaultWrite(writtenPaths);
    new Notice(
      `Exo vault memory set up — created ${written} item(s)${skipped ? `, kept ${skipped} existing` : ""}${failed ? `, ${failed} failed (see console)` : ""}.`
    );
  }

  /** Create a folder if it doesn't exist (idempotent, race-safe). */
  private async ensureFolder(path: string): Promise<void> {
    if (this.app.vault.getAbstractFileByPath(path)) return;
    try {
      await this.app.vault.createFolder(path);
    } catch {
      /* already exists (race) — fine */
    }
  }

  /** Create each missing parent component for a target file, shallow to deep. */
  private async ensureParentFolders(filePath: string): Promise<void> {
    const parts = filePath.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      await this.ensureFolder(current);
    }
  }

  /** Write a file only when it's absent; `manifest` forces an overwrite so the
   *  contract doc stays current on every re-seed (it's Exo-owned, not hand-edited). */
  private async writeIfMissing(
    path: string,
    content: string,
    onWrite: () => void,
    overwrite = false
  ): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      if (overwrite) await this.app.vault.modify(existing, content);
      return;
    }
    await this.app.vault.create(path, content);
    onWrite();
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

  /* Seeded playbook: the Dia-style morning digest — vault + external sources
   * (Gmail/Slack/Calendar/Readwise via MCP, read-only). Each source degrades
   * gracefully when unavailable; the report is written by the runner, not the
   * agent (headless runs are read-only). */

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    const savedPulseState = this.settings.dailyPulseReviewState;
    this.settings.dailyPulseReviewState = {
      ...DEFAULT_SETTINGS.dailyPulseReviewState,
      ...(savedPulseState && typeof savedPulseState === "object" ? savedPulseState : {}),
      warnings: Array.isArray(savedPulseState?.warnings) ? savedPulseState.warnings : [],
    };
    // One-shot migration: legacy "Name | daily" scheduled-run lines become
    // structured automations (07:00 slot, read-only) and the raw field clears.
    if (this.settings.scheduledRuns.trim() && this.settings.automations.length === 0) {
      this.settings.automations = migrateScheduledRuns(this.settings.scheduledRuns);
      this.settings.scheduledRuns = "";
      await this.saveSettings();
    }
    const pulseSeed = seedDailyPulseAutomation(
      this.settings.automations,
      this.settings.seededDailyPulse
    );
    if (pulseSeed.changed) {
      this.settings.automations = pulseSeed.automations;
      this.settings.seededDailyPulse = pulseSeed.seeded;
      await this.saveSettings();
    }
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
    // Seed the Morning Digest playbook once (editable/deletable like any prompt;
    // never re-seeded). Schedule it with "Morning Digest | daily" in settings.
    if (!this.settings.seededDigest) {
      if (!this.settings.customPrompts.some((p) => p.name.toLowerCase() === "morning digest")) {
        this.settings.customPrompts.push({ name: "Morning Digest", prompt: MORNING_DIGEST_PROMPT });
      }
      this.settings.seededDigest = true;
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(this.settings)) as MVASettings;
    await this.settingsWriteQueue.enqueue(() => this.saveData(snapshot));
    // React to an orchestration-flag toggle: add/remove the ribbon and tear the
    // board down on hot-disable (safe — no markdown touched, chats survive).
    this.applyOrchestrationToggle();
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
      }

      await this.requireDreamSnapshot(snap);
      const summary = llm
        ? formatDreamSummary(llm.writePlan.summary)
        : `dream — promoted ${plan.promote.length}, merged ${plan.dedup.length}, stale ${plan.stale.length}`;
      await this.commitDreamApply(snap.files.map((file) => file.path), summary);
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
  private async commitDreamApply(paths: readonly string[], summary: string): Promise<void> {
    if (!this.settings.vaultAutoCommit) return;
    const cwd = this.vaultPath();
    if (cwd === ".") return;
    try {
      const { isGitRepo, gitAvailable } = await checkGitRepo(cwd);
      if (isGitRepo && gitAvailable && paths.length) {
        await runGitCommit(cwd, paths, formatCommitMessage(paths.length, summary));
      }
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
      await this.commitDreamApply(
        snap.files.map((file) => file.path),
        `dream — promoted ${plan.promote.length}, merged ${plan.dedup.length}, stale ${plan.stale.length}`
      );
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

  /** Run one playbook headlessly and write its report. Write-enabled runs also
   *  persist a restorable run record (files touched + pre-write snapshots). */
  async runPlaybook(name: string, prompt: string, opts: { write?: boolean } = {}): Promise<boolean> {
    if (/\{\{\s*[\w-]+\s*\}\}/.test(prompt)) {
      new Notice(`"${name}" has {{variables}} — run it from the composer instead.`);
      return false;
    }
    const startedAt = Date.now();
    new Notice(`Running playbook "${name}"…`);
    const result = await runHeadlessPlaybook(this.app, this.settings, prompt, opts);
    const path = await writeReport(this.app, name, result);
    if (opts.write) await this.recordAutomationRun(name, startedAt, result, path);
    new Notice(
      result.ok ? `Playbook "${name}" done → ${path}` : `Playbook "${name}" failed (report: ${path})`
    );
    // OS notification when Obsidian isn't focused (scheduled runs usually finish
    // in the background — this is how the digest announces itself). Click opens
    // the report. Same gate as the chat's turn notifications.
    if (this.settings.systemNotifications && !document.hasFocus()) {
      try {
        const n = new Notification(`Exo — ${result.ok ? `"${name}" pronto` : `"${name}" fallito`}`, {
          body: result.ok ? "Il report è nel vault — clicca per aprirlo." : "Il run è fallito — report con l'errore nel vault.",
          silent: false,
        });
        n.onclick = () => {
          void this.app.workspace.openLinkText(path, "", "tab");
        };
      } catch {
        /* notifications unavailable — Notice above already covered it */
      }
    }
    return result.ok;
  }

  /** Run any scheduled playbooks that are due (off by default — empty list). */
  /** Exo Queue: drain con guardia anti-concorrenza (le richieste headless
   *  possono durare minuti; il poll a 60s NON deve accavallarsi). */
  private exoQueueBusy = false;
  private async maybeDrainExoQueue(): Promise<void> {
    if (!this.settings.exoQueueEnabled || this.exoQueueBusy) return;
    this.exoQueueBusy = true;
    try {
      await drainExoQueue(this.app, this.settings);
    } catch (err) {
      console.warn("[Exo] queue drain failed:", err);
    } finally {
      this.exoQueueBusy = false;
    }
  }

  /** "New Exo Queue request": create an empty request note in the queue folder
   *  and open it — the same note a phone capture would write; the next drain
   *  (60s poll or "Drain now") answers it in place. */
  async createQueueRequest(): Promise<void> {
    const folder = this.settings.exoQueueFolder;
    try {
      if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
      const stamp = new Date();
      const p = (x: number) => String(x).padStart(2, "0");
      const name = `Richiesta ${stamp.getFullYear()}-${p(stamp.getMonth() + 1)}-${p(stamp.getDate())} ${p(stamp.getHours())}${p(stamp.getMinutes())}${p(stamp.getSeconds())}`;
      const file = await this.app.vault.create(`${folder}/${name}.md`, "");
      await this.app.workspace.getLeaf("tab").openFile(file);
      new Notice("Scrivi la richiesta nel corpo della nota — Exo risponde al prossimo drain.");
    } catch (err) {
      new Notice(`Couldn't create the queue request: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** True when `node` resolves on the given PATH — the codex child must be able
   *  to spawn the bridge script. On failure, warn ONCE per app run. */
  async checkNodeForBridge(pathEnv: string): Promise<boolean> {
    try {
      await execFileAsync("node", ["--version"], { env: { ...process.env, PATH: pathEnv } });
      return true;
    } catch {
      if (!this.nodeWarned) {
        this.nodeWarned = true;
        new Notice("Obsidian tools bridge unavailable for Codex — `node` not found on PATH. Codex runs without vault tools.");
      }
      return false;
    }
  }

  /** Start (once) the loopback executor and materialize the stdio script the
   *  codex child spawns. Null when anything fails — Codex then runs without
   *  obsidian tools, exactly as before the bridge existed. */
  async ensureCodexBridge(): Promise<{ bridge: CodexBridge; scriptPath: string } | null> {
    try {
      if (!this.codexBridge) this.codexBridge = await startCodexBridge();
      if (!this.codexBridgeScriptPath) {
        const rel = `${this.manifest.dir}/codex-bridge.mjs`;
        await this.app.vault.adapter.write(rel, CODEX_BRIDGE_SCRIPT);
        this.codexBridgeScriptPath = `${this.vaultPath()}/${rel}`;
      }
      return { bridge: this.codexBridge, scriptPath: this.codexBridgeScriptPath };
    } catch (e) {
      console.warn("[Exo] codex bridge unavailable:", e);
      return null;
    }
  }

  async listPendingProposals(): Promise<PendingProposals> {
    return this.proposalStore.listPending();
  }

  lastProposalRouteError(id: string): string | undefined {
    return this.proposalRouteErrors.get(id);
  }

  async acceptProposal(id: string): Promise<ProposalAcceptResult> {
    if (!this.settings.proposalKernelEnabled) throw new Error("Suggestion inbox is disabled.");
    const result = await this.proposalStore.accept(id, (record) =>
      routeAcceptedProposal(record, this.proposalAcceptanceDeps)
    );
    if (result.ok) this.proposalRouteErrors.delete(id);
    else this.proposalRouteErrors.set(id, result.error);
    void this.refreshCockpit();
    return result;
  }

  async dismissProposal(id: string) {
    if (!this.settings.proposalKernelEnabled) throw new Error("Suggestion inbox is disabled.");
    const record = await this.proposalStore.dismiss(id);
    this.proposalRouteErrors.delete(id);
    void this.refreshCockpit();
    return record;
  }

  async openProposalsModal(): Promise<void> {
    if (!this.settings.proposalKernelEnabled) return;
    const conversations = await this.loadConversations().catch(() => []);
    const titles = new Map<string, string>();
    for (const value of conversations) {
      if (typeof value !== "object" || value === null) continue;
      const convo = value as { id?: unknown; title?: unknown };
      if (typeof convo.id === "string" && typeof convo.title === "string") titles.set(convo.id, convo.title);
    }
    new ProposalsModal(this.app, {
      loadPending: () => this.listPendingProposals(),
      accept: (id) => this.acceptProposal(id),
      dismiss: (id) => this.dismissProposal(id),
      sourceTitle: (convoId) => titles.get(convoId) ?? "Conversation",
      lastRouteError: (id) => this.lastProposalRouteError(id),
    }).open();
  }

  async produceProposalsAfterTurn(
    input: Omit<ProposalTurnInput, "backgroundEnabled" | "suggestionsEnabled" | "budgetAllowed">
  ): Promise<ProposalProducerResult> {
    const estimate = ExoPlugin.PROPOSAL_TOKEN_ESTIMATE;
    const result = await produceTurnProposals({
      ...input,
      backgroundEnabled: this.settings.backgroundPassesEnabled,
      suggestionsEnabled: this.settings.proposalKernelEnabled && this.settings.proposalTurnSuggestions,
      budgetAllowed: this.checkBackgroundBudget(estimate),
    }, {
      signal: this.proposalAbort.signal,
      model: this.settings.backgroundModel,
      store: this.proposalStore,
      runUtilityPass: async (prompt, options) => {
        let actualTokens: number | null = null;
        const output = await this.runUtilityPass(prompt, {
          ...options,
          timeoutMs: 90_000,
          onUsage: (tokens) => {
            actualTokens = tokens;
          },
        });
        this.recordBackgroundSpend(actualTokens ?? estimate);
        return output;
      },
    });
    if (result.status === "generated" && result.appended > 0) void this.refreshCockpit();
    return result;
  }

  private async refreshCockpit(): Promise<void> {
    const view = this.app.workspace.getLeavesOfType(COCKPIT_VIEW_TYPE)[0]?.view;
    if (view instanceof CockpitView) await view.refresh();
  }

  onunload(): void {
    this.unloaded = true;
    this.proposalAbort.abort();
    if (this.startupMaintenanceTimer !== null) {
      window.clearTimeout(this.startupMaintenanceTimer);
      this.startupMaintenanceTimer = null;
    }
    this.codexBridge?.stop();
  }

  /** Pending queue requests (for the Autonomy card). */
  countQueuePending(): Promise<number> {
    return countPendingQueue(this.app, this.settings);
  }

  /** Live attention data for the Cockpit (blocked / streaming conversations). */
  liveAttention(): { id: string; title: string; blocked: boolean; streaming: boolean }[] {
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    return view instanceof ChatView ? view.convoAttention() : [];
  }

  /** Open the chat view on a specific conversation (Cockpit "Resume" rows). */
  async openConvo(id: string): Promise<void> {
    await this.activateView();
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    if (view instanceof ChatView && !view.openConvoById(id)) {
      new Notice("Conversation not found — it may have been deleted.");
    }
  }

  /** Deterministic production pipeline. Background-AI settings never gate it. */
  async generateDailyPulse(now: number = Date.now()): Promise<{
    warnings: DailyPulseCollectionWarning[];
    itemCount: number;
  }> {
    const pulseState = this.settings.dailyPulseReviewState;
    const generated = await generateAndWriteDailyPulse({
      taskStore: this.taskStore,
      loadLoops: async () => {
        const file = this.app.vault.getAbstractFileByPath(OPEN_LOOPS_PATH);
        if (!(file instanceof TFile)) return [];
        return parseLoopsFile(await this.app.vault.read(file));
      },
      proposalStore: this.proposalStore,
      loadAutomationRuns: () => this.loadAutomationRuns(),
      listRecentNotes: async ({ modifiedAfter, limit }) =>
        this.app.vault.getMarkdownFiles()
          .filter((file) => file.stat.mtime > modifiedAfter && file.stat.mtime <= now)
          .sort((a, b) => b.stat.mtime - a.stat.mtime || a.path.localeCompare(b.path))
          .slice(0, limit)
          .map((file) => ({ path: file.path, mtime: file.stat.mtime })),
      loadBackgroundBudget: async () => ({
        enabled: this.settings.backgroundPassesEnabled,
        dailyBudget: this.settings.backgroundDailyTokenBudget,
        ledger: { ...this.settings.backgroundBudgetLedger },
      }),
    }, {
      read: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? this.app.vault.read(file) : null;
      },
      write: async (path, content) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          await this.app.vault.modify(file, content);
          return;
        }
        await this.ensureParentFolders(path);
        await this.app.vault.create(path, content);
      },
    }, this.dailyPulseWriteQueue, {
      now,
      lastPulseAt: pulseState.lastSuccessAt || null,
    });

    return {
      warnings: generated.warnings,
      itemCount: generated.pulse.sections.reduce(
        (total, section) => total + section.items.length,
        0
      ),
    };
  }

  private async persistDailyPulseSuccess(options: {
    completedAt: number;
    attemptedAt: number;
    warnings: DailyPulseCollectionWarning[];
    itemCount: number;
    config?: AutomationConfig;
    reviewed?: boolean;
  }): Promise<void> {
    const lastRunKey = options.config ? automationLastRunKey(options.config) : null;
    const priorLastRun = lastRunKey ? this.settings.scheduledLastRun[lastRunKey] : undefined;
    const priorReviewState = this.settings.dailyPulseReviewState;
    const nextReviewState = dailyPulseReviewAfterRun(
      priorReviewState,
      {
        status: "succeeded",
        completedAt: options.completedAt,
        warningCount: options.warnings.length,
      },
      options.attemptedAt,
      options.warnings,
      options.itemCount
    );
    if (options.reviewed) nextReviewState.lastReviewedAt = options.completedAt;
    if (lastRunKey) this.settings.scheduledLastRun[lastRunKey] = options.completedAt;
    this.settings.dailyPulseReviewState = nextReviewState;
    try {
      await this.saveSettings();
    } catch (error) {
      if (lastRunKey) {
        if (priorLastRun === undefined) delete this.settings.scheduledLastRun[lastRunKey];
        else this.settings.scheduledLastRun[lastRunKey] = priorLastRun;
      }
      this.settings.dailyPulseReviewState = priorReviewState;
      throw error;
    }
  }

  private async generateAndPersistDailyPulse(now: number, reviewed = false): Promise<boolean> {
    try {
      const generated = await this.generateDailyPulse(now);
      await this.persistDailyPulseSuccess({
        completedAt: now,
        attemptedAt: now,
        warnings: generated.warnings,
        itemCount: generated.itemCount,
        config: this.settings.automations.find(isDailyPulseAutomation),
        reviewed,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.settings.dailyPulseReviewState = dailyPulseReviewAfterRun(
        this.settings.dailyPulseReviewState,
        { status: "failed", error: message, retryable: true },
        now
      );
      try {
        await this.saveSettings();
      } catch (saveError) {
        console.warn("[Exo] Daily Pulse error state could not be saved:", saveError);
      }
      return false;
    }
  }

  /** Explicit user-triggered refresh. It is allowed while the schedule is paused. */
  async runDailyPulseNow(now: number = Date.now()): Promise<boolean> {
    const ok = await this.generateAndPersistDailyPulse(now);
    await this.refreshCockpit();
    return ok;
  }

  /** Pull surface: generate on first explicit open, then mark current items reviewed. */
  async openDailyPulse(): Promise<void> {
    let file = this.app.vault.getAbstractFileByPath(DAILY_PULSE_TARGET_PATH);
    if (!(file instanceof TFile)) {
      const ok = await this.generateAndPersistDailyPulse(Date.now(), true);
      if (!ok) {
        await this.refreshCockpit();
        new Notice("Daily Pulse could not be refreshed. Retry from Automations.");
        return;
      }
      file = this.app.vault.getAbstractFileByPath(DAILY_PULSE_TARGET_PATH);
    }
    if (!(file instanceof TFile)) {
      await this.refreshCockpit();
      new Notice("Daily Pulse review note is unavailable.");
      return;
    }
    await this.app.workspace.openLinkText(DAILY_PULSE_TARGET_PATH, "", "tab");
    const state = this.settings.dailyPulseReviewState;
    if (state.lastSuccessAt > state.lastReviewedAt) {
      state.lastReviewedAt = Date.now();
      await this.saveSettings();
    }
    await this.refreshCockpit();
  }

  private async openDailyPulseTarget(params: Record<string, string>): Promise<void> {
    switch (params.target) {
      case "task":
        if (this.settings.orchestrationEnabled) await this.activateBoard();
        else await this.app.workspace.openLinkText(TASKS_PATH, "", "tab");
        return;
      case "loop":
        await this.app.workspace.openLinkText(OPEN_LOOPS_PATH, "", "tab");
        return;
      case "proposal":
        await this.openProposalsModal();
        return;
      case "automation":
        this.openAutomationsModal();
        return;
      case "note":
        if (params.path) await this.app.workspace.openLinkText(params.path, "", "tab");
        return;
    }
  }

  private async runScheduledDailyPulse(
    config: AutomationConfig,
    now: number
  ): Promise<void> {
    const lastRunKey = automationLastRunKey(config);
    let warnings: DailyPulseCollectionWarning[] = [];
    let itemCount = 0;
    const result = await this.dailyPulseSlotRunner.run({
      config,
      lastRun: this.settings.scheduledLastRun[lastRunKey] ?? 0,
      now,
      execute: async () => {
        const generated = await this.generateDailyPulse(now);
        warnings = generated.warnings;
        itemCount = generated.itemCount;
        return { warningCount: warnings.length };
      },
    });

    if (result.status === "disabled" || result.status === "current") return;
    if (result.status === "failed") {
      this.settings.dailyPulseReviewState = dailyPulseReviewAfterRun(
        this.settings.dailyPulseReviewState,
        result,
        now
      );
      await this.saveSettings();
      return;
    }

    await this.persistDailyPulseSuccess({
      completedAt: result.completedAt,
      attemptedAt: now,
      warnings,
      itemCount,
      config,
    });
  }

  private scheduledRunsBusy = false;
  private async checkScheduledRuns(): Promise<void> {
    if (this.scheduledRunsBusy) return;
    const autos = this.settings.automations.filter((a) => a.enabled);
    if (!autos.length) return;
    this.scheduledRunsBusy = true;
    try {
      for (const a of autos) {
        const now = Date.now();
        if (isDailyPulseAutomation(a)) {
          try {
            await this.runScheduledDailyPulse(a, now);
          } catch (err) {
            console.warn("[Exo] Daily Pulse failed:", err);
          }
          continue;
        }
        const p = this.settings.customPrompts.find((x) => x.name.toLowerCase() === a.name.toLowerCase());
        if (!p) continue;
        if (!isDue(a.cadence, this.settings.scheduledLastRun[p.name] ?? 0, now)) continue;
        try {
          const succeeded = await this.runPlaybook(p.name, p.prompt, { write: a.write }); // sequential — one at a time
          if (succeeded) {
            this.settings.scheduledLastRun[p.name] = Date.now();
            await this.saveSettings();
          }
        } catch (err) {
          console.warn(`[Exo] automation "${p.name}" failed:`, err);
        }
      }
    } finally {
      this.scheduledRunsBusy = false;
    }
  }

  /* --------------------------- automation runs --------------------------- */

  /** Sidecar (plugin dir) holding restorable write-run records — not vault
   *  notes: snapshots are machine state, not knowledge. */
  private automationRunsPath(): string {
    return `${this.manifest.dir}/automation-runs.json`;
  }

  async loadAutomationRuns(): Promise<AutomationRunRecord[]> {
    try {
      const raw = await this.app.vault.adapter.read(this.automationRunsPath());
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as AutomationRunRecord[]) : [];
    } catch {
      return []; // missing/corrupt file → empty history, never a blocked run
    }
  }

  private async saveAutomationRuns(records: AutomationRunRecord[]): Promise<void> {
    await this.app.vault.adapter.write(this.automationRunsPath(), JSON.stringify(records));
  }

  /** Persist one write-run record. Oversized snapshots are dropped (the report
   *  already flags what can't be auto-restored); history pruned to the last 20. */
  private async recordAutomationRun(
    name: string,
    startedAt: number,
    result: HeadlessResult,
    reportPath: string
  ): Promise<void> {
    try {
      const checkpoint = [...result.checkpoint.entries()].filter(
        ([, v]) => v === null || v.length <= MAX_AUTOMATION_SNAPSHOT
      );
      const rec: AutomationRunRecord = {
        id: `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        startedAt,
        ok: result.ok,
        reportPath,
        writes: result.writes,
        checkpoint,
      };
      await this.saveAutomationRuns(pruneRuns([rec, ...(await this.loadAutomationRuns())], 20));
    } catch (err) {
      console.warn("[Exo] couldn't persist the automation run record:", err);
    }
  }

  /** Revert every file an automation run touched to its pre-run snapshot. */
  async restoreAutomationRun(id: string): Promise<string[]> {
    const records = await this.loadAutomationRuns();
    const rec = records.find((r) => r.id === id);
    if (!rec) {
      new Notice("Run record not found — it may have been pruned.");
      return [];
    }
    const restored = await restoreRun(this.app, rec.checkpoint);
    rec.restoredAt = Date.now();
    await this.saveAutomationRuns(records);
    new Notice(
      restored.length
        ? `Restored ${restored.length} note${restored.length === 1 ? "" : "s"} from "${rec.name}".`
        : `Nothing restorable in "${rec.name}".`
    );
    return restored;
  }

  /** Mark a write run as reviewed — it leaves the Cockpit "to review" pool. */
  async markAutomationRunReviewed(id: string): Promise<void> {
    const records = await this.loadAutomationRuns();
    const rec = records.find((r) => r.id === id);
    if (!rec) return;
    rec.reviewedAt = Date.now();
    await this.saveAutomationRuns(records);
  }

  /** Open the Automations manager (settings button, Cockpit tile, command). */
  openAutomationsModal(): void {
    new AutomationsModal(this.app, this).open();
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
async function isWorktreeDirty(cwd: string, paths: readonly string[]): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--", ...paths], { cwd });
  return stdout.trim().length > 0;
}

/** Stage everything and commit with `message`. A concurrent process (another
 *  Exo tick, a manual commit) can beat us to it between the dirty-check and
 *  here — `git commit` then exits non-zero with "nothing to commit", which is
 *  swallowed as benign; any other failure propagates to the caller. */
async function runGitCommit(cwd: string, paths: readonly string[], message: string): Promise<void> {
  await execFileAsync("git", ["add", "-A", "--", ...paths], { cwd });
  try {
    await execFileAsync("git", ["commit", "-m", message, "--", ...paths], { cwd });
  } catch (err) {
    if (/nothing to commit/i.test(errText(err))) return; // race — benign, silent
    throw err;
  }
}
