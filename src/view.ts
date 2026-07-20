import {
  ItemView,
  WorkspaceLeaf,
  MarkdownRenderer,
  FileSystemAdapter,
  TFile,
  setIcon,
  setTooltip,
  Notice,
  Keymap,
} from "obsidian";
import type ExoPlugin from "./main";
import { resolveCli, describeError, isAbort } from "./cli";
import { ADAPTERS } from "./providers/registry";
import type {
  AgentEvent,
  AgentSession,
  ContextUsage,
  ImageAttachment,
  PermissionMode,
  ProviderId,
  RateLimitInfo,
  SessionCaps,
} from "./providers/types";
import { toolMeta, toolFilePath, toolFilePaths, toolWorkingLabel, renderToolDetail, READ_ONLY_TOOLS } from "./ui/tools";
import {
  createObsidianToolServer,
  buildObsidianTools,
  OBSIDIAN_READ_TOOLS,
  OBSIDIAN_MEMORY_TOOLS,
  type RethinkRequest,
} from "./obsidian/tools";
import { adaptAppToTaskVault, createBacklogTask } from "./obsidian/task-store";
import { MemoryObserver, type ObserverWrite } from "./obsidian/observer";
import { AgentFolder, type BlockWrite } from "./obsidian/agent-folder";
import { planRethink, type BlockName } from "./core/agent-self";
import type { NowProposal } from "./core/observer";
import {
  initialCadenceState,
  recordStep,
  pendingDelta,
  advanceWatermark,
  type CadenceState,
} from "./core/observer-cadence";
import { readBootContext } from "./obsidian/memory";
import { relatedNotes, basename as noteBasename } from "./obsidian/graph";
import { wikilinkify, type TouchedNote } from "./ui/graph-view";
import { NoteDiffModal } from "./ui/note-diff";
import { renderCapabilitiesPanel } from "./ui/capabilities";
import { RecapPanel } from "./ui/recap";
import { buildRecap as buildConvoRecap } from "./core/recap";
import { describeActivity } from "./core/activity";
import { clickable } from "./ui/dom";
import { StepsRun } from "./ui/steps";
import { firstErrorLine, stepPlacement } from "./core/steps";
import { Composer, type ComposerDraft } from "./ui/composer";
import { renderEmptyState } from "./ui/empty-state";
import { isVaultSetUp } from "./core/vault-setup";
import { buildRelatedChips } from "./ui/related";
import {
  persistMessage,
  revivePersistedMessage,
  type AskQuestion,
  type Segment,
  type Checkpoint,
  type Message,
  type PersistedMessage,
} from "./core/model";
import { maxIdSuffix, makeIdAllocator } from "./core/ids";
import { planPersistedConvos } from "./core/persistence";
import {
  buildRecap,
  isRecoverableSessionError,
  recordTurnError,
  resolveRecovery,
  shouldColdReseed,
  stopAction,
} from "./core/recovery";
import { workingAffordance } from "./core/working-visibility";
import { advanceBoundary } from "./core/stream-scan";
import { mergeTouched, WRITE_TOOLS } from "./core/touched";
import { terminalConvoState } from "./core/convo-state";
import { allowKey, permArgText, permRuleLine, decidePermission } from "./core/permissions";
import { describeCliFailure } from "./core/errors";
import { isReadOnlyExternalTool } from "./core/headless-tools";
import { writeResearchDossier } from "./obsidian/research-dossier";
import {
  createWorkflowSignal,
  evaluateWorkflowEligibility,
  type WorkflowOutputType,
} from "./core/workflow-signals";
import { planInputParts, planStateText } from "./core/plan";
import { parseStoreFile, selectRecall, isBackReference, DEFAULT_RECALL_OPTS, type MemoryEntry } from "./core/memory-store";
import { RECALLED_MEMORY_OPEN, RECALLED_MEMORY_CLOSE } from "./core/observer";
import { caretHost, type CaretNode } from "./core/caret-host";
import {
  turnQualifies,
  buildDistillPrompt,
  parseDistillReply,
  uniquePlaybookName,
  recordTurnSignal,
  signalLabel,
  type PlaybookSignal,
} from "./core/learning-loop";
import { loadSignalLedger, saveSignalLedger } from "./core/signals-store";
import {
  buildResearchReceipt,
  buildResearchOutbound,
  initialResearchModeState,
  normalizeResearchModeState,
  parseResearchCommand,
  toggleResearchMode as nextResearchMode,
  type ResearchReceipt,
  type ResearchModeState,
} from "./core/research";

export type { AskQuestion } from "./core/model";

/** Folder holding the append-only Memory Union Store — mirrors the constant in
 *  `obsidian/tools.ts` (the `recall` tool's read path). Duplicated rather than
 *  exported to avoid a view→tools value import for one string. */
const MEMORY_STORE_DIR = "_system/memory/store";

/** Prompt surface for the Memory Union Store — appended to the boot preamble only
 *  when the store tools are registered. Kept short: the tool descriptions carry
 *  the detail. */
const MEMORY_STORE_NOTE =
  "### Memory union store\n" +
  "A persistent, append-only memory store lives in `_system/memory/store/` — verbatim preferences, facts, decisions, and lessons from past sessions. " +
  "Call `recall` before answering anything that may depend on prior sessions instead of guessing, and use `remember` to store new durable statements in the user's exact words (never summarized).";

/** Variant used when proactive recall is ON: the plugin auto-injects the relevant
 *  memories, so the model no longer needs to *decide* to call `recall`. Kept short —
 *  `recall`/`remember` tool descriptions carry the detail. */
const MEMORY_STORE_NOTE_PROACTIVE =
  "### Memory union store\n" +
  "A persistent, append-only memory store lives in `_system/memory/store/`. Relevant past memories are auto-provided each turn inside `[recalled-memory]…[/recalled-memory]` blocks — trusted verbatim context, but BACKGROUND from other sessions. " +
  "When the user refers back to the running conversation ('continua', 'le altre cose proposte', 'quello sopra', 'as above', 'go on'), the referent is THIS conversation's own history — resolve it from the current thread, never from recalled memory or the boot `Recent sessions` digest. " +
  "Use `recall` for a deeper or explicit search (e.g. `as_of` point-in-time queries), and `remember` to store new durable statements in the user's exact words (never summarized).";

/** Prompt surface for the identity layer — appended when the agent folder is on
 *  and `rethink_memory` is registered. Explains WHEN to rethink (world-model
 *  change) vs `remember` (episodic), and the propose-only persona tier. */
const AGENT_FOLDER_NOTE =
  "### Identity — `rethink_memory`\n" +
  "Your identity lives in `_system/agent/` (persona, human, now) and is already in your boot context above. " +
  "Call `rethink_memory` only when your MODEL OF THE WORLD changes — a shifted priority (now.md), a durable update to how you understand the user (human.md, pass a rationale). NOT for episodic notes — those go to `remember`. " +
  "`persona.md` is propose-only: a `rethink_memory` on it records a proposal for the user to approve, it does not write.";

export const VIEW_TYPE = "exo-view";
/** Custom Obsidian icon id for the Exo brand mark (registered in main.ts). */
export const EXO_ICON = "exo-star";

const MAX_CONVOS = 30;
const MAX_PERSIST_OUTPUT = 2000;
const MAX_CHECKPOINT_FILE = 64_000; // don't persist a rewind snapshot larger than this (bloat guard)

interface ToolCard {
  card: HTMLElement;
  statusEl: HTMLElement;
  bodyEl: HTMLElement;
  elapsedEl: HTMLElement;
  startedAt: number;
}

/* ----- persisted data model (types in ./core/model) ----- */
interface ConvoData {
  id: string;
  title: string;
  provider: ProviderId;
  model: string;
  sessionId?: string;
  updatedAt?: number;
  usage?: ContextUsage;
  researchMode?: ResearchModeState;
  messages: PersistedMessage[];
}

export interface Convo {
  id: string;
  listEl: HTMLElement;
  title: string;
  sessionId?: string;
  provider: ProviderId;
  model: string;
  allow: Set<string>;
  updatedAt?: number;
  /** Last known context-window usage of this conversation's session — kept
   *  per-convo (and persisted) so tab switches and restarts restore the ring
   *  instead of blanking it until the next turn completes. */
  usage?: ContextUsage;
  messages: Message[];
  // Per-conversation runtime (enables parallel conversations).
  session: AgentSession | null;
  sessionSig: string;
  streaming: boolean;
  stopped: boolean; // set by stop() so the turn renders as "Stopped", not an error
  pendingPerm: (() => void) | null; // cancels an open permission card on stop
  pendingAsk: (() => void) | null; // cancels an open ask card on stop
  queue: {
    text: string;
    images?: ImageAttachment[];
    sendPrefix?: string;
    isRecoveryRetry?: boolean;
    researchMode?: ResearchModeState;
  }[];
  pendingEl: HTMLElement | null; // container for queued-message chips
  /** The in-flight assistant turn of THIS conversation (null when idle) — the
   *  target for its session's ask_user cards, so parallel conversations can't
   *  cross-render into each other's transcripts. */
  currentCtx: AssistantCtx | null;
  /** The discreet "Related" section appended below the last turn when the
   *  transcript doesn't fill the viewport (null when not shown). */
  tailSurfaceEl: HTMLElement | null;
  /** True once the proactive ≥75% compaction nudge has been shown for this
   *  conversation — one-shot, so it never re-appears after dismiss or compaction. */
  compactNudged?: boolean;
  /** True once the learning-loop "save as playbook?" offer has been shown for
   *  this conversation — one-shot per convo, runtime-only (never persisted). */
  playbookNudged?: boolean;
  /** Unsent composer draft (text + attachments), stashed when the user switches
   *  away so every chat keeps its own composer — runtime-only, never persisted. */
  draft?: ComposerDraft;
  /** Provider-only prefix for the NEXT turn (Codex compact emulation: the
   *  recap that reseeds a fresh session). Consumed once, never UI/persisted. */
  pendingSendPrefix?: string;
  /** Persisted per-conversation Research Mode; never shared across tabs. */
  researchMode: ResearchModeState;
  /** True once an AI-title generation has been fired for this conversation —
   *  one-shot guard so the Haiku title call runs at most once (after the first
   *  assistant turn). Runtime-only (never persisted). */
  titledByAi?: boolean;
  /** Proactive recall (design 2026-07-09): ids of store entries already injected
   *  into THIS conversation's outbound turns, so each memory is paid for once and
   *  then lives in cached history. Runtime-only — never persisted (a reloaded
   *  conversation re-injects from scratch, which is correct: the cached history is
   *  gone too). Mirrors the runtime-only pattern of `titledByAi` above. */
  injectedMemoryIds?: Set<string>;
  /** Controller for the in-flight AI-title call, so disposing the conversation
   *  (close/delete/reset) aborts it. Runtime-only. */
  titleAbort?: AbortController | null;
  /** Runtime-only (never persisted): set when a turn ended poisoned but its
   *  on-disk sessionId was KEPT for a resume-first recovery. If a turn started
   *  with this true also poisons, recovery escalates to a fresh session + recap
   *  (see runTurn's two-stage recovery). Cleared on any healthy turn. */
  resumeRisky?: boolean;
  /** Observer cadence (W2-3) — runtime-only, never persisted. `cadence` is the
   *  pure per-conversation step-counter/watermark state (used only in
   *  `observerCadence: "every-n-steps"`; harmless dead weight otherwise).
   *  `cadenceTurnFlushLen` is how many chars of THIS turn's accumulated
   *  assistant text a step pass already sent — reset at the top of each new
   *  turn — so the end-of-turn pass only sends the unsent tail. */
  cadence?: CadenceState;
  cadenceTurnFlushLen?: number;
}

interface AssistantCtx {
  el: HTMLElement;
  bodyEl: HTMLElement;
  cards: Map<string, ToolCard>;
  segById: Map<string, Segment>;
  segments: Segment[];
  /** Stable across recovery retry because it derives from the persisted user turn. */
  turnId: string;
  curTextEl: HTMLElement | null;
  /** Chars of curRaw already rendered into stable (final) blocks. */
  stableLen: number;
  /** Live tail element re-rendered each tick (holds the not-yet-stable suffix). */
  tailEl: HTMLElement | null;
  /** The live streaming caret (at most one per turn), tracked so cleanup is O(1). */
  caretEl: HTMLElement | null;
  /** Turn finalized (flushRender ran). A render tick's caret placement resolves on
   *  a microtask, so a tick in flight when the turn ends could otherwise re-add a
   *  caret AFTER cleanup. This flag is the airtight invariant — no caret may be
   *  placed once true — closing the whole orphaned-caret race class. */
  finalized: boolean;
  /** Incremental block-boundary scan state over curRaw (O(delta) per tick):
   *  chars already scanned (complete lines only) … */
  scanPos: number;
  /** … whether scanPos sits inside a ``` fence … */
  fenceOpen: boolean;
  /** … and the last safe (non-fenced blank-line) boundary found so far. */
  lastBoundary: number;
  curTextSeg: { t: "text"; md: string } | null;
  curRaw: string;
  fullText: string;
  userText: string;
  thinkingEl: HTMLElement | null;
  /** Open steps-timeline run (contiguous thinking + generic tool work). Null
   *  when no run is open; closed (folded to "N steps") when reply text resumes,
   *  an excluded card appears, or the turn ends. */
  stepsRun: StepsRun | null;
  sources: Set<string>;
  touched: TouchedNote[];
  /** Tool-use id → file path, for write tools (to reveal the note on result). */
  writeById: Map<string, string>;
  /** Tool-call ids that touched a note (top-level, non-subagent-nested). Their
   *  live `.mva-tool` row is streaming-only feedback — removed once the turn
   *  settles, since the touched-notes footer then carries the same fact. */
  noteTouchIds: Set<string>;
  /** Tool-call id → owning steps run, so dissolving note rows at turn end can
   *  re-count (or remove) the folded run they live in. */
  runById: Map<string, StepsRun>;
  /** Notes already revealed this turn (dedupe). */
  revealed: Set<string>;
  /** Vault-relative paths that got a preview card this turn (dedupe, first write wins). */
  artifacts: Set<string>;
  /** Vault-relative paths that did NOT exist when first written this turn (newly created). */
  createdPaths: Set<string>;
  convo: Convo;
  /** Per-turn debounce timer, so parallel conversations don't fight over a shared one. */
  renderTimer: number | null;
  /** Live TodoWrite panel for this turn (re-rendered on each update). */
  todosEl: HTMLElement | null;
  /** Background Bash tasks this turn: tool-call id → card + badge + parsed shell id. */
  bgTasks: Map<string, { cardEl: HTMLElement; badgeEl: HTMLElement; shellId?: string }>;
  /** Task (subagent) tool-calls currently in flight (added on start, removed on
   *  result). With bgTasks, drives the per-chat "N agents running" indicators —
   *  the count of background work THIS conversation owns right now. */
  runningTasks: Set<string>;
  /** Task (subagent) cards this turn: Task tool-call id → nested activity section. */
  taskCards: Map<string, { container: HTMLElement; summaryEl: HTMLElement; rowsEl: HTMLElement; count: number }>;
  /** Subagent mini-rows this turn (live-only): tool-call id → status dot + parent. */
  nestedRows: Map<string, { dotEl: HTMLElement; parentId: string }>;
  /** Working-indicator row (Feature 1) — star + phase label + elapsed + esc hint.
   *  Always re-appended as the last child of bodyEl so it trails the transcript. */
  workingEl: HTMLElement | null;
  workingLabel: HTMLElement | null;
  workingElapsed: HTMLElement | null;
  /** Interactive cards (permission / ask_user / plan) currently awaiting the
   *  user. While > 0 the card IS the feedback, so the working row hides. */
  openCards: number;
  /** A text segment is actively streaming — the caret is the live feedback, so
   *  the working row hides. Reset when the segment ends (thinking, tool, turn). */
  textStreaming: boolean;
  /** System-notification dedupe keys fired this turn (Feature 3): "done" | "waiting" | "error". */
  notified: Set<string>;
}

let convoSeed = 0;

export class ChatView extends ItemView {
  private provider: ProviderId;
  private model: string;
  /** The composer subsystem (input box + toolbar + popovers + context row).
   *  Owns its own DOM, images, selection chip, usage ring, and rate badge. */
  private composer!: Composer;
  /** Also record the view-level prePlanMode so a plan-mode entry (Shift+Tab or
   *  the perm chip) can be restored to the exact prior mode once a plan is
   *  approved. Defaults to "default" — the safe post-approval build mode. */
  private prePlanMode: PermissionMode = "default";

  /** Active conversation is streaming (drives the send/stop button). */
  /** Turn-lifecycle diagnostics (plugin-scoped ring buffer, core/diag.ts).
   *  Log NAMES/KINDS/COUNTS only — never message or vault content. */
  private get diag() {
    return this.plugin.diag;
  }

  private get streaming(): boolean {
    return this.active?.streaming ?? false;
  }
  private memoryPreamble = "";
  /** In-flight session spawns, so a pre-warm and a real send don't double-spawn
   *  (and leak) a CLI session for the same conversation. */
  private sessionInit = new WeakMap<Convo, { sig: string; promise: Promise<AgentSession> }>();
  /** Monotonic per-convo spawn counter: a spawn only installs its session if no
   *  newer spawn (or dropSession) superseded it while it was awaiting. */
  private spawnSeq = new WeakMap<Convo, number>();

  private convos: Convo[] = [];
  private active!: Convo;
  /** Ids of conversations shown in the tab bar (ordered). Subset of `convos`. */
  private openTabs: string[] = [];

  private tabsEl!: HTMLElement;
  private listWrap!: HTMLElement;
  /** Pinned "N agents running" chip above the composer, reflecting ONLY the chat
   *  currently open (its own subagents + background tasks). Always visible while
   *  that chat has background work, even when the working row scrolls off. */
  private agentChipEl: HTMLElement | null = null;
  /** Inner scroll host inside listWrap. Holds the (swapped-per-conversation)
   *  `.mva-list` and any full-pane overlay (gallery/capabilities). Split out from
   *  listWrap so the composer — now a bottom sibling of the list — survives the
   *  `listHost.empty()` swap on conversation change. */
  private listHost!: HTMLElement;
  /** Recap Rail — full-page-only right panel; host + panel instance + observer.
   *  Null in the sidebar (where the rail never mounts its content). */
  private recapHost: HTMLElement | null = null;
  private recapPanel: RecapPanel | null = null;
  private recapResizeObserver: ResizeObserver | null = null;
  /** Self-Writing Memory observer — lazily created, one per view, disposed on close. */
  private memoryObserver: MemoryObserver | null = null;
  /** The Agent Is the Folder — block reader/writer, lazily created (one per view). */
  private agentFolder: AgentFolder | null = null;
  /** In-flight tool phrase for the Context panel's live activity row while a turn
   *  streams (set on tool-call-start, cleared on result/turn-end). Only the idle
   *  path — `updateRecap()` — ignores it; `updateContextLive()` renders it. */
  private currentActivity: { phrase: string } | null = null;
  /** Last computed wide state — only rebuild the Context panel on the transition. */
  private wasWide = false;
  private galleryEl: HTMLElement | null = null;
  private capsEl: HTMLElement | null = null;
  private brandDot!: HTMLElement;
  private lastPersistErrorNotice = 0;
  /** Whether the view auto-follows new content to the bottom. False once the
   *  user scrolls up, so streaming no longer yanks them back down. */
  private pinnedToBottom = true;
  /** Coalesces scroll writes into one rAF per frame. */
  private scrollRaf: number | null = null;
  /** Floating jump-to-bottom button (lazily created). */
  private jumpPill: HTMLElement | null = null;
  /** Notion-style user-message navigator rail (per-view, rebuilt on changes). */
  private outlineEl: HTMLElement | null = null;
  /** Coalesces outline active-item updates into one rAF per scroll frame. */
  private outlineRaf: number | null = null;
  /** Anti-flicker collapse timer for the outline panel (Notion pattern). */
  private outlineCollapseTimer: number | null = null;
  /** Latest capability snapshot from any session's system/init (CLI ≥2.1.199):
   *  the REAL skills/commands/agents/MCP the CLI sees (global + plugins + vault),
   *  used to enrich the autocomplete menus and the Capabilities panel. */
  private sessionCaps: SessionCaps | null = null;
  /** MCP servers already warned-about this view (dedupe the degraded Notice). */
  private warnedDegradedMcp = new Set<string>();
  /** Whether we've already lazily asked for OS notification permission (once). */
  private notifyPermAsked = false;

  constructor(leaf: WorkspaceLeaf, private plugin: ExoPlugin) {
    super(leaf);
    this.provider = plugin.settings.provider;
    this.model = this.provider === "claude" ? plugin.settings.claudeModel : plugin.settings.codexModel;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Exo";
  }
  getIcon(): string {
    return EXO_ICON;
  }

  private get listEl(): HTMLElement {
    return this.active.listEl;
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("mva-root");
    this.buildHeader(root);
    this.tabsEl = root.createDiv({ cls: "mva-tabs" });
    // Chat column + Recap Rail as flex-row siblings. In the sidebar (not wide)
    // the row is a plain column and the recap host stays display:none (CSS); the
    // chat behaves exactly as before.
    const mainRow = root.createDiv({ cls: "mva-main-row" });
    this.listWrap = mainRow.createDiv({ cls: "mva-list-wrap" });
    // Inner host for the scrolling transcript; the composer mounts as a sibling
    // pinned to the bottom of listWrap (see buildComposer) so it centers on the
    // SAME column as the messages — aligned even with the recap rail open.
    this.listHost = this.listWrap.createDiv({ cls: "mva-list-host" });
    this.recapHost = mainRow.createDiv({ cls: "mva-recap" });
    this.recapPanel = new RecapPanel(this.app, (p) => this.openNote(p));
    // Wire up link clicks in rendered markdown (MarkdownRenderer doesn't do this for custom views).
    this.registerDomEvent(this.listWrap, "click", (e) => {
      const a = (e.target as HTMLElement).closest("a") as HTMLAnchorElement | null;
      if (!a) return;
      const external = a.getAttr("href") ?? "";
      if (a.classList.contains("internal-link")) {
        e.preventDefault();
        const href = a.getAttr("data-href") || a.getAttr("href") || a.textContent || "";
        if (href) void this.app.workspace.openLinkText(href, "", Keymap.isModEvent(e));
      } else if (/^https?:\/\//.test(external)) {
        e.preventDefault();
        window.open(external, "_blank");
      }
    });
    // Per-chat agents chip: in-flow sibling of listWrap, created BEFORE the composer
    // so it pins directly above it. Reflects only the OPEN chat's own background work.
    this.agentChipEl = this.listWrap.createDiv({ cls: "mva-agents is-hidden" });
    this.buildComposer();
    // View-level Esc-to-stop: the composer's own Escape handler only fires while the
    // textarea is focused, but clicking into the transcript blurs it — so "esc to stop"
    // silently stopped working. A capture-phase listener on the whole view catches Esc
    // wherever focus is. Guard: if an Esc-consuming overlay (e.g. a visible autocomplete
    // popup) is open, let it handle Esc itself instead of stopping the stream.
    this.registerDomEvent(
      this.containerEl,
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key !== "Escape" || !this.streaming) return;
        const ac = this.containerEl.querySelector<HTMLElement>(".mva-ac");
        if (ac && ac.offsetParent !== null) return; // overlay open — it wins
        e.preventDefault();
        e.stopPropagation();
        this.stop("esc");
      },
      true
    );
    await this.restore();
    this.composer.refreshResearch();
    this.composer.refreshContext();
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.composer.refreshContext();
        this.refreshSurfacing();
      })
    );
    // Resizing the pane can flip a short transcript into overflow (or back) without
    // any content change — keep the tail "Related" section in sync with that too.
    const tailResizeObserver = new ResizeObserver(() => this.renderTailSurfacing(this.active));
    tailResizeObserver.observe(this.listWrap);
    this.register(() => tailResizeObserver.disconnect());
    // Recap Rail: full-page-only. Re-evaluate `is-wide` on container resize and on
    // layout-change (dragging the leaf between sidebar and main), then build/clear.
    this.recapResizeObserver = new ResizeObserver(() => this.applyWideMode());
    this.recapResizeObserver.observe(root);
    this.register(() => {
      this.recapResizeObserver?.disconnect();
      this.recapResizeObserver = null;
    });
    this.registerEvent(this.app.workspace.on("layout-change", () => this.applyWideMode()));
    this.applyWideMode();
    this.prewarm();
  }

  /** True when this leaf lives in the main editor area (not a sidebar) and is wide
   *  enough for the recap rail. Sidebar leaves root to left/rightSplit, not rootSplit. */
  private isWideMain(): boolean {
    return this.leaf.getRoot() === this.app.workspace.rootSplit && this.contentEl.clientWidth > 900;
  }

  /** Toggle the `is-wide` layout class and (re)build or clear the recap to match.
   *  The panel shows only when the leaf is a wide full-page main area. Only builds
   *  on the narrow→wide transition — while already wide, content changes drive
   *  updateRecap() from turn-end/switch/restore, so we don't rebuild the panel on
   *  every ResizeObserver tick during a drag. */
  private applyWideMode(): void {
    const wide = this.isWideMain();
    this.contentEl.toggleClass("is-wide", wide);
    if (wide && !this.wasWide) this.updateRecap();
    else if (!wide) this.recapHost?.empty();
    this.wasWide = wide;
  }

  /** Rebuild the recap for the active conversation. No-op unless wide, so no work
   *  happens in the sidebar. Called at turn end, on switch, and on restore/rewind. */
  private updateRecap(): void {
    if (!this.recapHost || !this.recapPanel || !this.isWideMain()) return;
    this.recapPanel.render(
      this.recapHost,
      buildConvoRecap(this.active.messages, (p) => this.relPath(p)),
      null,
      {
        enabled: this.active.researchMode.enabled,
        receipt: this.latestResearchReceipt(this.active),
      }
    );
  }

  private latestResearchReceipt(c: Convo): ResearchReceipt | undefined {
    for (let index = c.messages.length - 1; index >= 0; index--) {
      const message = c.messages[index];
      // The rail describes the latest assistant result. Do not let an older
      // research receipt mask newer ordinary-chat knowledge in the recap.
      if (message.role === "assistant") return message.researchReceipt;
    }
    return undefined;
  }

  /** Live Context refresh during a streaming turn. Same panel, but two things
   *  differ from `updateRecap()`: (1) the in-flight turn's segments aren't in
   *  `c.messages` until turn end, so we fold this turn's already-resolved tool
   *  segments into the recap input — completed tools appear incrementally; (2) the
   *  current-activity phrase renders as a live row above the sections. The running
   *  tool is filtered out of the accumulated part (ok === null) so it only shows in
   *  the current row until it resolves and folds down. Guarded by `isWideMain()`
   *  so zero work happens in the sidebar — same guard the idle path uses. */
  private updateContextLive(ctx: AssistantCtx): void {
    if (!this.recapHost || !this.recapPanel || !this.isWideMain()) return;
    const resolved = ctx.segments.filter((s) => s.t !== "tool" || s.ok !== null);
    const live: Message[] = [...this.active.messages, { role: "assistant", segments: resolved }];
    this.recapPanel.render(
      this.recapHost,
      buildConvoRecap(live, (p) => this.relPath(p)),
      this.currentActivity,
      {
        enabled: this.active.researchMode.enabled,
        receipt: this.latestResearchReceipt(this.active),
      }
    );
  }

  async onClose(): Promise<void> {
    if (this.scrollRaf !== null) {
      cancelAnimationFrame(this.scrollRaf);
      this.scrollRaf = null;
    }
    // this.active is always within this.convos, so the loop covers it.
    for (const c of this.convos) this.dropSession(c);
    this.memoryObserver?.dispose();
    this.memoryObserver = null;
  }

  /** Build the composer subsystem, wiring the narrow host adapter (turn engine,
   *  shared model/provider/permission state, view services) it calls back into. */
  private buildComposer(): void {
    const self = this;
    this.composer = new Composer({
      plugin: this.plugin,
      listWrap: this.listWrap,
      get active() {
        return self.active;
      },
      get streaming() {
        return self.streaming;
      },
      get provider() {
        return self.provider;
      },
      set provider(v: ProviderId) {
        self.provider = v;
      },
      get model() {
        return self.model;
      },
      set model(v: string) {
        self.model = v;
      },
      get prePlanMode() {
        return self.prePlanMode;
      },
      set prePlanMode(v: PermissionMode) {
        self.prePlanMode = v;
      },
      get sessionCaps() {
        // Fall back to the plugin-cached snapshot so the $ / / menus are rich
        // even before this view's own session has fired its init.
        return self.sessionCaps ?? self.plugin.lastSessionCaps;
      },
      register: (cb) => this.register(cb),
      send: () => this.send(),
      stop: (source) => this.stop(source),
      submitWorkflow: (c, steps) => this.submitWorkflow(c, steps),
      compactActive: (instructions) => this.compactActive(instructions),
      togglePlanMode: () => this.togglePlanMode(),
      toggleResearchMode: () => this.toggleResearchMode(),
      onProviderChange: (next, explicitModel) => this.onProviderChange(next, explicitModel),
      allModelChoices: () => this.allModelChoices(),
      persistModel: () => this.persistModel(),
      openNote: (p) => this.openNote(p),
      openArtifact: (p) => this.openArtifact(p),
    });
    this.composer.mount(this.listWrap);
  }

  /** Focus the composer input — called when the view is opened via ribbon/command. */
  focusComposer(): void {
    this.composer.focusInput();
  }

  /** Seed the composer with a selection quoted from a note (the in-note "Ask Exo"
   *  action) and focus it. */
  attachSelection(text: string, sourcePath: string): void {
    this.composer.attachSelection(text, sourcePath);
  }

  /** Mirror the active editor's current selection into the composer as an ambient
   *  "Selection" chip (see the selection observer). Empty `text` clears it. */
  setCurrentSelection(text: string, path: string): void {
    this.composer.setCurrentSelection(text, path);
  }

  /* --------------------------- session mgmt ------------------------- */

  private sessionSigOf(c: Convo): string {
    const s = this.plugin.settings;
    return [
      c.provider,
      c.model,
      s.effort,
      s.toolsEnabled,
      s.permissionMode,
      s.fastStartup,
      s.runHooks,
      s.systemPrompt,
      s.obsidianToolsEnabled,
      s.nativeFirst,
      s.memoryReadEnabled,
      s.memoryWriteEnabled,
      s.autoCompactEnabled,
      s.contextSavingMode,
      s.codexSandbox,
      s.codexApproval,
      s.orchestrationEnabled,
      c.provider === "claude" ? s.claudeBin : s.codexBin,
      c.id,
    ].join("|");
  }

  private ensureSession(c: Convo): Promise<AgentSession> {
    const sig = this.sessionSigOf(c);
    if (c.session && sig === c.sessionSig) return Promise.resolve(c.session);
    // Reuse an in-flight spawn ONLY if it was started for the same config
    // signature — a stale-sig spawn (settings changed mid-prewarm) must not be
    // handed to a send that expects the new config.
    const inflight = this.sessionInit.get(c);
    if (inflight && inflight.sig === sig) return inflight.promise;
    const promise = this.spawnSession(c, sig);
    this.sessionInit.set(c, { sig, promise });
    const cleanup = () => {
      if (this.sessionInit.get(c)?.promise === promise) this.sessionInit.delete(c);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  private async spawnSession(c: Convo, sig: string): Promise<AgentSession> {
    // Claim a spawn slot: any older in-flight spawn is superseded from now on.
    const seq = (this.spawnSeq.get(c) ?? 0) + 1;
    this.spawnSeq.set(c, seq);
    this.diag.push("session", `spawn provider=${c.provider} resume=${c.sessionId ? c.sessionId.slice(0, 8) : "no"}`);
    c.session?.dispose();
    const s = this.plugin.settings;
    const bin = c.provider === "claude" ? s.claudeBin : s.codexBin;
    const cli = await resolveCli(c.provider, bin);

    // Obsidian-native tools are Claude-only and require agentic (gated) mode.
    const useObsidian = s.obsidianToolsEnabled && s.toolsEnabled && c.provider === "claude";
    // The createSdkMcpServer instance binds to its first session's transport and
    // is NOT reusable across query() sessions — a cached instance means every
    // session after the first (new tabs, post-error respawns) boots without the
    // obsidian tools. Build a FRESH server per spawn; it's cheap (plain object +
    // zod schemas), and the settings it depends on are read at creation time.
    const obsidianServer = useObsidian
      ? createObsidianToolServer(
          this.app,
          !s.contextSavingMode,
          s.memoryWriteEnabled,
          (qs) =>
            // Per-session server + per-convo closure: ask_user always renders into
            // the conversation that owns this session, never a parallel one.
            this.askBridge(c, qs),
          s.memoryReadEnabled,
          // Inject the plugin's ONE shared store write-queue so the `remember`
          // tool serializes against the observer's appends/undo (w1-1 contract).
          this.plugin.memoryWriteQueue,
          // Orchestration Board flag — gates `add_task` only; everything else
          // above is unaffected either way (see settings.ts, tools.ts).
          s.orchestrationEnabled,
          // Shared tasks-ledger write-queue, mirroring memoryWriteQueue's contract.
          this.plugin.tasksWriteQueue,
          // The Agent Is the Folder — gates `rethink_memory` only.
          s.agentFolderEnabled,
          // Per-convo bridge: rethink_memory renders into THIS conversation's turn.
          (req) => this.rethinkBridge(c, req),
          // Same contract for the single-file Open-Loops Ledger. Kept last in
          // the positional API so existing callers retain their argument slots.
          this.plugin.loopsWriteQueue
        )
      : undefined;

    let memoryPreamble: string | undefined;
    // Provider-agnostic since Tranche A (Codex parity): Claude appends it to
    // the system prompt; Codex prefixes it to the session's first turn.
    if (s.memoryReadEnabled) {
      if (!this.memoryPreamble)
        this.memoryPreamble = await readBootContext(this.app, {
          agentFolderEnabled: s.agentFolderEnabled,
        });
      memoryPreamble = this.memoryPreamble || undefined;
      // Tell the agent the union store exists whenever its tools are registered
      // (obsidian tools on + memory read on ⇒ `recall`, +write ⇒ `remember`).
      // With proactive recall ON, swap in the variant that says memories are
      // auto-provided (the model needn't decide to call `recall`).
      if (useObsidian) {
        const note = s.proactiveRecall ? MEMORY_STORE_NOTE_PROACTIVE : MEMORY_STORE_NOTE;
        memoryPreamble = (memoryPreamble ? `${memoryPreamble}\n\n` : "") + note;
        // The Agent Is the Folder: when the identity layer is on and its tool is
        // registered, tell the model when to `rethink` (world-model change, not
        // episodic notes — those go to `remember`).
        if (s.memoryWriteEnabled && s.agentFolderEnabled) {
          memoryPreamble = `${memoryPreamble}\n\n${AGENT_FOLDER_NOTE}`;
        }
      }
    }

    // Codex ↔ Obsidian tools bridge (Tranche B1): same registry as Claude's SDK
    // server, swapped per session. SANDBOX HONESTY: bridge writes happen in the
    // Obsidian process and bypass codex's sandbox, so a read-only sandbox gets
    // read tools only.
    // Known limitation (v1): ONE toolset shared across codex sessions — see "Out of scope" in the design doc for the singleton ask_user routing caveat.
    // rethink_memory is deliberately not wired over this bridge yet (v1 scope) — see the same doc section.
    let codexBridge: { port: number; token: string; scriptPath: string } | undefined;
    if (
      c.provider === "codex" &&
      s.obsidianToolsEnabled &&
      s.toolsEnabled &&
      (await this.plugin.checkNodeForBridge(cli.pathEnv))
    ) {
      const b = await this.plugin.ensureCodexBridge();
      if (b) {
        const readOnlySandbox = s.codexSandbox === "read-only";
        const all = buildObsidianTools(this.app, {
          memoryWrite: s.memoryWriteEnabled && !readOnlySandbox,
          memoryRead: s.memoryReadEnabled,
          // Per-session server + per-convo closure: ask_user always renders into
          // the conversation that owns this session, never a parallel one.
          askBridge: (qs) => this.askBridge(c, qs),
          memoryWriteQueue: this.plugin.memoryWriteQueue,
          loopsWriteQueue: this.plugin.loopsWriteQueue,
          orchestrationEnabled: s.orchestrationEnabled && !readOnlySandbox,
          tasksWriteQueue: this.plugin.tasksWriteQueue,
        });
        const READ_BASENAMES = new Set(
          [...OBSIDIAN_READ_TOOLS].map((n) => n.replace("mcp__obsidian__", ""))
        );
        b.bridge.setTools(
          readOnlySandbox ? all.filter((t) => READ_BASENAMES.has(t.name) || t.name === "ask_user") : all
        );
        codexBridge = { port: b.bridge.port, token: b.bridge.token, scriptPath: b.scriptPath };
      }
    }

    const session = ADAPTERS[c.provider].createSession({
      cli,
      model: c.model,
      effort: s.effort,
      systemPrompt: s.systemPrompt || undefined,
      cwd: this.vaultPath(),
      permissionMode: s.permissionMode,
      toolsEnabled: s.toolsEnabled,
      fastStartup: s.fastStartup,
      runHooks: s.runHooks,
      resumeSessionId: c.sessionId,
      obsidianServer,
      nativeFirst: useObsidian && s.nativeFirst,
      memoryPreamble,
      autoCompact: s.autoCompactEnabled && c.provider === "claude",
      sandboxMode: s.codexSandbox,
      approvalPolicy: s.codexApproval,
      codexBridge,
    });
    // Capability snapshot (system/init, CLI ≥2.1.199): the real skills/commands/
    // agents/MCP this session sees. Cache view-wide for the autocomplete menus
    // and the Capabilities panel; older CLIs simply never fire this (no gate).
    session.onCaps = (caps) => {
      this.sessionCaps = caps;
      // Settings MCP manager + cockpit read live status here; the persisted copy
      // seeds menus/panels on the next app run, before any session has spawned.
      this.plugin.lastSessionCaps = caps;
      this.plugin.settings.cachedSessionCaps = caps;
      void this.plugin.saveSettings();
      // A registered MCP server reporting a failure status means its tools are
      // silently absent — the "all my vault tools vanished, senza motivo" case.
      // Surface it once (not just as a dot in a panel). "unknown" is skipped: it's
      // the transient default before a server finishes connecting at startup.
      for (const s of caps.mcpServers) {
        if (/fail|error|disconnect/i.test(s.status)) {
          if (!this.warnedDegradedMcp.has(s.name)) {
            this.warnedDegradedMcp.add(s.name);
            this.diag.push("mcp", `server ${s.name} not connected: ${s.status}`);
            new Notice(`Exo: the "${s.name}" tool server isn't connected (${s.status}) — its tools are unavailable.`);
          }
        } else if (s.status === "connected") {
          // Recovered → clear the dedupe so a later re-failure warns again.
          this.warnedDegradedMcp.delete(s.name);
        }
      }
      this.composer.resetSlashCache(); // menus rebuild with the enriched lists
      if (this.capsEl) {
        this.hideCapabilities();
        this.showCapabilities(); // live panel refresh if it's open
      }
    };
    // Superseded while awaiting (newer spawn or dropSession): don't install —
    // dispose the fresh session so it can't leak as an orphaned CLI process.
    if (this.spawnSeq.get(c) !== seq) {
      session.dispose();
      throw new Error("Session spawn superseded.");
    }
    c.session = session;
    c.sessionSig = sig;
    return session;
  }

  private dropSession(c: Convo): void {
    if (c.session) this.diag.push("session", `drop convo=${c.id}`);
    // Supersede any in-flight spawn so it can't install a session after the drop.
    this.spawnSeq.set(c, (this.spawnSeq.get(c) ?? 0) + 1);
    this.sessionInit.delete(c);
    c.session?.dispose();
    c.session = null;
    c.sessionSig = "";
    // Abort any in-flight AI-title call for this conversation (dropSession is the
    // teardown path for close/delete/reset — the title becomes moot).
    c.titleAbort?.abort();
    c.titleAbort = null;
  }

  /** Spin up the active conversation's CLI session in the background so the first
   *  message skips the cold start. No-op if disabled, already warm, streaming, or
   *  on Codex (spawn-per-turn model — nothing to warm). Errors are swallowed; a
   *  real send surfaces them through the normal UX. */
  private prewarm(): void {
    if (!this.plugin.settings.prewarmSession) return;
    const c = this.active;
    if (!c || c.provider !== "claude" || c.session || c.streaming) return;
    void this.ensureSession(c).catch(() => {});
  }

  /* ----------------------------- header ----------------------------- */

  /** Make a non-button element keyboard- and screen-reader-operable. Thin wrapper
   *  over the shared `clickable()` in ./ui/dom so view.ts and capabilities.ts route
   *  every keyboard-bypassing control through one implementation. */
  private clickable(el: HTMLElement, handler: (e: Event) => void): void {
    clickable(el, handler);
  }

  private buildHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: "mva-header" });
    this.brandDot = header.createSpan({ cls: "mva-brand-icon" });
    setIcon(this.brandDot, EXO_ICON);
    header.createSpan({ cls: "mva-brand-name", text: "Exo" });
    header.createDiv({ cls: "mva-spacer" }).style.flex = "1";

    const caps = header.createEl("button", { cls: "mva-icon-btn", attr: { "aria-label": "Capabilities" } });
    setIcon(caps, "blocks");
    setTooltip(caps, "Capabilities");
    caps.onclick = () => this.toggleCapabilities();

    const histBtn = header.createEl("button", { cls: "mva-icon-btn", attr: { "aria-label": "History" } });
    setIcon(histBtn, "history");
    setTooltip(histBtn, "History");
    histBtn.onclick = () => this.toggleGallery();

    const newChat = header.createEl("button", { cls: "mva-icon-btn", attr: { "aria-label": "New chat" } });
    setIcon(newChat, "plus");
    setTooltip(newChat, "New chat");
    newChat.onclick = () => this.newConversation();
  }

  /** Switch provider (and, when the model picker jumps to another backend,
   *  the exact model chosen there — not just that provider's remembered
   *  default). No separate Provider chip exists; this is reached only from
   *  the unified model picker's onSelect when the chosen model belongs to a
   *  different provider than the active one. */
  private onProviderChange(next: ProviderId, explicitModel?: string): void {
    if (next === this.provider) return;
    if (this.streaming) {
      new Notice("Can't switch provider while a reply is streaming.");
      return;
    }
    this.provider = next;
    this.model = explicitModel ?? (next === "claude" ? this.plugin.settings.claudeModel : this.plugin.settings.codexModel);
    this.active.provider = next;
    this.persistModel(); // writes this.model into the right provider's settings slot + active.model
    this.active.sessionId = undefined;
    this.active.allow.clear();
    this.dropSession(this.active);
    this.active.usage = undefined;
    this.composer.updateUsage(null);
    this.refreshProviderUI();
    this.composer.refreshPerm();
    // Provider changed (e.g. back to Claude) — warm the new session.
    this.prewarm();
  }

  /** All selectable models across BOTH providers (built-in + custom + current),
   *  for the unified model picker — selecting one implicitly picks its provider. */
  private allModelChoices(): { id: string; label: string; provider: ProviderId }[] {
    const out: { id: string; label: string; provider: ProviderId }[] = [];
    for (const provider of ["claude", "codex"] as ProviderId[]) {
      const a = ADAPTERS[provider];
      const seen = new Set<string>();
      for (const m of a.models()) {
        out.push({ id: m.id, label: m.label, provider });
        seen.add(m.id);
      }
      const custom = provider === "claude"
        ? this.plugin.settings.claudeCustomModels
        : this.plugin.settings.codexCustomModels;
      for (const id of custom.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, label: id, provider });
      }
      if (provider === this.provider && this.model && !seen.has(this.model)) {
        out.push({ id: this.model, label: this.model, provider });
      }
    }
    return out;
  }

  private refreshProviderUI(): void {
    const a = ADAPTERS[this.provider];
    // Provider identity tints the brand star. All interactive accents follow
    // the theme (--mva-brand defaults to --interactive-accent in CSS).
    this.brandDot.style.color = a.brandColor;
    this.composer.refreshModel();
  }

  private persistModel(): void {
    if (this.active) this.active.model = this.model;
    if (this.provider === "claude") this.plugin.settings.claudeModel = this.model;
    else this.plugin.settings.codexModel = this.model;
    void this.plugin.saveSettings();
  }

  /* ------------------------- persistence ---------------------------- */

  private async restore(): Promise<void> {
    const raw = (await this.plugin.loadConversations()) as ConvoData[];
    // Only build transcript DOM for conversations that will actually be shown
    // (open tabs + the active one). Everything else renders lazily on first
    // open (switchTo) — with dozens of stored conversations this is the bulk
    // of the view's startup cost.
    const wantDom = new Set([...(this.plugin.settings.openTabIds ?? []), this.plugin.settings.activeTabId]);
    // First pass: seed the id counter from the highest numeric id suffix present,
    // NOT the conversation count — ids climb past the count after deletions and
    // MAX_CONVOS trimming, so a count-based seed produces colliding ids.
    convoSeed = Math.max(convoSeed, maxIdSuffix(Array.isArray(raw) ? raw.map((d) => d?.id) : []));
    // Second pass: build convos, reassigning any duplicate id to a fresh unique one
    // so distinct conversations never collide in id-keyed lookups. First occurrence
    // keeps the original id (so openTabIds/activeTabId still resolve to it). The
    // allocator owns the counter; sync it back into the module-global convoSeed
    // (shared with makeConvo across view instances) after the pass.
    const idAlloc = makeIdAllocator(convoSeed);
    const seenIds = new Set<string>();
    for (const d of raw) {
      if (!d || !Array.isArray(d.messages)) continue;
      const id = idAlloc.assign(d.id, seenIds);
      const provider: ProviderId = d.provider === "codex" ? "codex" : "claude";
      // Pre-0.11.2 conversations persisted an empty model id (the old, now-removed
      // "Default" option — silently let the CLI pick). Repair to a real model so
      // the chip never falls back to displaying an unlabeled/empty selection.
      const model = d.model || ADAPTERS[provider].models()[0].id;
      const c: Convo = {
        id,
        listEl: createDiv({ cls: "mva-list" }),
        title: d.title || "New chat",
        sessionId: d.sessionId,
        provider,
        model,
        allow: new Set(),
        updatedAt: d.updatedAt,
        usage: d.usage,
        researchMode: normalizeResearchModeState(d.researchMode),
        messages: d.messages.map((m) => revivePersistedMessage(m)),
        session: null,
        sessionSig: "",
        streaming: false,
        stopped: false,
        pendingPerm: null,
        pendingAsk: null,
        queue: [],
        pendingEl: null,
        currentCtx: null,
        tailSurfaceEl: null,
        compactNudged: false,
        cadence: initialCadenceState(),
        cadenceTurnFlushLen: 0,
      };
      if (wantDom.has(c.id)) this.renderConvoDom(c);
      this.wireScroll(c);
      this.convos.push(c);
    }
    convoSeed = idAlloc.seed; // keep the module-global counter in step with the allocator

    const byId = new Map(this.convos.map((c) => [c.id, c]));
    const s = this.plugin.settings;
    if (this.convos.length === 0) {
      this.active = this.makeConvo();
      this.convos.push(this.active);
    } else {
      this.active = byId.get(s.activeTabId) ?? this.convos[this.convos.length - 1];
      this.provider = this.active.provider;
      this.model = this.active.model;
    }

    // Restore the open-tab set (filter to still-existing convos); fall back to active.
    this.openTabs = (s.openTabIds ?? []).filter((id) => byId.has(id));
    if (!this.openTabs.includes(this.active.id)) this.openTabs.push(this.active.id);
    if (this.openTabs.length === 0) this.openTabs = [this.active.id];

    // Safety: if the active fell back to a convo outside the saved tab set
    // (stale activeTabId), its DOM wasn't pre-built above — build it now.
    if (this.active.messages.length && this.active.listEl.childElementCount === 0) {
      this.renderConvoDom(this.active);
    }
    this.listHost.empty();
    this.listHost.appendChild(this.active.listEl);
    if (this.active.messages.length === 0) this.renderEmptyState();
    this.refreshProviderUI();
    this.renderTabs();
    this.scrollToBottom();
    this.renderTailSurfacing(this.active);
    this.rebuildOutline();
  }

  private serialize(): ConvoData[] {
    this.saveActive();
    const all = this.convos.includes(this.active) ? this.convos : [...this.convos, this.active];
    // Drop empty "New chat" husks (unless pinned: active/open tab) and evict by
    // recency (updatedAt desc), keeping pinned always and preserving original
    // array order. See core/persistence for the full contract.
    const kept = planPersistedConvos(all, this.active.id, this.openTabs, MAX_CONVOS);
    return kept.map((c) => ({
      id: c.id,
      title: c.title,
      provider: c.provider,
      model: c.model,
      sessionId: c.sessionId,
      updatedAt: c.updatedAt,
      usage: c.usage,
      researchMode: c.researchMode,
      messages: c.messages.map((message) => persistMessage(message, {
        maxToolOutput: MAX_PERSIST_OUTPUT,
        maxCheckpointFile: MAX_CHECKPOINT_FILE,
      })),
    }));
  }

  private persist(): void {
    void this.plugin.saveConversations(this.serialize()).then((ok) => {
      if (ok) return;
      // Throttle so a persistent disk problem doesn't spam a Notice every turn.
      const now = Date.now();
      if (now - this.lastPersistErrorNotice > 30_000) {
        this.lastPersistErrorNotice = now;
        new Notice("Exo couldn't save conversation history — check disk space and vault permissions.");
      }
    });
  }

  /* ------------------------- conversations -------------------------- */

  private makeConvo(): Convo {
    const c: Convo = {
      id: `c${++convoSeed}`,
      listEl: createDiv({ cls: "mva-list" }),
      title: "New chat",
      provider: this.provider,
      model: this.model,
      allow: new Set(),
      messages: [],
      session: null,
      sessionSig: "",
      streaming: false,
      stopped: false,
      pendingPerm: null,
      pendingAsk: null,
      queue: [],
      researchMode: initialResearchModeState(),
      pendingEl: null,
      currentCtx: null,
      tailSurfaceEl: null,
      compactNudged: false,
      cadence: initialCadenceState(),
      cadenceTurnFlushLen: 0,
    };
    this.wireScroll(c);
    return c;
  }

  private saveActive(): void {
    if (!this.active) return;
    this.active.provider = this.provider;
    this.active.model = this.model;
  }

  private newConversation(target?: { provider: ProviderId; model: string }): void {
    if (this.galleryEl) this.hideGallery();
    if (this.capsEl) this.hideCapabilities();
    // Keep other conversations (and their live sessions) alive — parallel.
    this.saveActive();
    if (!this.convos.includes(this.active)) this.convos.push(this.active);
    const c = this.makeConvo();
    if (target) {
      c.provider = target.provider;
      c.model = target.model;
    }
    this.convos.push(c);
    this.openTabs.push(c.id);
    this.switchTo(c);
    this.persist();
  }

  private switchTo(c: Convo): void {
    if (c === this.active) return;
    if (this.capsEl) this.hideCapabilities();
    this.saveActive();
    this.active.draft = this.composer.getDraft();
    if (!this.convos.includes(this.active)) this.convos.push(this.active);
    this.active = c;
    if (!this.openTabs.includes(c.id)) this.openTabs.push(c.id);
    this.provider = c.provider;
    this.model = c.model;
    // A fresh tab should always start pinned so you see the latest content.
    this.pinnedToBottom = true;
    this.updateJumpPill();
    // Lazily build the transcript DOM on first open (restore() skips convos
    // that weren't in the saved tab set).
    if (c.messages.length && c.listEl.childElementCount === 0) this.renderConvoDom(c);
    this.listHost.empty();
    this.listHost.appendChild(c.listEl);
    if (c.listEl.childElementCount === 0) this.renderEmptyState();
    this.refreshProviderUI();
    this.syncSendButton();
    this.composer.updateUsage(c.usage ?? null);
    this.composer.setDraft(c.draft);
    this.composer.refreshResearch();
    // Reflect the newly-active convo's session quota (if any) on the badge.
    this.composer.setLastRateLimit((c.session as { rateLimit?: RateLimitInfo | null } | null)?.rateLimit ?? null);
    this.composer.updateRateBadge();
    this.renderTabs();
    this.persistTabs();
    this.scrollConvo(c);
    this.renderTailSurfacing(c);
    this.rebuildOutline();
    this.updateRecap();
    this.prewarm();
  }

  /* ----------------------------- tab bar ---------------------------- */

  /** Render the open-conversation tab strip. */
  private renderTabs(): void {
    if (!this.tabsEl) return;
    this.tabsEl.empty();
    const ids = this.openTabs.filter((id) => this.convos.some((c) => c.id === id));
    this.openTabs = ids;
    // A lone empty tab needs no bar — keep the chrome minimal.
    if (ids.length <= 1) {
      this.tabsEl.addClass("is-hidden");
      return;
    }
    this.tabsEl.removeClass("is-hidden");
    for (const id of ids) {
      const c = this.convos.find((x) => x.id === id);
      if (!c) continue;
      const tab = this.tabsEl.createDiv({ cls: "mva-tab" + (c === this.active ? " is-active" : "") });
      const dot = tab.createSpan({ cls: "mva-tab-dot" });
      dot.style.background = ADAPTERS[c.provider].brandColor;
      if (c.streaming) tab.addClass("is-streaming");

      // Detect placeholder tabs (untitled, no messages yet) and render with distinct styling
      const isPlaceholder = !c.title || (c.title === "New chat" && c.messages.length === 0);
      const titleEl = tab.createSpan({ cls: "mva-tab-title" + (isPlaceholder ? " is-placeholder" : "") });

      if (isPlaceholder) {
        setIcon(titleEl, "pencil");
        titleEl.append("New chat");
      } else {
        titleEl.setText(c.title || "New chat");
      }

      // Per-tab agent count: how many subagents/background tasks THIS chat is
      // running right now — local to its own tab, so a busy background chat is
      // visible at a glance without leaking into the chat you're reading.
      const agents = this.agentCount(c);
      if (agents > 0) {
        const badge = tab.createSpan({
          cls: "mva-tab-agents",
          attr: { "aria-label": `${agents} agent${agents > 1 ? "s" : ""} running` },
        });
        setIcon(badge.createSpan({ cls: "mva-tab-agents-icon" }), "loader");
        badge.createSpan({ text: String(agents) });
      }

      const x = tab.createSpan({ cls: "mva-tab-x", attr: { "aria-label": "Close tab" } });
      setIcon(x, "x");
      this.clickable(x, (e) => {
        e.stopPropagation();
        this.closeTab(c);
      });
      this.clickable(tab, () => this.switchTo(c));
    }
    const add = this.tabsEl.createDiv({ cls: "mva-tab-add", attr: { "aria-label": "New tab" } });
    setIcon(add, "plus");
    this.clickable(add, () => this.newConversation());
  }

  /** Close a tab (the conversation stays in history; reopen from the gallery). */
  private closeTab(c: Convo): void {
    const idx = this.openTabs.indexOf(c.id);
    if (idx === -1) return;
    this.openTabs.splice(idx, 1);
    this.dropSession(c); // free the live session; resumable from history
    if (c === this.active) {
      const nextId = this.openTabs[idx] ?? this.openTabs[idx - 1] ?? this.openTabs[this.openTabs.length - 1];
      const next = nextId ? this.convos.find((x) => x.id === nextId) : undefined;
      if (next) {
        this.switchTo(next); // this.active is still `c` here, so this runs
      } else {
        // No tabs left — open a fresh one.
        const fresh = this.makeConvo();
        this.convos.push(fresh);
        this.openTabs.push(fresh.id);
        this.switchTo(fresh);
      }
    } else {
      this.renderTabs();
      this.persistTabs();
    }
    this.persist();
  }

  /** Fork the active conversation into a new tab. The transcript is copied but
   *  the provider session is not: reusing the same opaque session id makes the
   *  original and fork share hidden context and breaks branch isolation. */
  private forkConversation(src: Convo): void {
    const c = this.makeConvo();
    c.title = src.title ? `${src.title} (fork)` : "Fork";
    c.provider = src.provider;
    c.model = src.model;
    c.sessionId = undefined;
    c.messages = src.messages.map((m) =>
      m.role === "assistant" ? { role: "assistant", segments: [...m.segments] } : { ...m }
    );
    c.updatedAt = Date.now();
    this.renderConvoDom(c);
    this.convos.push(c);
    this.openTabs.push(c.id);
    this.switchTo(c);
    this.persist();
    new Notice("Forked conversation into a new tab.");
  }

  /** Clear the active conversation to a fresh session, keeping the tab. */
  private newSessionInTab(): void {
    const c = this.active;
    this.dropSession(c);
    c.messages = [];
    c.sessionId = undefined;
    c.allow.clear();
    c.queue = [];
    c.researchMode = initialResearchModeState();
    c.title = "New chat";
    c.updatedAt = Date.now();
    c.listEl.empty();
    c.pendingEl = null;
    this.renderEmptyState();
    c.usage = undefined;
    this.composer.updateUsage(null);
    this.renderTabs();
    this.persist();
  }

  private persistTabs(): void {
    this.plugin.settings.openTabIds = [...this.openTabs];
    this.plugin.settings.activeTabId = this.active?.id ?? "";
    void this.plugin.saveSettings();
  }

  /* ----- command entry points (called from main.ts) ----- */
  cmdNewTab(): void {
    this.newConversation();
  }
  cmdNewSession(): void {
    this.newSessionInTab();
  }
  cmdCloseTab(): void {
    this.closeTab(this.active);
  }
  cmdForkConversation(): void {
    this.forkConversation(this.active);
  }
  cmdCompact(): void {
    this.compactActive();
  }

  /** "Promote to task" (flag-gated in main.ts, only registered when
   *  `orchestrationEnabled` is true): take the active conversation's last user
   *  message and create a `backlog` task from it, through the SAME task-store
   *  path (`createBacklogTask` + the plugin's shared `tasksWriteQueue`) the
   *  `add_task` chat tool uses — never a direct vault write. Scope kept
   *  minimal per the board design: no new UI, just the simplest reuse of the
   *  existing quick-add/task-store path. */
  async cmdPromoteToTask(): Promise<void> {
    const lastUser = [...this.active.messages].reverse().find((m): m is Extract<Message, { role: "user" }> =>
      m.role === "user" && m.text.trim().length > 0
    );
    if (!lastUser) {
      new Notice("No user message in this conversation to promote yet.");
      return;
    }
    const vault = adaptAppToTaskVault(this.app);
    const title = lastUser.text.trim().split("\n")[0].slice(0, 80);
    try {
      const entry = await createBacklogTask(vault, this.plugin.tasksWriteQueue, {
        title,
        prompt: lastUser.text.trim(),
      });
      new Notice(`Added to Backlog: ${entry.title}`);
    } catch (e) {
      new Notice(`Couldn't create the task: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Open a fresh conversation (new tab, current default provider/model) seeded
   * with `text`. When `autoSend` is true the query is dispatched immediately;
   * otherwise it's left in the composer, focused, for the user to edit/send.
   * Public so sibling plugins (e.g. Sonar's "Search with Exo" row) can launch a
   * default chat from an external query.
   *
   * Returns the new conversation's id — or "" when `text` is blank and nothing
   * was created. The return value and `opts.model` override are additive:
   * existing callers (`askExo` in main.ts) pass neither and ignore the return,
   * so external behavior is unchanged. The model override falls back to the
   * settings default per provider.
   */
  askInNewConversation(
    text: string,
    autoSend = true,
    opts?: { model?: string; sendPrefix?: string }
  ): string {
    const q = text.trim();
    if (!q) return "";
    const provider = this.plugin.settings.provider;
    const model =
      opts?.model ??
      (provider === "claude" ? this.plugin.settings.claudeModel : this.plugin.settings.codexModel);
    this.newConversation({ provider, model });
    const id = this.active.id;
    this.composer.setInputValue(q);
    this.composer.autoGrow();
    if (autoSend) {
      // One-shot handoff directive: send() consumes it into runTurn's
      // sendPrefix so it rides the outbound message, never the visible bubble.
      this.handoffPrefix = opts?.sendPrefix ?? null;
      this.send();
    } else this.composer.focusInput();
    return id;
  }

  /**
   * Additive public entry point for the Orchestration Board: spawn a new
   * conversation seeded with `prompt`, send it immediately, honor an optional
   * model override (falling back to the settings default), and return the new
   * convo id. Chat-only — no board coupling.
   *
   * Focus contract (2026-07-08): a task spawn is a background/system action, so
   * it must not hijack the user's ACTIVE TAB either — `askInNewConversation`
   * switches to the new convo to seed and send through the composer, so after
   * the send we switch back to whatever was active before. Parallel
   * conversations make this safe: the new convo's turn runs per-convo,
   * independent of which tab is displayed. When there was no prior active
   * convo (fresh view), the new one simply stays active.
   */
  startTaskConversation(prompt: string, opts?: { model?: string }): string {
    const prev = this.active ?? null;
    const id = this.askInNewConversation(prompt, true, opts);
    if (id && prev && prev.id !== id && this.convos.includes(prev)) this.switchTo(prev);
    return id;
  }

  /**
   * Read API for board reconciliation (workstream B5): report whether a convo
   * still exists in this view and whether it's mid-turn / waiting on input.
   * Pure read — never mutates chat state.
   */
  readConvoState(convoId: string): { exists: boolean; streaming: boolean; hasPending: boolean } {
    const c = this.convos.find((x) => x.id === convoId) ?? (this.active?.id === convoId ? this.active : undefined);
    if (!c) return { exists: false, streaming: false, hasPending: false };
    return { exists: true, streaming: c.streaming, hasPending: !!(c.pendingPerm || c.pendingAsk) };
  }

  /**
   * Additive public selector for the Orchestration Board (workstream B5): make
   * the conversation with `convoId` the active tab, so clicking a board card
   * focuses that task's chat. Returns true if the convo was found and revealed,
   * false otherwise (e.g. the recorded convo no longer exists). Pure reveal —
   * never spawns or mutates a conversation; it reuses the existing `switchTo`
   * path (which lazily builds the transcript DOM and opens the tab). Kept
   * additive: no existing caller relies on it, so ChatView's structure is
   * untouched.
   */
  revealConversation(convoId: string): boolean {
    if (this.active?.id === convoId) {
      this.focusComposer();
      return true;
    }
    const c = this.convos.find((x) => x.id === convoId);
    if (!c) return false;
    this.switchTo(c);
    this.focusComposer();
    return true;
  }

  /** Toggle plan mode (Shift+Tab) — explore & propose before editing. */
  private togglePlanMode(): void {
    const s = this.plugin.settings;
    const next = s.permissionMode === "plan" ? "default" : "plan";
    // Remember the mode we're leaving so approving a plan can restore it exactly
    // (rather than always dropping to "default").
    if (next === "plan") this.prePlanMode = s.permissionMode;
    s.permissionMode = next;
    void this.plugin.saveSettings();
    this.composer.refreshPerm();
    this.active.session?.setPermissionMode?.(next);
    new Notice(next === "plan" ? "Plan mode on — the agent will propose before acting." : "Plan mode off.");
  }

  /** Research Mode is isolated to the active conversation and persists with it. */
  private toggleResearchMode(): void {
    const c = this.active;
    c.researchMode = nextResearchMode(c.researchMode, Date.now());
    this.composer.refreshResearch();
    this.updateRecap();
    this.persist();
    if (c.researchMode.enabled) this.composer.focusInput();
  }
  cmdTogglePlan(): void {
    this.togglePlanMode();
  }

  /** Manually compact the active conversation's context (Claude), optionally
   *  steered by free-text `instructions` (from the /compact slash command). */
  private compactActive(instructions?: string): void {
    const c = this.active;
    if (c.streaming) {
      new Notice("Wait for the current turn to finish, then compact.");
      return;
    }
    if (c.provider !== "claude") {
      // Codex has no session-level compact API (TUI-only) — emulate by
      // dropping the session: the cold-reseed invariant (shouldColdReseed in
      // runTurn) threads a transcript recap into the next turn automatically.
      // Only the user's compaction focus needs carrying, as a provider-only
      // prefix (never UI/persisted).
      if (!c.messages.length) {
        new Notice("Send a message first — nothing to compact yet.");
        return;
      }
      this.dropSession(c);
      c.sessionId = undefined;
      c.pendingSendPrefix = instructions ? `Compaction focus from the user: ${instructions}` : undefined;
      c.usage = undefined;
      this.composer.updateUsage(null);
      c.compactNudged = true;
      this.composer.hideCompactNudge();
      new Notice("Compacted — the next message restarts the session with a summary.");
      return;
    }
    if (!c.session?.compact) {
      new Notice("Send a message first — nothing to compact yet.");
      return;
    }
    c.session.compact(instructions);
    // Any compaction retires the proactive nudge for good.
    c.compactNudged = true;
    this.composer.hideCompactNudge();
    new Notice(instructions ? "Compacting with your instructions…" : "Compacting the conversation…");
  }

  /** Reflect the active conversation's streaming state on the send button. */
  private syncSendButton(): void {
    const on = this.streaming;
    const sendBtn = this.composer.getSendBtn();
    sendBtn.empty();
    setIcon(sendBtn, on ? "square" : "arrow-up");
    setTooltip(sendBtn, on ? "Stop" : "Send");
    sendBtn.toggleClass("is-streaming", on);
  }

  private toggleGallery(): void {
    if (this.galleryEl) this.hideGallery();
    else {
      if (this.capsEl) this.hideCapabilities();
      this.showGallery();
    }
  }

  private hideGallery(): void {
    this.galleryEl?.remove();
    this.galleryEl = null;
    this.listEl.show();
    this.composer.getComposerEl().show();
    this.rebuildOutline();
  }

  /* -------------------------- capabilities -------------------------- */

  private toggleCapabilities(): void {
    if (this.capsEl) this.hideCapabilities();
    else this.showCapabilities();
  }

  private hideCapabilities(): void {
    this.capsEl?.remove();
    this.capsEl = null;
    this.listEl.show();
    this.rebuildOutline();
  }

  private showCapabilities(): void {
    if (this.galleryEl) this.hideGallery();
    this.listEl.hide();
    const wrap = this.listHost.createDiv({ cls: "mva-gallery-wrap" });
    this.capsEl = wrap;
    this.rebuildOutline(); // drop the outline rail while capabilities is up
    void renderCapabilitiesPanel(wrap, this.app, this.plugin.settings, {
      provider: this.provider,
      model: this.model,
      caps: this.sessionCaps ?? this.plugin.lastSessionCaps,
      onInsert: (text) => {
        this.hideCapabilities();
        const el = this.composer.getInputEl();
        el.value += (el.value && !el.value.endsWith(" ") ? " " : "") + text;
        el.focus();
      },
      onOpenNote: (p) => {
        this.hideCapabilities();
        this.openNote(p);
      },
      runCommand: (id) =>
        (this.app as unknown as { commands: { executeCommandById(id: string): boolean } }).commands.executeCommandById(id),
      openSettings: () => this.openSettings(),
      dreamSnapshotPresent: () => this.plugin.loadDreamSnapshot().then((s) => !!s),
      lastAutoCommitEpoch: () => this.plugin.lastAutoCommitEpoch(),
      queuePending: () => this.plugin.countQueuePending(),
    });
  }

  private showGallery(): void {
    this.saveActive();
    if (!this.convos.includes(this.active)) this.convos.push(this.active);
    this.listEl.hide();
    this.composer.getComposerEl().hide();
    const wrap = this.listHost.createDiv({ cls: "mva-gallery-wrap" });
    this.galleryEl = wrap;
    this.rebuildOutline(); // drop the outline rail while the gallery is up
    wrap.createDiv({ cls: "mva-gallery-title", text: "Conversations" });

    const sorted = [...this.convos]
      .filter((c) => c.messages.length > 0 || c === this.active)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

    if (sorted.length === 0) {
      wrap.createDiv({ cls: "mva-gallery" }).createDiv({ cls: "mva-empty-sub", text: "No conversations yet." });
      return;
    }

    const searchWrap = wrap.createDiv({ cls: "mva-gallery-search-wrap" });
    setIcon(searchWrap.createSpan({ cls: "mva-gallery-search-ico" }), "search");
    const search = searchWrap.createEl("input", {
      cls: "mva-gallery-search",
      attr: { type: "text", placeholder: "Search conversations…" },
    });
    const grid = wrap.createDiv({ cls: "mva-gallery" });
    const renderGrid = (q: string) => {
      grid.empty();
      const ql = q.toLowerCase().trim();
      const matches = ql ? sorted.filter((c) => this.convoMatches(c, ql)) : sorted;
      if (matches.length === 0) {
        grid.createDiv({ cls: "mva-empty-sub", text: "No matching conversations." });
        return;
      }
      for (const c of matches) this.renderCard(grid, c);
    };
    search.addEventListener("input", () => renderGrid(search.value));
    renderGrid("");
  }

  private renderCard(grid: HTMLElement, c: Convo): void {
    const card = grid.createDiv({ cls: "mva-card" });
    // A conversation is "active" when it's the focused tab, and "open" when it's
    // any of the tabs currently in the tab strip. Both get a visible marker so the
    // gallery mirrors what's open above it.
    const isActive = c === this.active;
    const isOpen = this.openTabs.includes(c.id);
    if (isActive) card.addClass("is-active");
    if (isOpen) card.addClass("is-open");
    this.addCardDelete(card, grid, c);
    const head = card.createDiv({ cls: "mva-card-head" });
    const dot = head.createSpan({ cls: "mva-dot" });
    dot.style.background = ADAPTERS[c.provider].brandColor;
    dot.style.color = ADAPTERS[c.provider].brandColor;

    // Detect placeholder conversations and render with distinct styling for consistency
    const isPlaceholder = !c.title || (c.title === "New chat" && c.messages.length === 0);
    const titleEl = head.createSpan({ cls: "mva-card-title" + (isPlaceholder ? " is-placeholder" : "") });

    if (isPlaceholder) {
      setIcon(titleEl, "pencil");
      titleEl.append("New chat");
    } else {
      titleEl.setText(c.title || "New chat");
    }

    if (isOpen) {
      head.createSpan({
        cls: "mva-card-open-badge" + (isActive ? " is-active" : ""),
        text: isActive ? "Active" : "Open",
      });
    }

    const preview = this.convoPreview(c);
    card.createDiv({ cls: "mva-card-preview", text: preview || "Empty conversation" });

    const meta = card.createDiv({ cls: "mva-card-meta" });
    meta.createSpan({ text: ADAPTERS[c.provider].displayName });
    const count = c.messages.filter((m) => m.role === "user").length;
    meta.createSpan({ text: `${count} message${count === 1 ? "" : "s"}` });
    if (c.updatedAt) meta.createSpan({ text: this.formatDate(c.updatedAt) });

    this.clickable(card, () => {
      this.hideGallery();
      this.switchTo(c);
    });
  }

  /** Trash button on a gallery card: two-step confirm (arm → delete), reusing the
   *  note-revert arming pattern. Never bubbles to the card's open handler. */
  private addCardDelete(card: HTMLElement, grid: HTMLElement, c: Convo): void {
    const del = card.createSpan({ cls: "mva-gal-del", attr: { "aria-label": "Delete conversation" } });
    setIcon(del, "trash-2");
    let armed = false;
    let disarmTimer: number | null = null;
    const outside = (ev: MouseEvent) => {
      if (ev.target !== del && !del.contains(ev.target as Node)) disarm();
    };
    const disarm = () => {
      armed = false;
      del.removeClass("is-armed");
      del.setAttr("aria-label", "Delete conversation");
      if (disarmTimer) {
        window.clearTimeout(disarmTimer);
        disarmTimer = null;
      }
      document.removeEventListener("click", outside, true);
    };
    this.clickable(del, (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        del.addClass("is-armed");
        del.setAttr("aria-label", "Click again to delete");
        disarmTimer = window.setTimeout(disarm, 3000);
        document.addEventListener("click", outside, true);
        return;
      }
      disarm();
      this.deleteConvo(c, card, grid);
    });
  }

  /** Permanently drop a conversation (from the gallery). If it's the active tab,
   *  switch to a neighbor — or a fresh convo when none remain — exactly like the
   *  close-tab flow, but keep the gallery open and just remove its card. */
  private deleteConvo(c: Convo, card: HTMLElement, grid: HTMLElement): void {
    this.dropSession(c);
    const tabIdx = this.openTabs.indexOf(c.id);
    if (tabIdx !== -1) this.openTabs.splice(tabIdx, 1);
    const convoIdx = this.convos.indexOf(c);
    if (convoIdx !== -1) this.convos.splice(convoIdx, 1);

    if (c === this.active) {
      const nextId =
        this.openTabs[tabIdx] ?? this.openTabs[tabIdx - 1] ?? this.openTabs[this.openTabs.length - 1];
      let next = nextId ? this.convos.find((x) => x.id === nextId) : undefined;
      if (!next) next = this.convos[0];
      if (!next) {
        next = this.makeConvo();
        this.convos.push(next);
        this.openTabs.push(next.id);
      }
      c.listEl.remove();
      this.setActiveSilently(next);
    } else {
      this.renderTabs();
      this.persistTabs();
    }

    card.remove();
    if (!grid.querySelector(".mva-card")) {
      grid.createDiv({ cls: "mva-empty-sub", text: "No conversations yet." });
    }
    this.persist();
  }

  /** Point `active` at another conversation without leaving the gallery overlay:
   *  its transcript is prepared (rendered, hidden behind the gallery) so a later
   *  hideGallery/switchTo reveals it correctly. */
  private setActiveSilently(next: Convo): void {
    this.active.draft = this.composer.getDraft();
    this.active = next;
    this.provider = next.provider;
    this.model = next.model;
    if (!this.openTabs.includes(next.id)) this.openTabs.push(next.id);
    if (next.messages.length && next.listEl.childElementCount === 0) this.renderConvoDom(next);
    next.listEl.hide(); // gallery is on top; reveal happens on hideGallery/switchTo
    this.listHost.appendChild(next.listEl);
    if (next.listEl.childElementCount === 0) this.renderEmptyState();
    this.refreshProviderUI();
    this.syncSendButton();
    this.composer.updateUsage(next.usage ?? null);
    this.composer.setDraft(next.draft);
    this.renderTabs();
    this.persistTabs();
  }

  private convoPreview(c: Convo): string {
    let s = "";
    for (const m of c.messages) {
      const part =
        m.role === "user"
          ? m.text
          : m.segments
              .map((seg) =>
                seg.t === "text"
                  ? seg.md
                  : seg.t === "error"
                    ? "⚠ response interrupted"
                  : seg.t === "ask"
                    ? "↳ asked: " + seg.questions.map((q) => q.header).join(", ")
                    : seg.t === "artifact"
                      ? "🖼 " + noteBasename(seg.path)
                      : seg.t === "plan"
                        ? "↳ plan"
                        : `↳ ${toolMeta(seg.name, seg.input).label}`
              )
              .join(" ");
      s += part.replace(/[#*`>_~]/g, "").replace(/\s+/g, " ").trim() + "  ";
      if (s.length > 320) break;
    }
    return s.trim();
  }

  /** True if the query matches a conversation's title or any of its message text. */
  private convoMatches(c: Convo, ql: string): boolean {
    if (c.title.toLowerCase().includes(ql)) return true;
    for (const m of c.messages) {
      const text =
        m.role === "user"
          ? m.text
          : m.segments.map((s) => (s.t === "text" ? s.md : "")).join(" ");
      if (text.toLowerCase().includes(ql)) return true;
    }
    return false;
  }

  private formatDate(ts: number): string {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
  }

  /* --------------------------- rendering ---------------------------- */

  private renderEmptyState(): void {
    renderEmptyState({
      app: this.app,
      listEl: this.listEl,
      exoIcon: EXO_ICON,
      customPrompts: this.plugin.settings.customPrompts,
      featureSurfacing: this.plugin.settings.featureSurfacing,
      usePrompt: (t) => this.composer.usePrompt(t),
      attachRelated: (p) => this.attachRelated(p),
      vaultSetupNeeded:
        this.plugin.settings.memoryWriteEnabled &&
        !isVaultSetUp((p) => !!this.app.vault.getAbstractFileByPath(p)),
      runVaultSetup: () => void this.plugin.runVaultSetup(),
    });
  }

  /** Attach a surfaced related note as context and focus the composer (shared by
   *  the empty-state surfacing and the in-conversation tail variant). */
  private attachRelated(p: string): void {
    this.composer.addManualAttached(p);
    this.composer.refreshContext();
    this.composer.getInputEl().focus();
  }

  /** Quieter "Related" chips appended below the last turn — only when the
   *  transcript is short enough that it leaves dead space under the viewport.
   *  Always clears any previous instance first, so callers can invoke it
   *  freely to recompute or hide. Never shows mid-stream, on background
   *  (non-active) conversations, or while the empty state is up (that has its
   *  own, bolder variant above). */
  private renderTailSurfacing(c: Convo): void {
    c.tailSurfaceEl?.remove();
    c.tailSurfaceEl = null;
    if (!this.plugin.settings.featureSurfacing) return;
    if (c.streaming) return;
    if (c !== this.active) return; // only the visible list can be measured
    if (!c.messages.length) return; // empty state owns this case
    const el = c.listEl;
    if (el.scrollHeight > el.clientHeight + 1) return; // already fills/overflows
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    const related = relatedNotes(this.app, file, 5).slice(0, 3);
    if (!related.length) return;
    const wrap = buildRelatedChips(
      el,
      related,
      {
        wrapCls: "mva-tail-surface",
        labelCls: "mva-tail-surface-label",
        labelText: "Related",
        rowCls: "mva-tail-surface-chips",
        chipCls: "mva-tail-surface-chip",
      },
      (p) => this.attachRelated(p)
    );
    c.tailSurfaceEl = wrap;
    // Adding the section itself might tip the list into overflow — undo if so.
    if (el.scrollHeight > el.clientHeight + 1) {
      wrap.remove();
      c.tailSurfaceEl = null;
    }
  }

  private clearEmptyState(c: Convo = this.active): void {
    c.listEl.querySelector(".mva-empty")?.remove();
  }

  /** Re-render the empty state (surfacing) when the active note changes, or
   *  recompute the in-conversation tail variant when there's a transcript. */
  private refreshSurfacing(): void {
    if (this.listEl.querySelector(".mva-empty")) {
      this.listEl.empty();
      this.renderEmptyState();
      return;
    }
    this.renderTailSurfacing(this.active);
  }

  /** Rebuild a conversation's DOM from its persisted messages. */
  private renderConvoDom(c: Convo): void {
    c.listEl.empty();
    let lastUser = "";
    for (const m of c.messages) {
      if (m.role === "user") {
        lastUser = m.text;
        const el = c.listEl.createDiv({ cls: "mva-turn mva-user" });
        void MarkdownRenderer.render(this.app, m.text, el.createDiv({ cls: "mva-bubble markdown-rendered" }), "", this);
        this.appendMsgTime(el, m.at);
      } else {
        const el = c.listEl.createDiv({ cls: "mva-turn mva-assistant" });
        const body = el.createDiv({ cls: "mva-assistant-body" });
        let full = "";
        const touched: TouchedNote[] = [];
        let run: StepsRun | null = null;
        const flushRun = () => {
          run?.close();
          run = null;
        };
        for (const s of m.segments) {
          if (s.t === "text") {
            flushRun();
            void MarkdownRenderer.render(this.app, s.md, body.createDiv({ cls: "mva-bubble markdown-rendered" }), "", this);
            full += s.md;
          } else if (s.t === "error") {
            flushRun();
            this.renderPersistedError(body, s.message, c, lastUser);
          } else if (s.t === "ask") {
            flushRun();
            const card = body.createDiv({ cls: "mva-ask" });
            this.renderAskSummary(card, s.questions, s.answers);
          } else if (s.t === "plan") {
            // Restored plan: settled read-only card (collapsed, expandable). A
            // still-pending plan (approved null, e.g. an interrupted turn) shows
            // as "proposed" but treated as not-approved for the state line.
            flushRun();
            const card = body.createDiv({ cls: "mva-plan-card" });
            this.renderPlanSettled(card, s.md, s.approved === true);
          } else if (s.t === "artifact") {
            flushRun();
            this.buildArtifactCard(body, s.path, m.checkpoint);
          } else {
            const fp = toolFilePath(s.name, s.input);
            if (fp) {
              // Note-touching calls dissolve into the touched-notes footer below
              // instead of also rendering their own row — this is a restored (not
              // live) turn, so there's no streaming status to show in the first
              // place. They leave no trace, so the run continues across them. Still
              // credited to the run's stats (toolCount/fileEdits) so a reopened
              // conversation's header matches what it showed live — mirrors how a
              // live note-touching card counts via noteToolAdded before it dissolves.
              mergeTouched(touched, fp, WRITE_TOOLS.test(s.name) ? "write" : "read");
              if (!run) run = new StepsRun(body);
              run.noteToolAdded(s.name, s.input);
            } else if (stepPlacement(s.name, s.input) === "flat") {
              flushRun();
              const refs = this.createToolCard(body, s.name, s.input);
              this.finishToolCard(refs, s.ok !== false, s.output);
            } else {
              if (!run) run = new StepsRun(body);
              const refs = this.createToolCard(run.body, s.name, s.input);
              run.noteToolAdded(s.name, s.input);
              this.finishToolCard(refs, s.ok !== false, s.output);
            }
          }
        }
        flushRun(); // message end closes the last run (renders folded, no animation)
        this.attachTouched(el, touched, m.checkpoint);
        if (full.trim()) {
          this.attachActions(el, full, lastUser || undefined, c);
          if (m.researchReceipt) {
            this.attachResearchDossierAction(el, lastUser, full, m.researchReceipt);
          }
        }
      }
    }
    // Rebuilt DOM (restore / rewind / gallery-open) → refresh the recap too.
    if (c === this.active) this.updateRecap();
  }

  /** Fire-and-forget: ask Haiku for a concise title and swap it into the tab once
   *  it lands. Never blocks the turn and never throws. Skips applying if the
   *  conversation was disposed, re-titled, or the call came back empty. */
  private aiTitle(c: Convo, userText: string, assistantText: string): void {
    const ctrl = new AbortController();
    c.titleAbort?.abort();
    c.titleAbort = ctrl;
    void this.plugin
      .generateTitle(userText, assistantText, ctrl.signal)
      .then((title) => {
        if (ctrl.signal.aborted || !title) return; // aborted/failed → keep placeholder
        if (!this.convos.includes(c)) return; // conversation removed meanwhile
        c.title = title;
        this.renderTabs();
        if (this.galleryEl) {
          // Rebuild the open gallery so its card shows the refreshed title.
          this.hideGallery();
          this.showGallery();
        }
        this.persist();
      })
      .catch(() => {
        /* never surface into the turn */
      })
      .finally(() => {
        if (c.titleAbort === ctrl) c.titleAbort = null;
      });
  }

  /** Lazily build the Self-Writing Memory observer for this view. */
  private observer(): MemoryObserver {
    if (!this.memoryObserver) {
      this.memoryObserver = new MemoryObserver(
        this.app,
        (prompt, signal) => this.plugin.runObserver(prompt, signal),
        // Same shared store write-queue the `remember` tool uses — observer
        // appends and undo serialize against every other store writer (w1-1).
        this.plugin.memoryWriteQueue
      );
    }
    return this.memoryObserver;
  }

  /* ----------------------- the agent is the folder ------------------------ */

  /** Lazily build the identity block reader/writer for this view — one per view,
   *  sharing the plugin's store write-queue so block writes serialize against
   *  every other store writer (w1-1). */
  private agent(): AgentFolder {
    if (!this.agentFolder) {
      this.agentFolder = new AgentFolder(this.app, this.plugin.memoryWriteQueue);
    }
    return this.agentFolder;
  }

  /**
   * Enact a `rethink_memory` tool call for conversation `c` (design §3). The
   * tier is resolved purely by {@link planRethink}:
   *  - `now.md`   → write freely, render the diff + undo row into the turn.
   *  - `human.md` → write, render the diff + undo row WITH the rationale surfaced.
   *  - `persona.md` → record a pending proposal card (diff + Apply/Dismiss); the
   *    write happens only on the Apply click. Nothing is written here.
   * Returns the short status line the tool reports back to the model.
   */
  private async rethinkBridge(c: Convo, req: RethinkRequest): Promise<string> {
    const ctx = c.currentCtx;
    if (!ctx) throw new Error("no active turn");
    const block = req.block as BlockName;
    const plan = planRethink(block);
    const agent = this.agent();
    const current = (await agent.readBlock(block))?.content ?? "";

    if (plan.verb === "propose") {
      // persona.md — propose-only: render an Apply/Dismiss card, write on Apply.
      this.renderBlockProposalCard(ctx.bodyEl, block, current, req.content, req.rationale);
      return `Proposed a change to ${block}.md — waiting for the user to Apply or Dismiss it. Not written yet.`;
    }

    // now.md / human.md — governed direct write with feed diff + undo.
    const write = await agent.writeBlock(block, req.content);
    // Identity edits nudge the git-autocommit debounce like any other vault
    // write (integration audit 2026-07-10): without this, a rethink followed by
    // a crash inside the 15-min cadence window would leave the identity change
    // uncommitted — the safety net's fast path should cover it, not just the
    // periodic fallback.
    this.plugin.noteVaultWrite([write.path]);
    this.renderBlockDiff(ctx.bodyEl, write, req.rationale);
    return plan.requireRationale
      ? `Rewrote ${block}.md (rationale surfaced in the change). Review · undo shown in the feed.`
      : `Rewrote ${block}.md. Review · undo shown in the feed.`;
  }

  /** Render a compact old→new diff for a block, plus a review·undo row. Reuses the
   *  `.mva-diff` line recipe (design.md §diff) and the observer-veto row idiom.
   *  When a `rationale` is present (human.md tier), it's surfaced prominently
   *  above the diff (design §3). */
  private renderBlockDiff(el: HTMLElement, write: BlockWrite, rationale?: string): void {
    const wrap = el.createDiv({ cls: "mva-rethink" });
    wrap.createSpan({ cls: "mva-rethink-chip", text: `${write.block}.md updated` });
    if (rationale) {
      const r = wrap.createDiv({ cls: "mva-rethink-rationale" });
      r.createSpan({ cls: "mva-rethink-rationale-k", text: "Why: " });
      r.createSpan({ text: rationale });
    }
    this.renderTextDiff(wrap, write.previous, write.next);
    this.renderBlockUndoRow(wrap, write);
  }

  /** The discreet "reverted"-capable undo row for a governed block write. */
  private renderBlockUndoRow(wrap: HTMLElement, write: BlockWrite): void {
    const row = wrap.createDiv({ cls: "mva-faint mva-mem-veto" });
    const review = row.createEl("a", { text: "review", href: "#" });
    this.clickable(review, (e) => {
      e.preventDefault();
      void this.app.workspace.openLinkText(write.path, "", "tab");
    });
    row.createSpan({ text: " · " });
    const undo = row.createEl("a", { text: "undo", href: "#" });
    this.clickable(undo, (e) => {
      e.preventDefault();
      void this.agent()
        .undo(write)
        .then(() => {
          row.empty();
          row.createSpan({ text: `${write.block}.md reverted.` });
        })
        .catch(() => {
          row.empty();
          row.createSpan({ text: "Couldn't undo — the block may have changed." });
        });
    });
  }

  /** Render a pending block proposal card (persona tier or observer now-proposal):
   *  a diff with Apply / Dismiss. Apply writes through the governed path and
   *  swaps in a review·undo row; Dismiss leaves the block untouched. */
  private renderBlockProposalCard(
    parent: HTMLElement,
    block: BlockName,
    current: string,
    proposed: string,
    rationale?: string
  ): void {
    const card = parent.createDiv({ cls: "mva-rethink mva-rethink-proposal" });
    card.createSpan({ cls: "mva-rethink-chip", text: `Proposed: ${block}.md` });
    if (rationale) {
      const r = card.createDiv({ cls: "mva-rethink-rationale" });
      r.createSpan({ cls: "mva-rethink-rationale-k", text: "Why: " });
      r.createSpan({ text: rationale });
    }
    this.renderTextDiff(card, current, proposed);

    const actions = card.createDiv({ cls: "mva-rethink-actions" });
    const apply = actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Apply" });
    const dismiss = actions.createEl("button", { cls: "mva-btn", text: "Dismiss" });
    let done = false;
    const finish = (label: string) => {
      done = true;
      card.removeClass("mva-rethink-proposal");
      actions.remove();
      card.createDiv({ cls: "mva-faint", text: label });
    };
    this.clickable(apply, () => {
      if (done) return;
      done = true; // guard double-click while the write is in flight
      void this.agent()
        .writeBlock(block, proposed)
        .then((write) => {
          // Same git-autocommit debounce nudge as the direct-write tier (see
          // rethinkBridge) — an Applied proposal is a vault write too.
          this.plugin.noteVaultWrite([write.path]);
          card.removeClass("mva-rethink-proposal");
          actions.remove();
          this.renderBlockUndoRow(card, write);
        })
        .catch(() => {
          done = false; // let the user retry
          new Notice(`Couldn't apply ${block}.md.`);
        });
    });
    this.clickable(dismiss, () => {
      if (done) return;
      finish(`${block}.md proposal dismissed.`);
    });
  }

  /** Minimal line-level old→new diff into a `.mva-diff` block. Whole-line adds/dels
   *  (no intraline) — the blocks are short, and the recipe's `.mva-add`/`.mva-del`
   *  line classes carry the color. Unchanged lines render muted. */
  private renderTextDiff(parent: HTMLElement, before: string, after: string): void {
    const box = parent.createDiv({ cls: "mva-diff" });
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    const beforeSet = new Set(beforeLines);
    const afterSet = new Set(afterLines);
    for (const line of beforeLines) {
      if (!afterSet.has(line)) box.createDiv({ cls: "mva-diff-line mva-del", text: `- ${line}` });
    }
    for (const line of afterLines) {
      const cls = beforeSet.has(line) ? "mva-diff-line" : "mva-diff-line mva-add";
      box.createDiv({ cls, text: `${beforeSet.has(line) ? "  " : "+ "}${line}` });
    }
  }

  /* --------------------------- proactive recall --------------------------- */

  /** True when proactive recall may run for `c`: the master flag is on and the
   *  same preconditions that register the `recall` tool hold (obsidian tools +
   *  memory read + agentic Claude). Any false → the send path is byte-identical
   *  to before this feature existed. */
  private proactiveRecallEligible(c: Convo): boolean {
    const s = this.plugin.settings;
    if (!s.proactiveRecall || !s.memoryReadEnabled) return false;
    // Claude keeps the same preconditions that register the `recall` tool.
    // Codex (Tranche A parity): the injection is plain text in the outbound
    // turn — no tool pairing required.
    if (c.provider === "claude") return s.obsidianToolsEnabled && s.toolsEnabled;
    return true;
  }

  /** Read + parse the whole Union Store (all monthly files) — the SAME cheap
   *  cached-read path the `recall` tool uses. Never throws; an unreadable file is
   *  skipped, and a missing store yields `[]`. */
  private async readMemoryStore(): Promise<MemoryEntry[]> {
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(`${MEMORY_STORE_DIR}/`));
    const all: MemoryEntry[] = [];
    for (const f of files) {
      try {
        all.push(...parseStoreFile(await this.app.vault.cachedRead(f)));
      } catch {
        /* skip unreadable file */
      }
    }
    return all;
  }

  /** Format the selected entries as the delimited `[recalled-memory]` block that
   *  travels ONLY in the outbound payload (never the rendered/persisted bubble).
   *  One bullet per entry: `- (kind, YYYY-MM-DD) …verbatim text…`. */
  private formatRecallBlock(entries: MemoryEntry[]): string {
    const lines = entries.map((e) => {
      const date = new Date(e.at).toISOString().slice(0, 10);
      const text = e.text.replace(/\s+/g, " ").trim();
      return `- (${e.kind}, ${date}) ${text}`;
    });
    return `${RECALLED_MEMORY_OPEN}\n${lines.join("\n")}\n${RECALLED_MEMORY_CLOSE}`;
  }

  /** Select the memories to inject into THIS outbound turn (or `[]` when
   *  ineligible / nothing relevant). Records the chosen ids into the convo's
   *  per-conversation dedup set so each memory is injected at most once. `message`
   *  is the clean user text (context-notes prefix and all) — never the rendered
   *  bubble, which stays free of the injected block. */
  private async selectTurnRecall(c: Convo, message: string): Promise<MemoryEntry[]> {
    if (!this.proactiveRecallEligible(c)) return [];
    const entries = await this.readMemoryStore();
    if (entries.length === 0) return [];
    if (!c.injectedMemoryIds) c.injectedMemoryIds = new Set<string>();
    const picked = selectRecall(entries, message, c.injectedMemoryIds, {
      ...DEFAULT_RECALL_OPTS,
      k: this.plugin.settings.proactiveRecallK,
    });
    // Diagnostics: recall decisions are exactly where cue-list drift will show
    // up (false skips / spurious injections) — make both outcomes readable.
    if (isBackReference(message)) this.diag.push("recall", "skipped (back-reference)");
    else if (picked.length) this.diag.push("recall", `injected ${picked.length}`);
    for (const e of picked) c.injectedMemoryIds.add(e.id);
    return picked;
  }

  /** Self-Writing Memory: after a HEALTHY turn, fire the observer off the critical
   *  path. Gated to Claude + both toggles; never blocks the turn or the next one.
   *  On a successful write, render a discreet veto row (review · undo) into the turn.
   *  When the agent folder is on, ALSO pass `now.md` as context so the pass can
   *  propose a now.md update (design §5) — rendered as an Apply/Dismiss card. */
  private observeTurn(c: Convo, el: HTMLElement, userText: string, assistantText: string): void {
    const s = this.plugin.settings;
    if (!s.selfWritingMemory || !s.memoryWriteEnabled) return;
    // Provider-agnostic (Tranche A): the observer itself runs on a transient
    // Claude utility pass regardless of which provider produced the turn.
    if (!userText.trim() || !assistantText.trim()) return;
    if (!this.plugin.canRunObserver()) {
      console.info("[Exo] observer skipped: background budget exhausted or disabled.");
      return;
    }
    const observer = this.observer();
    const wantNow = s.agentFolderEnabled;
    const run = async (): Promise<{ write: ObserverWrite | null; nowProposal: NowProposal | null }> => {
      const opts = wantNow ? { nowContext: await this.agent().nowContext() } : {};
      let result = await observer.observeDetailed({ user: userText, assistant: assistantText }, c.sessionId ?? "unknown", opts);
      if (result.busy) {
        await observer.whenIdle();
        if (!this.plugin.canRunObserver()) return { write: null, nowProposal: null };
        result = await observer.observeDetailed({ user: userText, assistant: assistantText }, c.sessionId ?? "unknown", opts);
      }
      return { write: result.write, nowProposal: result.nowProposal };
    };
    void run()
      .then(async ({ write, nowProposal }) => {
        if (!this.convos.includes(c) || !el.isConnected) return; // turn removed/rebuilt
        if (write && write.entries.length > 0) this.renderMemoryVeto(el, write);
        // Observer now.md proposal (§5): propose only — the Apply click writes.
        if (nowProposal) {
          const current = (await this.agent().readBlock("now"))?.content ?? "";
          if (this.convos.includes(c) && el.isConnected) {
            this.renderBlockProposalCard(el, "now", current, nowProposal.text);
          }
        }
      })
      .catch((err) => {
        // Never surface into the turn — but record it, so a broken observer
        // pipeline is visible in Diagnostics instead of failing silently.
        this.diag.push("observer", `now-proposal: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  /** Rough token estimate for a step-pass call — the digest is capped small
   *  (current turn's user text + accumulated assistant text so far), so this
   *  sits well under the dream-LLM stage's estimate. Mirrors the "estimate
   *  before, record actual after" W0 pattern used by `maybeRunDreamLlm`. */
  private static readonly STEP_OBSERVE_TOKEN_ESTIMATE = 1500;

  /** Observer cadence dispatch (W2-3), called once per completed turn — the
   *  exact spot the always-on end-of-turn observer used to fire from.
   *
   *  `observerCadence: "session-end"` (default): byte-for-byte the original
   *  behavior — `observeTurn` on the full turn, cadence state untouched.
   *
   *  `observerCadence: "every-n-steps"`: a step pass may already have flushed
   *  part of this turn's assistant text (tracked in `cadenceTurnFlushLen`,
   *  reset below for the next turn) — only the unsent tail is handed to the
   *  observer, and the conversation's watermark is advanced to cover the
   *  whole turn, so nothing in it is ever sent twice. */
  private observeTurnEnd(c: Convo, ctx: AssistantCtx): void {
    const s = this.plugin.settings;
    if (s.observerCadence !== "every-n-steps") {
      this.observeTurn(c, ctx.el, ctx.userText, ctx.fullText);
      return;
    }
    const flushed = c.cadenceTurnFlushLen ?? 0;
    const assistantTail = ctx.fullText.slice(flushed);
    c.cadenceTurnFlushLen = 0; // next turn starts with a clean slate
    const cadence = c.cadence ?? initialCadenceState();
    c.cadence = advanceWatermark(cadence, cadence.stepCount); // this turn is now fully covered
    if (!assistantTail.trim()) return; // a step pass already captured everything this turn
    this.observeTurn(c, ctx.el, ctx.userText, assistantTail);
  }

  /** Observer cadence (W2-3): count one real tool-call step for `c` and, when
   *  `observerCadence: "every-n-steps"` crosses an interval boundary, flush a
   *  delta capture over whatever this turn has produced so far — WITHOUT
   *  waiting for the turn to end. No-op (state untouched) unless self-writing
   *  memory is fully on and the setting is every-n-steps. */
  private maybeStepObserve(c: Convo, ctx: AssistantCtx): void {
    const s = this.plugin.settings;
    if (s.observerCadence !== "every-n-steps") return;
    if (!s.selfWritingMemory || !s.memoryWriteEnabled) return;
    // Provider-agnostic (Tranche A) — see observeTurn.
    const cadence = c.cadence ?? initialCadenceState();
    const stepped = recordStep(cadence, s.observerStepInterval);
    c.cadence = stepped.state;
    if (!stepped.fired) return;
    const delta = pendingDelta(stepped.state, stepped.state.stepCount);
    if (!delta) return; // defensive — a fresh fire always has something pending
    this.runStepObserve(c, ctx, stepped.state.stepCount);
  }

  /** Actually run one every-n-steps delta pass: budget-checked through the W0
   *  ledger (skip silently, no retry queue, when it denies), same observer
   *  pipeline as the end-of-turn pass. Only the assistant text produced SINCE
   *  the last flush (step pass or turn start) is sent — so back-to-back step
   *  passes within one marathon turn never re-send the same content. Advances
   *  the watermark and the turn's flush marker once the pass is attempted. */
  private runStepObserve(c: Convo, ctx: AssistantCtx, toStepCount: number): void {
    if (!this.plugin.checkBackgroundBudget(ChatView.STEP_OBSERVE_TOKEN_ESTIMATE)) {
      console.info("[Exo] observer step-pass skipped: background budget exhausted or disabled.");
      return; // no unbounded retry — the next boundary (step or end-of-turn) gets another try
    }
    const userText = ctx.userText;
    const flushedSoFar = c.cadenceTurnFlushLen ?? 0;
    const assistantDelta = ctx.fullText.slice(flushedSoFar);
    // Snapshot NOW (before the async call) how much of this turn's assistant
    // text this pass covers — text that streams in WHILE the call is in
    // flight must stay unflushed for the next boundary, not silently skipped.
    const coveredLen = ctx.fullText.length;
    if (!userText.trim() || !assistantDelta.trim()) return; // nothing new yet this turn
    const el = ctx.el;
    void this.observer()
      .observeDetailed({ user: userText, assistant: assistantDelta }, c.sessionId ?? "unknown")
      .then((result) => {
        if (!result.attempted) return;
        // Regardless of whether a memory was actually written, the delta WAS
        // shown to the model — mark it flushed so it's never re-sent.
        c.cadenceTurnFlushLen = Math.max(c.cadenceTurnFlushLen ?? 0, coveredLen);
        c.cadence = advanceWatermark(c.cadence ?? initialCadenceState(), toStepCount);
        const write = result.write;
        if (!write || write.entries.length === 0) return;
        if (!this.convos.includes(c) || !el.isConnected) return; // turn removed/rebuilt
        this.renderMemoryVeto(el, write);
      })
      .catch((err) => {
        // Never surface into the turn — a later boundary retries — but log it so
        // a persistently-failing memory pipeline is visible in Diagnostics.
        this.diag.push("observer", `memory-veto: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  /** Quiet, expandable "N memories recalled" row under a user turn — the
   *  transparency surface for proactive recall, so injection is never invisible.
   *  Collapsed by default: a brain icon + count (register C label). Click toggles
   *  a list of the injected entries (kind · date · verbatim text). No fill at rest;
   *  state comes from the caret + hover only (design laws 2 & 4). */
  private renderRecallAffordance(turnEl: HTMLElement, entries: MemoryEntry[]): void {
    const n = entries.length;
    const wrap = turnEl.createDiv({ cls: "mva-recall" });
    const header = wrap.createDiv({ cls: "mva-recall-header", attr: { role: "button", tabindex: "0" } });
    setIcon(header.createSpan({ cls: "mva-recall-icon" }), "brain");
    header.createSpan({ cls: "mva-recall-label", text: `${n} ${n === 1 ? "memory" : "memories"} recalled` });
    const caret = header.createSpan({ cls: "mva-recall-caret" });
    setIcon(caret, "chevron-right");

    const list = wrap.createDiv({ cls: "mva-recall-list" });
    for (const e of entries) {
      const item = list.createDiv({ cls: "mva-recall-item" });
      const date = new Date(e.at).toISOString().slice(0, 10);
      item.createSpan({ cls: "mva-recall-meta", text: `${e.kind} · ${date}` });
      item.createSpan({ cls: "mva-recall-text", text: e.text.replace(/\s+/g, " ").trim() });
    }

    const toggle = () => {
      const open = wrap.hasClass("is-open");
      wrap.toggleClass("is-open", !open);
      header.setAttr("aria-expanded", String(!open));
    };
    header.setAttr("aria-expanded", "false");
    this.clickable(header, toggle);
    header.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        toggle();
      }
    });
  }

  /** Discreet, non-blocking "N memories written — review · undo" indicator. */
  private renderMemoryVeto(el: HTMLElement, write: ObserverWrite): void {
    const n = write.entries.length;
    const row = el.createDiv({ cls: "mva-faint mva-mem-veto" });
    row.createSpan({ text: `${n} ${n === 1 ? "memory" : "memories"} written — ` });
    const review = row.createEl("a", { text: "review", href: "#" });
    this.clickable(review, (e) => {
      e.preventDefault();
      // Reveal the store file the entries were appended to.
      void this.app.workspace.openLinkText(write.snapshot.path, "", "tab");
    });
    row.createSpan({ text: " · " });
    const undo = row.createEl("a", { text: "undo", href: "#" });
    this.clickable(undo, (e) => {
      e.preventDefault();
      void this.observer()
        // Undo strips exactly this pass's entry ids from the CURRENT file —
        // any @user entry written in between is preserved (never a blind restore).
        .undo(write)
        .then(() => {
          row.empty();
          row.createSpan({ text: `${n === 1 ? "Memory" : "Memories"} reverted.` });
        })
        .catch(() => {
          row.empty();
          row.createSpan({ text: "Couldn't undo — the store file may have changed." });
        });
    });
  }

  private addUserTurn(c: Convo, text: string, images?: ImageAttachment[]): HTMLElement {
    this.clearEmptyState(c);
    // Derive the tab title from the first user message. The untitled state is
    // represented inconsistently across the view — every render site falls back
    // with `c.title || "New chat"`, so a falsy title still *shows* as "New chat"
    // while failing an exact `=== "New chat"` check. Treat any falsy title OR the
    // literal default as untitled so the first message always names the tab.
    if (!c.title || c.title === "New chat") {
      const derived = text.replace(/\s+/g, " ").trim().slice(0, 40);
      c.title = derived || (images?.length ? "Image" : "New chat");
      this.renderTabs(); // reflect the new title in the tab
    }
    const at = Date.now();
    c.messages.push({ role: "user", text, at });
    const el = c.listEl.createDiv({ cls: "mva-turn mva-user" });
    const bubble = el.createDiv({ cls: "mva-bubble" });
    if (images?.length) {
      const strip = bubble.createDiv({ cls: "mva-bubble-images" });
      for (const img of images) {
        strip.createEl("img", {
          cls: "mva-bubble-img",
          attr: { src: `data:${img.mediaType};base64,${img.dataB64}` },
        });
      }
    }
    if (text) void MarkdownRenderer.render(this.app, text, bubble.createDiv({ cls: "markdown-rendered" }), "", this);
    this.appendMsgTime(el, at);
    this.scrollConvo(c);
    if (c === this.active) this.rebuildOutline();
    return el;
  }

  /** Small muted HH:MM under a user bubble. No-op when `at` is absent (pre-0.14 messages). */
  private appendMsgTime(turnEl: HTMLElement, at?: number): void {
    if (!at) return;
    const d = new Date(at);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    turnEl.createDiv({ cls: "mva-msg-time", text: `${hh}:${mm}` });
  }

  private addAssistantTurn(c: Convo, userText: string): AssistantCtx {
    this.clearEmptyState(c);
    const el = c.listEl.createDiv({ cls: "mva-turn mva-assistant" });
    const bodyEl = el.createDiv({ cls: "mva-assistant-body" });
    const thinking = bodyEl.createDiv({ cls: "mva-thinking" });
    thinking.createSpan({ cls: "mva-thinking-dot" });
    thinking.createSpan({ cls: "mva-thinking-dot" });
    thinking.createSpan({ cls: "mva-thinking-dot" });
    const latestUser = [...c.messages].reverse().find((message) => message.role === "user");
    const turnId = `${c.id}:${latestUser?.at ?? Date.now()}`;
    const ctx: AssistantCtx = {
      el,
      bodyEl,
      cards: new Map(),
      segById: new Map(),
      segments: [],
      turnId,
      curTextEl: null,
      stableLen: 0,
      tailEl: null,
      caretEl: null,
      finalized: false,
      scanPos: 0,
      fenceOpen: false,
      lastBoundary: 0,
      curTextSeg: null,
      curRaw: "",
      fullText: "",
      userText,
      thinkingEl: thinking,
      stepsRun: null,
      sources: new Set(),
      touched: [],
      writeById: new Map(),
      noteTouchIds: new Set(),
      runById: new Map(),
      revealed: new Set(),
      artifacts: new Set(),
      createdPaths: new Set(),
      convo: c,
      renderTimer: null,
      todosEl: null,
      bgTasks: new Map(),
      runningTasks: new Set(),
      taskCards: new Map(),
      nestedRows: new Map(),
      workingEl: null,
      workingLabel: null,
      workingElapsed: null,
      openCards: 0,
      textStreaming: false,
      notified: new Set(),
    };
    this.scrollConvo(c);
    return ctx;
  }

  private appendReasoning(ctx: AssistantCtx, text: string): void {
    this.dropThinking(ctx);
    this.ensureStepsRun(ctx).appendThinking(text);
  }

  private dropThinking(ctx: AssistantCtx): void {
    ctx.thinkingEl?.remove();
    ctx.thinkingEl = null;
  }

  /** Open (or reuse) the current steps-timeline run for this turn. */
  private ensureStepsRun(ctx: AssistantCtx): StepsRun {
    if (!ctx.stepsRun || ctx.stepsRun.closed) ctx.stepsRun = new StepsRun(ctx.bodyEl);
    return ctx.stepsRun;
  }

  /** Close the current run (fold to "N steps ⌄"). Safe to over-call.
   *  `interrupted` threads through to the header's status glyph (x vs check) —
   *  pass true only where the turn's stopped/errored state is already known. */
  private closeStepsRun(ctx: AssistantCtx, interrupted = false): void {
    ctx.stepsRun?.close(ctx.convo.listEl, interrupted);
    ctx.stepsRun = null;
  }

  /* ------------------------- working indicator ---------------------- */

  /** Create (once) the Claude-Code-style "working" row and move it to be the LAST
   *  child of bodyEl so it always trails the transcript, then show it. */
  private ensureWorking(ctx: AssistantCtx): void {
    let el = ctx.workingEl;
    if (!el) {
      el = createDiv({ cls: "mva-working" });
      setIcon(el.createSpan({ cls: "mva-working-star" }), EXO_ICON);
      ctx.workingLabel = el.createSpan({ cls: "mva-working-label", text: "Thinking…" });
      ctx.workingElapsed = el.createSpan({ cls: "mva-working-elapsed" });
      el.createSpan({ cls: "mva-working-hint", text: "esc to stop" });
      ctx.workingEl = el;
    }
    // Hot path (every thinking delta, every tool event, the 1s tick via
    // syncWorking): skip the DOM ops when the row is already the visible last
    // child — an unconditional appendChild is a remove+insert that invalidates
    // layout on every call even when nothing moved.
    if (ctx.bodyEl.lastElementChild !== el) ctx.bodyEl.appendChild(el); // re-append: always the last element
    if (el.style.display === "none") el.show();
  }

  /** Hide the working row (streaming text / an open interactive card takes over). */
  private hideWorking(ctx: AssistantCtx): void {
    const el = ctx.workingEl;
    if (el && el.style.display !== "none") el.hide(); // no-op when already hidden (called per text delta)
  }

  /** Set the working row's phase label (no-op if the row was never created). */
  private setWorkingLabel(ctx: AssistantCtx, text: string): void {
    ctx.workingLabel?.setText(text);
  }

  /** Remove the working row entirely (turn end / error). */
  private removeWorking(ctx: AssistantCtx): void {
    ctx.workingEl?.remove();
    ctx.workingEl = null;
    ctx.workingLabel = null;
    ctx.workingElapsed = null;
  }

  /** Single source of truth for the in-turn feedback affordance. Keeps exactly
   *  one of {working row, open card, streaming caret} on screen while streaming,
   *  so a turn can never look dead ("incantato"). This replaces the removed
   *  TurnWatchdog: like Codex/Claude Code, no client timer kills the turn — the
   *  always-visible, interruptible working row + Esc is the whole safety net.
   *  See core/working-visibility.ts. */
  private syncWorking(ctx: AssistantCtx): void {
    const a = workingAffordance({
      streaming: ctx.convo.streaming,
      openCards: ctx.openCards,
      textStreaming: ctx.textStreaming,
    });
    if (a === "working") this.ensureWorking(ctx);
    else this.hideWorking(ctx);
  }

  /** An interactive card (permission / ask_user / plan) opened — it becomes the
   *  feedback, so the working row hides. */
  private openCard(ctx: AssistantCtx): void {
    ctx.openCards++;
    this.diag.push("card", `open n=${ctx.openCards}`);
    this.syncWorking(ctx);
  }

  /** An interactive card resolved, was cancelled, or failed to render — release
   *  its slot and bring the working row back if nothing else is on screen. Safe
   *  to over-call (floored at 0), which is what closes the freeze class: even a
   *  card that never rendered can't leave the turn without an affordance. */
  private closeCard(ctx: AssistantCtx): void {
    if (ctx.openCards > 0) ctx.openCards--;
    this.diag.push("card", `close n=${ctx.openCards}`);
    this.syncWorking(ctx);
  }

  /** Human elapsed: `37s` under a minute, `1m 12s` past it. */
  private fmtDuration(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  /* ------------------------ system notifications -------------------- */

  /** OS notification while Obsidian is backgrounded (Feature 3). No-op if the
   *  setting is off or the window is focused. Lazily requests permission once. */
  private notify(title: string, body: string): void {
    if (!this.plugin.settings.systemNotifications) return;
    if (document.hasFocus()) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "denied") return;
    if (Notification.permission === "default") {
      if (!this.notifyPermAsked) {
        this.notifyPermAsked = true;
        void Notification.requestPermission();
      }
      return; // permission resolves async — the next trigger fires
    }
    try {
      const n = new Notification(title, { body, silent: false });
      n.onclick = () => {
        window.focus();
        this.app.workspace.revealLeaf(this.leaf);
      };
    } catch {
      /* ignore — notifications unavailable */
    }
  }

  /** Fire a notification at most once per turn per type (`done`/`waiting`/`error`). */
  private notifyOnce(ctx: AssistantCtx, type: string, title: string, body: string): void {
    if (ctx.notified.has(type)) return;
    ctx.notified.add(type);
    this.notify(title, body);
  }

  private appendText(ctx: AssistantCtx, text: string): void {
    this.dropThinking(ctx);
    if (!ctx.curTextEl) {
      this.closeStepsRun(ctx);
      ctx.curTextEl = ctx.bodyEl.createDiv({ cls: "mva-bubble markdown-rendered" });
      ctx.curRaw = "";
      ctx.stableLen = 0;
      ctx.tailEl = null;
      ctx.scanPos = 0;
      ctx.fenceOpen = false;
      ctx.lastBoundary = 0;
      ctx.curTextSeg = { t: "text", md: "" };
      ctx.segments.push(ctx.curTextSeg);
    }
    ctx.curRaw += text;
    ctx.curTextSeg!.md += text;
    ctx.fullText += text;
    this.scheduleRender(ctx);
  }

  /** Render/refresh the agent's TodoWrite list as a live checklist panel, nested
   *  inside the current steps run (does NOT break the timeline — a turn that
   *  interleaves tool calls and todo updates still folds as one block). The
   *  panel itself is still a single live element, refreshed in place on every
   *  TodoWrite call, not one row per call. */
  private renderTodos(ctx: AssistantCtx, input: unknown): void {
    const todos = (input as { todos?: Array<{ content?: string; status?: string }> })?.todos;
    if (!Array.isArray(todos)) return;
    this.dropThinking(ctx);
    this.resetTextStream(ctx);
    const run = this.ensureStepsRun(ctx);
    if (!ctx.todosEl) {
      ctx.todosEl = run.body.createDiv({ cls: "mva-todos" });
      run.noteToolAdded("TodoWrite", input);
    } else if (ctx.todosEl.parentElement !== run.body) {
      // The run that used to host this panel already folded (e.g. prose
      // resumed in between todo updates) — move the live panel into the
      // current run rather than leaving it stranded inside a collapsed one.
      run.body.appendChild(ctx.todosEl);
      run.noteToolAdded("TodoWrite", input);
    }
    const el = ctx.todosEl;
    el.empty();
    const done = todos.filter((t) => t.status === "completed").length;
    const head = el.createDiv({ cls: "mva-todos-head" });
    setIcon(head.createSpan({ cls: "mva-todos-icon" }), "list-checks");
    head.createSpan({ text: `Tasks ${done}/${todos.length}` });
    for (const t of todos) {
      const row = el.createDiv({ cls: `mva-todo is-${t.status ?? "pending"}` });
      const box = row.createSpan({ cls: "mva-todo-box" });
      setIcon(
        box,
        t.status === "completed" ? "check" : t.status === "in_progress" ? "loader-2" : "circle"
      );
      row.createSpan({ cls: "mva-todo-text", text: t.content ?? "" });
    }
    this.scrollConvo(ctx.convo);
  }

  private renderText(ctx: AssistantCtx, streaming = false): void {
    if (!ctx.curTextEl) return;
    const el = ctx.curTextEl;
    const raw = ctx.curRaw || "";

    if (!streaming) {
      // Final render: one full, clean re-render of the whole reply (with
      // wikilinkify), matching the pre-incremental semantics exactly.
      ctx.tailEl = null;
      ctx.stableLen = 0;
      ctx.scanPos = 0;
      ctx.fenceOpen = false;
      ctx.lastBoundary = 0;
      el.empty();
      let md = raw;
      if (this.plugin.settings.featureWikilinkify) {
        md = wikilinkify(md, [...ctx.sources, ...ctx.touched.map((t) => t.path)]);
      }
      void MarkdownRenderer.render(this.app, md, el, "", this).then(() => {
        this.clearCaret(ctx);
      });
      return;
    }

    // Streaming tick: promote any newly-completed blocks to a stable, render-once
    // child, then re-render only the live tail (O(tail) per tick).
    const b = advanceBoundary(ctx);
    if (b > ctx.stableLen) {
      const block = ctx.curTextEl.createDiv({ cls: "mva-md-block markdown-rendered" });
      // Insert the stable block before the tail so ordering stays correct.
      if (ctx.tailEl) ctx.curTextEl.insertBefore(block, ctx.tailEl);
      void MarkdownRenderer.render(this.app, raw.slice(ctx.stableLen, b), block, "", this);
      ctx.stableLen = b;
    }
    if (!ctx.tailEl) ctx.tailEl = ctx.curTextEl.createDiv({ cls: "mva-md-tail markdown-rendered" });
    const tail = ctx.tailEl;
    tail.empty();
    void MarkdownRenderer.render(this.app, raw.slice(ctx.stableLen), tail, "", this).then(() => {
      // Keep at most one caret — on the tail that's currently streaming. Skip if
      // the segment was interrupted while this render was in flight (tailEl was
      // reset), so an in-flight tick can't resurrect an orphaned caret.
      if (ctx.tailEl !== tail || !tail.isConnected) return;
      // Turn already finalized (flushRender ran + swept): a late-resolving render
      // tick must never resurrect a caret after cleanup — the invariant that closes
      // the orphaned-caret race regardless of which timing triggered it.
      if (ctx.finalized) {
        this.diag.push("caret", "late-place blocked (finalized)");
        return;
      }
      this.clearCaret(ctx);
      // Inline placement: inside the last text-bearing block, after its last
      // character. A tail with no host (empty, trailing hr/image, blank
      // paragraph) gets no caret this tick — never a lone caret on its own line.
      const host = caretHost(tail as unknown as CaretNode) as HTMLElement | null;
      if (host) {
        ctx.caretEl = host.createSpan({ cls: "mva-caret" });
      } else if (streaming && ctx.textStreaming) {
        // No caret could be placed, so the "caret" affordance would be a lie —
        // hand liveness back to the working row until the next delta renders a
        // caret again. State-derived, no timers (see core/working-visibility.ts).
        ctx.textStreaming = false;
        this.syncWorking(ctx);
      }
    });
  }

  /** Remove the turn's tracked streaming caret (O(1) — no DOM query). */
  private clearCaret(ctx: AssistantCtx): void {
    ctx.caretEl?.remove();
    ctx.caretEl = null;
  }

  /** End the current text segment: null the stream targets, reset the incremental
   *  renderer state, and clear the caret left on the abandoned tail. Call at every
   *  site that interrupts a text segment (todos, tool card, permission, ask, error). */
  private resetTextStream(ctx: AssistantCtx): void {
    ctx.curTextEl = null;
    ctx.stableLen = 0;
    ctx.tailEl = null;
    ctx.scanPos = 0;
    ctx.fenceOpen = false;
    ctx.lastBoundary = 0;
    ctx.curTextSeg = null;
    this.clearCaret(ctx);
  }

  private scheduleRender(ctx: AssistantCtx): void {
    if (ctx.renderTimer !== null) return;
    // Per-tick work is now O(tail) (stable blocks render once), so length matters
    // far less — keep only a mild ladder for very chatty streams. The turn-end
    // flushRender always does the final full clean re-render.
    const len = ctx.curRaw.length;
    const delay = len > 8000 ? 150 : len > 3000 ? 100 : 60;
    ctx.renderTimer = window.setTimeout(() => {
      ctx.renderTimer = null;
      this.renderText(ctx, true);
      this.scrollConvo(ctx.convo);
    }, delay);
  }

  private flushRender(ctx: AssistantCtx, interrupted = false): void {
    // Mark the turn terminal FIRST: any render tick still in flight resolves on a
    // microtask after this, and the finalized guard at the caret add-site blocks it
    // from placing a caret past cleanup. Set before anything async below.
    ctx.finalized = true;
    if (ctx.renderTimer !== null) {
      window.clearTimeout(ctx.renderTimer);
      ctx.renderTimer = null;
    }
    this.renderText(ctx, false);
    this.clearCaret(ctx);
    this.closeStepsRun(ctx, interrupted);
    // Final-cleanup fallback: the tracked ref covers every live path, but the
    // turn is over — sweep the transcript so no caret can survive a desync.
    ctx.convo.listEl.querySelectorAll(".mva-caret").forEach((el) => el.remove());
  }

  private attachActions(turnEl: HTMLElement, text: string, retryText?: string, convo?: Convo): void {
    const bar = turnEl.createDiv({ cls: "mva-actions" });

    const copy = bar.createEl("button", { cls: "mva-act", attr: { "aria-label": "Copy" } });
    setIcon(copy, "copy");
    copy.onclick = () => {
      void navigator.clipboard.writeText(text);
      this.flashIcon(copy, "check", "copy");
    };

    const insert = bar.createEl("button", { cls: "mva-act", attr: { "aria-label": "Insert into note" } });
    setIcon(insert, "file-down");
    insert.onclick = () => void this.insertIntoNote(text, insert);

    if (retryText) {
      const retry = bar.createEl("button", { cls: "mva-act", attr: { "aria-label": "Retry" } });
      setIcon(retry, "refresh-cw");
      const target = convo ?? this.active;
      retry.onclick = () => {
        if (target.streaming) return;
        void this.runTurn(target, retryText);
      };
    }

    const fork = bar.createEl("button", { cls: "mva-act", attr: { "aria-label": "Fork into new tab" } });
    setIcon(fork, "git-compare-arrows");
    fork.onclick = () => this.forkConversation(convo ?? this.active);

    const rewind = bar.createEl("button", { cls: "mva-act", attr: { "aria-label": "Rewind here (conversation only)" } });
    setIcon(rewind, "undo-2");
    rewind.onclick = () => this.rewindTo(convo ?? this.active, turnEl);

    const rewindCode = bar.createEl("button", {
      cls: "mva-act",
      attr: { "aria-label": "Rewind code + conversation (restore files to this point)" },
    });
    setIcon(rewindCode, "history");
    rewindCode.onclick = () => void this.rewindCodeTo(convo ?? this.active, turnEl);
  }

  private attachResearchDossierAction(
    turnEl: HTMLElement,
    question: string,
    response: string,
    receipt: ResearchReceipt
  ): void {
    if (turnEl.querySelector(".mva-research-save")) return;
    const button = turnEl.createEl("button", {
      cls: "mva-research-save",
      attr: { "aria-label": "Save research dossier" },
    });
    const icon = button.createSpan({ cls: "mva-research-save-icon" });
    const label = button.createSpan({ text: "Save research dossier" });
    setIcon(icon, "file-down");
    let savedPath: string | null = null;

    button.onclick = () => {
      if (savedPath) {
        this.openNote(savedPath);
        return;
      }
      if (button.disabled) return;
      button.disabled = true;
      button.removeClass("is-warning");
      label.setText("Saving dossier…");
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const vault = this.app.vault;
      void writeResearchDossier({
        exists: (path) => vault.adapter.exists(path),
        read: async (path) => await vault.adapter.exists(path) ? vault.adapter.read(path) : null,
        ensureDir: async (path) => {
          if (vault.getAbstractFileByPath(path)) return;
          try {
            await vault.createFolder(path);
          } catch (error) {
            if (!vault.getAbstractFileByPath(path)) throw error;
          }
        },
        write: async (path, content) => {
          await vault.create(path, content);
        },
      }, this.plugin.researchDossierWriteQueue, {
        approved: true,
        date,
        question,
        response,
        receipt,
      }).then((result) => {
        if (result.status !== "saved") return;
        savedPath = result.path;
        button.disabled = false;
        setIcon(icon, "check");
        label.setText(result.created ? "Open saved dossier" : "Dossier already saved");
        setTooltip(button, result.path);
        if (result.created) this.plugin.noteVaultWrite([result.path]);
        new Notice(result.created ? "Research dossier saved." : "Research dossier already exists.");
      }).catch(() => {
        button.disabled = false;
        button.addClass("is-warning");
        setIcon(icon, "triangle-alert");
        label.setText("Retry save");
        new Notice("Exo couldn't save the research dossier.");
      });
    };
  }

  /** Conversation-only rewind: drop turns after this one and reset the session.
   *  Files on disk are NOT touched (a safe, non-destructive rewind). */
  private rewindTo(c: Convo, turnEl: HTMLElement): void {
    if (c.streaming) {
      new Notice("Stop the current turn before rewinding.");
      return;
    }
    const turns = Array.from(c.listEl.querySelectorAll(".mva-turn"));
    const idx = turns.indexOf(turnEl);
    if (idx < 0) return;
    c.messages = c.messages.slice(0, idx + 1);
    for (let i = turns.length - 1; i > idx; i--) turns[i].remove();
    this.dropSession(c); // next message starts a fresh session from this point
    c.sessionId = undefined;
    c.queue = [];
    this.renderQueue(c);
    c.updatedAt = Date.now();
    c.usage = undefined;
    this.composer.updateUsage(null);
    if (c === this.active) {
      this.rebuildOutline();
      this.updateRecap();
    }
    this.persist();
    new Notice("Rewound the conversation. Files are unchanged; the session was reset.");
  }

  /** Normalize a possibly-absolute tool path (built-in Write/Edit use absolute paths)
   *  to a vault-relative path the vault API understands. */
  private relPath(p: string): string {
    const base = this.vaultPath();
    if (base && base !== "." && p.startsWith(base + "/")) return p.slice(base.length + 1);
    return p;
  }

  /** Resolve a tool's user-facing target/link to the concrete vault path used
   *  by snapshots and git. Native tools accept `[[Note]]` or a basename, while
   *  checkpointing must address `Folder/Note.md`; destinations that do not yet
   *  exist (create/rename) deliberately fall back to the supplied path. */
  private concreteToolPath(rawPath: string): string {
    const rel = this.relPath(rawPath);
    const direct = this.app.vault.getAbstractFileByPath(rel);
    if (direct instanceof TFile) return direct.path;
    const linkpath = rel.endsWith(".md") ? rel.slice(0, -3) : rel;
    return this.app.metadataCache.getFirstLinkpathDest(linkpath, "")?.path ?? rel;
  }

  /** Snapshot a file's current content before a write (null = it doesn't exist yet). */
  private async snapshot(cp: Checkpoint, rawPath: string): Promise<void> {
    const path = this.relPath(rawPath);
    if (cp.has(path)) return;
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      cp.set(path, await this.app.vault.read(f));
    } else if (!f) {
      cp.set(path, null);
    } else {
      throw new Error(`Cannot snapshot non-file path: ${path}`);
    }
  }

  /** Code + conversation rewind: restore files touched after this turn to their
   *  pre-turn state, then drop the later turns. Checkpoints are persisted with
   *  the conversation (size-capped per file), so rewind survives reloads; only
   *  oversized snapshots are dropped at persist time. */
  private async rewindCodeTo(c: Convo, turnEl: HTMLElement): Promise<void> {
    if (c.streaming) {
      new Notice("Stop the current turn before rewinding.");
      return;
    }
    const turns = Array.from(c.listEl.querySelectorAll(".mva-turn"));
    const idx = turns.indexOf(turnEl);
    if (idx < 0) return;

    // Undo THIS turn's edits and everything after — restore files to before this
    // turn ran. Iterate oldest→newest, first write per path wins (it holds the
    // state as of the rewind point).
    const undone = c.messages.slice(idx);
    const restored = new Set<string>();
    let changed = 0;
    let failed = 0;
    let missingCheckpoints = false;
    for (const m of undone) {
      if (m.role !== "assistant") continue;
      if (!m.checkpoint) {
        if (m.segments.some((seg) => seg.t === "tool")) missingCheckpoints = true;
        continue;
      }
      for (const [path, before] of m.checkpoint) {
        if (restored.has(path)) continue;
        restored.add(path);
        try {
          const f = this.app.vault.getAbstractFileByPath(path);
          if (before === null) {
            if (f instanceof TFile) {
              await this.app.vault.delete(f);
              changed++;
            }
          } else if (f instanceof TFile) {
            await this.app.vault.modify(f, before);
            changed++;
          } else {
            // recreate a file that was deleted after the rewind point
            await this.app.vault.create(path, before);
            changed++;
          }
        } catch (err) {
          // Don't abort the whole rewind on one locked/denied file — but count it
          // and log it, so the final Notice tells the truth instead of claiming
          // every file was restored.
          failed++;
          this.diag.push("rewind", `restore failed for ${path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Then the conversation rewind — drop this turn and everything after.
    c.messages = c.messages.slice(0, idx);
    for (let i = turns.length - 1; i >= idx; i--) turns[i].remove();
    this.dropSession(c);
    c.sessionId = undefined;
    c.queue = [];
    this.renderQueue(c);
    c.updatedAt = Date.now();
    c.usage = undefined;
    this.composer.updateUsage(null);
    if (c === this.active) this.rebuildOutline();
    this.persist();
    const note = `Rewound. Restored ${changed} file${changed === 1 ? "" : "s"}; session reset.`;
    const failNote = failed > 0 ? ` (${failed} file${failed === 1 ? "" : "s"} could not be restored — see Diagnostics.)` : "";
    const snapNote = missingCheckpoints ? " (some edits had no snapshot — e.g. oversized files are not checkpointed.)" : "";
    new Notice(`${note}${failNote}${snapNote}`);
  }

  /**
   * Footer listing the notes a turn touched, split into what it *changed*
   * (emphasized, with ×N edit count + diff/revert actions) and what it *read*
   * (context). `checkpoint` (live or restored from persistence) enables per-note diff/revert.
   */
  private attachTouched(
    turnEl: HTMLElement,
    touched: TouchedNote[],
    checkpoint?: Checkpoint,
    collapsed = true
  ): void {
    if (touched.length === 0) return;
    const bar = turnEl.createDiv({ cls: "mva-sources" + (collapsed ? " is-collapsed" : "") });
    // Collapsed by default for EVERY turn (03-07 feedback: the chip rows pile up
    // and crowd the transcript; the agent also duplicates them in prose — see the
    // house rule in providers/claude.ts). One quiet "N files" toggle row; the
    // chips live in the DOM and CSS reveals them when the accordion opens.
    const head = bar.createDiv({ cls: "mva-sources-head" });
    setIcon(head.createSpan({ cls: "mva-reason-chevron" }), "chevron-right");
    head.createSpan({ text: `${touched.length} file${touched.length === 1 ? "" : "s"}` });
    this.clickable(head, () => bar.classList.toggle("is-collapsed"));
    // No "EDITED"/"READ" text headers — the accent border + accent icon color on
    // write chips already distinguish them from muted read chips three ways over
    // (icon shape, border, color); a third, textual signal was pure redundancy
    // (2026-07-03 impeccable critique, P2).
    const group = (kind: "read" | "write", icon: string) => {
      const items = touched.filter((t) => t.kind === kind);
      if (!items.length) return;
      const g = bar.createDiv({ cls: "mva-src-group" });
      const makeChip = (t: TouchedNote) => {
        const chip = g.createSpan({ cls: `mva-src-chip is-${kind}` });
        setIcon(chip.createSpan({ cls: "mva-src-ico" }), icon);
        chip.createSpan({ cls: "mva-src-name", text: noteBasename(t.path) });
        if (kind === "write" && (t.count ?? 0) > 1) {
          chip.createSpan({ cls: "mva-src-count", text: `×${t.count}` });
        }
        this.clickable(chip, () => this.openNote(t.path));
        this.addHoverPreview(chip, t.path);
        // Inline diff + revert — only when we hold this turn's pre-write snapshot.
        const rel = this.relPath(t.path);
        if (kind === "write" && checkpoint?.has(rel)) {
          this.addTouchedActions(chip, t.path, checkpoint.get(rel) ?? null);
        }
        if (kind === "read") {
          this.addReadActions(chip, t.path);
        }
        return chip;
      };
      // Crowded groups collapse to the first 3 chips + a "+N" expander (03-07
      // feedback: the full row of 5+ chips reads as noise under every turn).
      const MAX_VISIBLE = 4;
      const visible = items.length > MAX_VISIBLE ? items.slice(0, 3) : items;
      for (const t of visible) makeChip(t);
      const rest = items.slice(visible.length);
      if (rest.length) {
        const more = g.createSpan({ cls: "mva-src-chip mva-src-more", text: `+${rest.length}` });
        more.setAttribute("aria-label", `Show ${rest.length} more note${rest.length === 1 ? "" : "s"}`);
        this.clickable(more, () => {
          more.remove();
          for (const t of rest) makeChip(t);
        });
      }
    };
    group("write", "file-pen"); // changes first — the actionable output
    group("read", "file-text");
  }

  /** Hover actions on an edited-note chip: view diff, and a two-step revert. */
  private addTouchedActions(chip: HTMLElement, path: string, before: string | null): void {
    const acts = chip.createSpan({ cls: "mva-src-acts" });
    const diff = acts.createSpan({ cls: "mva-src-act", attr: { "aria-label": "View diff" } });
    setIcon(diff, "file-diff");
    this.clickable(diff, (e) => {
      e.stopPropagation();
      void this.showNoteDiff(path, before);
    });

    const revert = acts.createSpan({ cls: "mva-src-act", attr: { "aria-label": "Revert this note" } });
    setIcon(revert, "undo-2");
    let armed = false;
    let disarm: number | null = null;
    this.clickable(revert, (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        revert.addClass("is-armed");
        revert.setAttr("aria-label", "Click again to revert");
        disarm = window.setTimeout(() => {
          armed = false;
          revert.removeClass("is-armed");
          revert.setAttr("aria-label", "Revert this note");
        }, 3000);
        return;
      }
      if (disarm) window.clearTimeout(disarm);
      void this.revertNote(path, before, chip);
    });
  }

  /** Hover action on a read-note chip: attach it to the composer context. */
  private addReadActions(chip: HTMLElement, path: string): void {
    const acts = chip.createSpan({ cls: "mva-src-acts" });
    const attach = acts.createSpan({ cls: "mva-src-act", attr: { "aria-label": "Attach to context" } });
    setIcon(attach, "plus");
    this.clickable(attach, (e) => {
      e.stopPropagation();
      const rel = this.relPath(path);
      this.composer.addManualAttached(rel);
      this.composer.refreshContext();
      new Notice(`Attached ${noteBasename(path)} to context.`);
    });
  }

  /** Open a read-only diff of the note (pre-turn snapshot vs current content). */
  private async showNoteDiff(path: string, before: string | null): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(this.relPath(path));
    let after = "";
    if (f instanceof TFile) {
      try {
        after = await this.app.vault.read(f);
      } catch {
        /* unreadable — show as empty */
      }
    }
    new NoteDiffModal(this.app, noteBasename(path), before, after, () => this.openNote(path)).open();
  }

  /** Restore a single note to its pre-turn snapshot (null = delete it). */
  private async revertNote(path: string, before: string | null, chip: HTMLElement): Promise<void> {
    const rel = this.relPath(path);
    const f = this.app.vault.getAbstractFileByPath(rel);
    try {
      if (before === null) {
        if (f instanceof TFile) await this.app.vault.delete(f);
      } else if (f instanceof TFile) {
        await this.app.vault.modify(f, before);
      } else {
        await this.app.vault.create(rel, before);
      }
      chip.addClass("is-reverted");
      new Notice(`Reverted ${noteBasename(path)} to before this turn.`);
    } catch {
      new Notice(`Couldn't revert ${noteBasename(path)}.`);
    }
  }

  private flashIcon(btn: HTMLElement, on: string, off: string): void {
    btn.empty();
    setIcon(btn, on);
    window.setTimeout(() => {
      btn.empty();
      setIcon(btn, off);
    }, 1200);
  }

  private async insertIntoNote(text: string, btn: HTMLElement): Promise<void> {
    const f = this.app.workspace.getActiveFile();
    if (!f) {
      new Notice("Open a note first to insert into it.");
      return;
    }
    await this.app.vault.append(f, `\n\n${text}\n`);
    new Notice(`Inserted into ${f.basename}`);
    this.flashIcon(btn, "check", "file-down");
  }

  private openNote(path: string): void {
    let p = path;
    const base = this.vaultPath();
    if (base && p.startsWith(base)) p = p.slice(base.length).replace(/^\/+/, "");
    void this.app.workspace.openLinkText(p, "", false);
  }

  /** Obsidian-native page preview on hover (same popover as wikilinks). Fires the
   *  `hover-link` event the Page Preview core plugin listens for; degrades to a
   *  no-op when that plugin is disabled. Markdown files only. */
  private addHoverPreview(el: HTMLElement, path: string): void {
    const rel = this.relPath(path);
    if (!/\.md$/i.test(rel)) return;
    el.addEventListener("mouseover", (event) => {
      this.app.workspace.trigger("hover-link", {
        event,
        source: "exo",
        hoverParent: this,
        targetEl: el,
        linktext: rel,
        sourcePath: rel,
      });
    });
  }

  /** Open a note the agent just edited in the main area — reuse its tab if it's
   *  already open, else a new tab (non-destructive; never the sidebar). Verified:
   *  openLinkText targets the main area even when Exo is the focused sidebar leaf. */
  private revealNote(path: string): void {
    const rel = this.relPath(path);
    const file = this.app.vault.getAbstractFileByPath(rel);
    if (!(file instanceof TFile)) return;
    const open = this.app.workspace
      .getLeavesOfType("markdown")
      .find((l) => (l.view as unknown as { file?: TFile }).file?.path === file.path);
    if (open) {
      this.app.workspace.revealLeaf(open);
      return;
    }
    void this.app.workspace.openLinkText(rel, "", "tab");
  }

  /** Persist + render a live preview card for a generated file (vault-relative path). */
  private renderArtifactCard(ctx: AssistantCtx, path: string): void {
    this.closeStepsRun(ctx);
    ctx.segments.push({ t: "artifact", path });
    this.buildArtifactCard(ctx.bodyEl, path);
  }

  /** Render a preview card for a generated file. HTML → sandboxed iframe preview;
   *  markdown → a capped, faded MarkdownRenderer preview. Resolves the resource /
   *  file fresh so restored transcripts reflect the current on-disk state.
   *  `checkpoint` (restore path only) enables "Restore" on a deleted note when we
   *  hold pre-write content for it — for a note *created* this turn the snapshot
   *  is null (it didn't exist), so no restore is offered there. */
  private buildArtifactCard(parent: HTMLElement, path: string, checkpoint?: Checkpoint): void {
    const lower = path.toLowerCase();
    const isHtml = lower.endsWith(".html") || lower.endsWith(".htm");
    const file = this.app.vault.getAbstractFileByPath(path);
    const exists = file instanceof TFile;

    // Missing markdown preview: only surface a "deleted" row when we can actually
    // restore it — i.e. a snapshot of this-turn pre-write content exists. A path
    // that was never a real vault artifact (written outside the vault, e.g.
    // ~/.claude memory files, or created-and-removed within the turn → null
    // snapshot) isn't meaningfully "deleted"; a dead ✕ row with no action is just
    // noise floating in the transcript. Shown as a compact one-line row + Restore.
    if (!exists && !isHtml) {
      const rel = this.relPath(path);
      const before = checkpoint?.get(rel);
      if (typeof before !== "string") return;
      const row = parent.createDiv({ cls: "mva-artifact-deleted" });
      setIcon(row.createSpan({ cls: "mva-artifact-deleted-ico" }), "x");
      row.createSpan({ cls: "mva-artifact-deleted-name", text: `${noteBasename(path)} deleted` });
      const restore = row.createEl("button", { cls: "mva-btn", text: "Restore" });
      restore.onclick = async () => {
        try {
          await this.app.vault.create(rel, before);
          new Notice(`Restored ${noteBasename(path)} from this turn's snapshot.`);
          const holder = createDiv();
          this.buildArtifactCard(holder, path, checkpoint);
          const fresh = holder.firstElementChild;
          if (fresh) row.replaceWith(fresh);
        } catch {
          new Notice(`Couldn't restore ${noteBasename(path)}.`);
        }
      };
      return;
    }

    const card = parent.createDiv({ cls: "mva-artifact" });
    const head = card.createDiv({ cls: "mva-artifact-head" });
    setIcon(head.createSpan({ cls: "mva-artifact-ico" }), isHtml ? "file-code-2" : "file-text");
    const nameEl = head.createSpan({ cls: "mva-artifact-name", text: noteBasename(path) });
    head.createDiv({ cls: "mva-artifact-spacer" });
    const openAction = () => (isHtml ? this.openArtifact(path) : this.revealNote(path));
    const openBtn = head.createEl("button", { cls: "mva-btn mva-artifact-open", text: "View" });
    openBtn.onclick = (e) => {
      e.stopPropagation();
      openAction();
    };
    // The whole header opens the file (03-07 feedback: "a che servono se poi
    // neanche si aprono?"), and the name hover-previews like a wikilink.
    if (exists) {
      head.addClass("is-openable");
      this.clickable(head, () => openAction());
      if (!isHtml) this.addHoverPreview(nameEl, path);
    }

    // File gone (out-of-vault HTML path — deleted markdown already returned early
    // above): HTML falls back to a header-only card.
    if (!exists) {
      return;
    }

    if (isHtml) {
      const frame = card.createDiv({ cls: "mva-artifact-frame" });
      const iframe = frame.createEl("iframe");
      iframe.setAttr("sandbox", "allow-scripts"); // no allow-same-origin: isolated from the app
      iframe.src = this.app.vault.getResourcePath(file);
      frame.onclick = (e) => {
        e.stopPropagation();
        openAction();
      };
    } else {
      const frame = card.createDiv({ cls: "mva-artifact-frame is-md" });
      const body = frame.createDiv({ cls: "mva-artifact-md markdown-rendered" });
      void this.app.vault
        .cachedRead(file)
        .then((content) => MarkdownRenderer.render(this.app, content.slice(0, 3000), body, path, this))
        .catch(() => {});
      frame.createDiv({ cls: "mva-artifact-fade" });
      frame.onclick = (e) => {
        e.stopPropagation();
        openAction();
      };
    }
  }

  /** Open a non-markdown artifact. In-vault with a registered viewer for its
   *  extension (e.g. an HTML viewer plugin) → the workspace: focus the tab that
   *  already shows the file, else a new tab. In-vault without a viewer → its
   *  app:// resource URL. Outside the vault → the OS shell on the absolute path. */
  private openArtifact(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      const viewType = (
        this.app as unknown as {
          viewRegistry?: { getTypeByExtension?(ext: string): string | undefined };
        }
      ).viewRegistry?.getTypeByExtension?.(file.extension.toLowerCase());
      if (viewType) {
        const open = this.app.workspace
          .getLeavesOfType(viewType)
          .find((l) => (l.view as unknown as { file?: TFile }).file?.path === file.path);
        if (open) {
          this.app.workspace.revealLeaf(open);
          return;
        }
        void this.app.workspace.getLeaf("tab").openFile(file);
        return;
      }
      window.open(this.app.vault.getResourcePath(file));
      return;
    }
    try {
      const electron = require("electron") as { shell: { openPath(p: string): Promise<string> } };
      void electron.shell.openPath(path);
    } catch {
      new Notice("Couldn't open the artifact.");
    }
  }

  /* ------------------------------ tools ----------------------------- */

  private createToolCard(parent: HTMLElement, name: string, input: unknown): ToolCard {
    const meta = toolMeta(name, input);
    const card = parent.createDiv({ cls: "mva-tool is-running is-collapsed" });
    // Command tools show the command in their body ($-prefixed); marking the card
    // lets the expanded header drop the (duplicate) truncated command from its target.
    if (name === "Bash") card.addClass("is-command");
    const head = card.createDiv({ cls: "mva-tool-head" });
    const statusEl = head.createDiv({ cls: "mva-tool-status" });
    setIcon(statusEl, "loader");
    setIcon(head.createDiv({ cls: "mva-tool-icon" }), meta.icon);
    head.createSpan({ cls: "mva-tool-name", text: meta.label });
    if (meta.target) {
      const t = head.createSpan({ cls: "mva-tool-target", text: meta.target });
      if (meta.openPath) {
        t.addClass("mva-link");
        t.onclick = (e) => {
          e.stopPropagation();
          this.openNote(meta.openPath as string);
        };
      }
    }
    const elapsedEl = head.createSpan({ cls: "mva-tool-elapsed", text: "" });
    const bodyEl = card.createDiv({ cls: "mva-tool-body" });
    renderToolDetail(bodyEl, name, input, null);
    this.clickable(head, () => card.toggleClass("is-collapsed", !card.hasClass("is-collapsed")));
    return { card, statusEl, bodyEl, elapsedEl, startedAt: Date.now() };
  }

  private finishToolCard(c: ToolCard, ok: boolean, output: string): void {
    c.card.removeClass("is-running");
    c.card.addClass(ok ? "is-ok" : "is-error");
    c.elapsedEl.setText(""); // running-only; the row is settled now
    c.statusEl.empty();
    setIcon(c.statusEl, ok ? "check" : "x");
    // On failure, surface the reason on the row itself (visible while collapsed),
    // so a red mark isn't a dead end that forces an expand to learn "why".
    if (!ok) {
      const line = firstErrorLine(output);
      if (line) c.card.querySelector(".mva-tool-head")?.insertAdjacentElement(
        "afterend",
        createDiv({ cls: "mva-tool-error-preview", text: line })
      );
    }
    if (output) {
      const out = c.bodyEl.createEl("pre", { cls: "mva-tool-output" });
      const capped = output.length > 4000;
      out.createEl("code", { text: capped ? output.slice(0, 4000) + "\n… (truncated)" : output });
      if (capped) {
        const actions = c.bodyEl.createDiv({ cls: "mva-tool-output-actions" });
        const more = actions.createEl("button", { cls: "mva-btn", text: "Show more" });
        more.onclick = () => {
          out.empty();
          out.createEl("code", {
            text: output.length > 20000 ? output.slice(0, 20000) + "\n… (truncated)" : output,
          });
          more.remove();
        };
        const copy = actions.createEl("button", { cls: "mva-btn", text: "Copy full output" });
        copy.onclick = () => {
          void navigator.clipboard.writeText(output);
          copy.setText("Copied");
          window.setTimeout(() => copy.setText("Copy full output"), 1200);
        };
      }
    }
  }

  private addToolCard(ctx: AssistantCtx, id: string, name: string, input: unknown): void {
    this.dropThinking(ctx);
    this.resetTextStream(ctx);
    let parent: HTMLElement = ctx.bodyEl;
    if (stepPlacement(name, input) === "timeline") {
      const run = this.ensureStepsRun(ctx);
      parent = run.body;
      run.noteToolAdded(name, input);
      ctx.runById.set(id, run);
    } else {
      this.closeStepsRun(ctx); // excluded card breaks the run and stays flat
    }
    const refs = this.createToolCard(parent, name, input);
    ctx.cards.set(id, refs);
    const seg: Segment = { t: "tool", name, input, ok: null, output: "" };
    ctx.segments.push(seg);
    ctx.segById.set(id, seg);
    this.scrollConvo(ctx.convo);
  }

  private resolveToolCard(ctx: AssistantCtx, id: string, ok: boolean, output: string): void {
    const card = ctx.cards.get(id);
    const seg = ctx.segById.get(id);
    if (seg && seg.t === "tool") {
      seg.ok = ok;
      seg.output = output;
    }
    if (!card) return;
    this.finishToolCard(card, ok, output);
    this.scrollConvo(ctx.convo);
  }

  /* ---------------------- background tasks (F3) --------------------- */

  /** Append a small badge chip to a tool card's head. */
  private addToolBadge(card: HTMLElement, text: string): HTMLElement {
    const head = (card.querySelector(".mva-tool-head") as HTMLElement | null) ?? card;
    return head.createSpan({ cls: "mva-badge-bg", text });
  }

  /** On tool-call-start: badge a background Bash card and link BashOutput/KillShell
   *  cards to their originating background task (presentational only — no polling). */
  private trackBackgroundTask(ctx: AssistantCtx, id: string, name: string, input: unknown): void {
    const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const card = ctx.cards.get(id)?.card;
    if (!card) return;
    if (name === "Bash" && i.run_in_background === true) {
      card.addClass("mva-tool-bg");
      const badge = this.addToolBadge(card, "background");
      ctx.bgTasks.set(id, { cardEl: card, badgeEl: badge });
      return;
    }
    if (name === "BashOutput" || name === "KillShell") {
      const sid =
        (typeof i.bash_id === "string" && i.bash_id) ||
        (typeof i.shell_id === "string" && i.shell_id) ||
        "";
      if (!sid) return;
      for (const task of ctx.bgTasks.values()) {
        if (task.shellId && task.shellId === sid) {
          card.addClass("mva-tool-bg");
          this.addToolBadge(card, "↳ background task");
          task.badgeEl.setText(name === "KillShell" ? "stopped" : "running");
          break;
        }
      }
    }
  }

  /** On tool-call-result of a background Bash: parse the shell id from the CLI
   *  output so later BashOutput/KillShell calls can link back to this task. */
  private linkBackgroundResult(ctx: AssistantCtx, id: string, output: string): void {
    const task = ctx.bgTasks.get(id);
    if (!task) return;
    const sid =
      output.match(/\b(bash_[\w-]+)\b/)?.[1] ||
      output.match(/shell(?:Id)?[:\s]+([\w-]+)/i)?.[1] ||
      output.match(/\bID[:\s]+([\w-]+)/i)?.[1];
    if (sid) task.shellId = sid;
  }

  /* ------------------------ subagents (F4) ------------------------- */

  /** Register a Task card as a nesting target: a collapsed "Subagent activity (N)"
   *  section appended below the card, into which the subagent's tool calls nest. */
  private registerTaskCard(ctx: AssistantCtx, id: string): void {
    const card = ctx.cards.get(id)?.card;
    if (!card) return;
    const container = card.createDiv({ cls: "mva-subagent is-collapsed" });
    const summaryEl = container.createDiv({ cls: "mva-subagent-summary", text: "Subagent activity (0)" });
    const rowsEl = container.createDiv({ cls: "mva-subagent-rows" });
    this.clickable(summaryEl, () => container.toggleClass("is-collapsed", !container.hasClass("is-collapsed")));
    ctx.taskCards.set(id, { container, summaryEl, rowsEl, count: 0 });
  }

  /** Nest a subagent tool call as a mini-row under its parent Task card. Returns
   *  false if the parent isn't tracked, so the caller can fall back to a flat card. */
  private addSubagentRow(ctx: AssistantCtx, parentId: string, id: string, name: string, input: unknown): boolean {
    const task = ctx.taskCards.get(parentId);
    if (!task) return false;
    const meta = toolMeta(name, input);
    const row = task.rowsEl.createDiv({ cls: "mva-subagent-row" });
    const dot = row.createSpan({ cls: "mva-subagent-dot" });
    row.createSpan({ cls: "mva-subagent-tool", text: meta.label });
    if (meta.target) row.createSpan({ cls: "mva-subagent-arg", text: meta.target });
    task.count++;
    task.summaryEl.setText(`Subagent activity (${task.count})`);
    ctx.nestedRows.set(id, { dotEl: dot, parentId });
    this.scrollConvo(ctx.convo);
    return true;
  }

  /** Mark a subagent mini-row ok/error on its result. Returns false if not nested. */
  private resolveSubagentRow(ctx: AssistantCtx, id: string, ok: boolean): boolean {
    const row = ctx.nestedRows.get(id);
    if (!row) return false;
    row.dotEl.addClass(ok ? "is-ok" : "is-error");
    return true;
  }

  /** On the Task's own result, mark its subagent section complete. */
  private markTaskDone(ctx: AssistantCtx, id: string): void {
    const task = ctx.taskCards.get(id);
    if (!task) return;
    task.summaryEl.setText(`Subagent activity (${task.count}) — done`);
  }

  /* -------------------------- permissions --------------------------- */

  private addPermissionCard(
    ctx: AssistantCtx,
    c: Convo,
    tool: string,
    input: unknown,
    resolve: (d: { behavior: "allow"; remember?: boolean } | { behavior: "deny"; message?: string }) => void
  ): void {
    this.dropThinking(ctx);
    this.resetTextStream(ctx);
    this.closeStepsRun(ctx);
    const meta = toolMeta(tool, input);
    const card = ctx.bodyEl.createDiv({ cls: "mva-perm" });
    const head = card.createDiv({ cls: "mva-perm-head" });
    setIcon(head.createDiv({ cls: "mva-perm-icon" }), "shield-alert");
    head.createSpan({ cls: "mva-perm-title", text: `Allow ${meta.label}?` });
    if (meta.target) head.createSpan({ cls: "mva-tool-target", text: meta.target });
    renderToolDetail(card.createDiv({ cls: "mva-perm-detail" }), tool, input, null);

    const actions = card.createDiv({ cls: "mva-perm-actions" });
    let done = false;
    const finishCard = (
      verdict: string,
      d: { behavior: "allow"; remember?: boolean } | { behavior: "deny"; message?: string }
    ) => {
      if (done) return;
      done = true;
      c.pendingPerm = null;
      card.addClass("is-resolved");
      actions.empty();
      card.createDiv({ cls: "mva-perm-verdict", text: verdict });
      resolve(d);
    };
    const settle = (
      d: { behavior: "allow"; remember?: boolean } | { behavior: "deny"; message?: string }
    ) => finishCard(d.behavior === "deny" ? "Denied" : d.remember ? "Always allowed" : "Allowed", d);
    // If the user presses Stop while this card is open, cancel it (the provider
    // side is already unblocked via interrupt → deny).
    c.pendingPerm = () => finishCard("Cancelled", { behavior: "deny", message: "Stopped." });
    this.plugin.emitConvoState(c.id, "needs-input", { reason: "perm" }); // fire-and-forget board hook (no-op when off; can't throw)
    actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Allow once" }).onclick = () =>
      settle({ behavior: "allow" });
    const alwaysBtn = actions.createEl("button", { cls: "mva-btn", text: "Always allow" });
    const scope =
      tool === "Bash"
        ? `all \`${(((input as Record<string, unknown>)?.command as string) || "").trim().split(/\s+/)[0] || "shell"}\` commands`
        : WRITE_TOOLS.test(tool) && toolFilePath(tool, input)
          ? `edits to this file`
          : `this tool`;
    alwaysBtn.setAttr("aria-label", `Always allow ${scope} in this conversation`);
    alwaysBtn.setAttr("title", `Always allow ${scope} in this conversation`);
    alwaysBtn.onclick = () => {
      c.allow.add(allowKey(tool, input));
      // Durable across sessions when enabled: append the equivalent rule line.
      if (this.plugin.settings.rememberAlwaysAllow) {
        const line = permRuleLine(tool, input);
        const rules = this.plugin.settings.permAllowRules;
        if (!rules.split("\n").some((l) => l.trim() === line)) {
          this.plugin.settings.permAllowRules = (rules.trimEnd() ? rules.trimEnd() + "\n" : "") + line;
          void this.plugin.saveSettings();
        }
      }
      settle({ behavior: "allow", remember: true });
    };
    actions.createEl("button", { cls: "mva-btn mva-btn-danger", text: "Deny" }).onclick = () =>
      settle({ behavior: "deny", message: "Denied by user." });
    this.scrollConvo(c);
  }

  /* ------------------------------- plan ----------------------------- */

  /** Read a plan file saved by the CLI (absolute path, outside the vault — e.g.
   *  ~/.claude/plans/…). Node fs, since the vault adapter only sees vault files.
   *  Returns null on any failure so the card degrades gracefully. */
  private async readPlanFile(filePath: string): Promise<string | null> {
    try {
      const fs = require("fs") as typeof import("fs");
      return await fs.promises.readFile(filePath, "utf8");
    } catch {
      return null;
    }
  }

  /** Dedicated plan-approval card for ExitPlanMode (the Trust Pack centerpiece).
   *  Renders the proposed plan markdown for review with two actions:
   *  "Approve & build" → allow (and restore the pre-plan permission mode so the
   *  build runs under normal gating), and "Revise" → deny with feedback (plan
   *  mode stays active so the agent revises). Collapses to a settled one-liner on
   *  resolution and records a persisted `plan` segment. */
  private async renderPlanCard(
    ctx: AssistantCtx,
    c: Convo,
    input: unknown,
    resolve: (d: { behavior: "allow" } | { behavior: "deny"; message?: string }) => void
  ): Promise<void> {
    this.dropThinking(ctx);
    this.resetTextStream(ctx);
    this.closeStepsRun(ctx);
    const parts = planInputParts(input);
    let planMd = parts.md;
    if (!planMd && parts.filePath) planMd = await this.readPlanFile(parts.filePath);
    planMd = planMd || "_The agent didn't include a plan body._";

    // Persisted segment — approved:null until the user acts.
    const seg: Segment = { t: "plan", md: planMd, approved: null };
    ctx.segments.push(seg);

    // Default EXPANDED: this is the thing to review. Reuses the .mva-reason
    // collapsed-block grammar (head / chevron / body).
    const card = ctx.bodyEl.createDiv({ cls: "mva-plan-card" });
    const head = card.createDiv({ cls: "mva-plan-head" });
    setIcon(head.createSpan({ cls: "mva-reason-chevron" }), "chevron-right");
    setIcon(head.createSpan({ cls: "mva-plan-icon" }), "clipboard-list");
    head.createSpan({ cls: "mva-plan-title", text: "Plan" });
    this.clickable(head, () => card.toggleClass("is-collapsed", !card.hasClass("is-collapsed")));
    const body = card.createDiv({ cls: "mva-plan-body" });
    void MarkdownRenderer.render(this.app, planMd, body, "", this);

    let done = false;
    const md = planMd;
    const finish = (
      approved: boolean,
      d: { behavior: "allow" } | { behavior: "deny"; message?: string }
    ) => {
      if (done) return;
      done = true;
      c.pendingPerm = null;
      seg.approved = approved;
      // building=true only on a live approval — the historical/restored card omits it.
      this.renderPlanSettled(card, md, approved, approved);
      resolve(d);
    };

    // Stop cancels the open card (provider side already unblocked via interrupt).
    c.pendingPerm = () => finish(false, { behavior: "deny", message: "Stopped." });
    this.plugin.emitConvoState(c.id, "needs-input", { reason: "perm" }); // fire-and-forget board hook (no-op when off; can't throw)

    const actions = card.createDiv({ cls: "mva-plan-actions" });
    actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Approve & build" }).onclick = () => {
      // Restore the pre-plan permission mode so subsequent build actions are
      // gated normally (setting + live session + perm chip all in sync).
      const s = this.plugin.settings;
      if (s.permissionMode === "plan") {
        const restore = this.prePlanMode ?? "default";
        s.permissionMode = restore;
        void this.plugin.saveSettings();
        c.session?.setPermissionMode?.(restore);
        this.composer.refreshPerm();
      }
      finish(true, { behavior: "allow" });
    };
    const reviseBtn = actions.createEl("button", { cls: "mva-btn", text: "Revise" });
    reviseBtn.onclick = () => {
      if (card.querySelector(".mva-plan-revise")) return; // already revealed
      reviseBtn.disabled = true;
      const revise = card.createDiv({ cls: "mva-plan-revise" });
      const ta = revise.createEl("textarea", {
        cls: "mva-plan-revise-input",
        attr: { placeholder: "What should change about this plan?", rows: "3" },
      });
      const sendRow = revise.createDiv({ cls: "mva-plan-revise-actions" });
      const send = sendRow.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Send" });
      const submit = () => {
        const feedback = ta.value.trim();
        // Deny keeps plan mode active → the agent revises rather than building.
        finish(false, { behavior: "deny", message: feedback || "Please revise the plan." });
      };
      send.onclick = submit;
      // Cmd/Ctrl+Enter sends (a bare Enter should add a newline in the textarea).
      ta.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
          ev.preventDefault();
          submit();
        }
      });
      ta.focus();
      this.scrollConvo(c);
    };
    this.scrollConvo(c);
  }

  /** Settled read-only plan card: collapsed, expandable, with the approved/
   *  revised state line. Shared by live resolution and transcript restore so
   *  they render identically (mirrors renderAskSummary). */
  private renderPlanSettled(card: HTMLElement, md: string, approved: boolean, building = false): void {
    card.empty();
    card.className = "mva-plan-card is-resolved is-collapsed";
    const head = card.createDiv({ cls: "mva-plan-head" });
    setIcon(head.createSpan({ cls: "mva-reason-chevron" }), "chevron-right");
    setIcon(head.createSpan({ cls: "mva-plan-icon" }), "clipboard-list");
    head.createSpan({ cls: "mva-plan-title", text: "Plan" });
    head.createSpan({ cls: "mva-plan-state", text: planStateText(approved, building) });
    const body = card.createDiv({ cls: "mva-plan-body" });
    void MarkdownRenderer.render(this.app, md, body, "", this);
    this.clickable(head, () => card.toggleClass("is-collapsed", !card.hasClass("is-collapsed")));
  }

  /* -------------------------------- ask ----------------------------- */

  /** Bridge invoked by the in-process `ask_user` tool: render an ask card into
   *  the OWNING conversation's in-flight turn and resolve with the user's choices
   *  (header → answer). The owning convo is captured by the per-session server
   *  closure, so parallel conversations can't cross-render.
   *  Rejects if there's no live turn (the tool then reports a graceful dismissal). */
  private askBridge(c: Convo, questions: AskQuestion[]): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      const ctx = c.currentCtx;
      if (!ctx) {
        reject(new Error("no active turn"));
        return;
      }
      this.renderAskCard(ctx, c, questions, resolve, reject);
    });
  }

  /** Render a structured question card (permission-card pattern). A single
   *  single-select question resolves on click; anything else needs a Submit. */
  private renderAskCard(
    ctx: AssistantCtx,
    c: Convo,
    questions: AskQuestion[],
    resolve: (a: Record<string, string>) => void,
    reject: (e: Error) => void
  ): void {
    this.dropThinking(ctx);
    this.resetTextStream(ctx);
    this.closeStepsRun(ctx);
    this.notifyOnce(ctx, "waiting", "Exo — waiting for you", "The agent asked a question / needs permission.");
    const card = ctx.bodyEl.createDiv({ cls: "mva-ask" });
    this.openCard(ctx); // the ask card is now the feedback (working row hides)
    const answers: Record<string, string> = {};
    const seg: Segment = { t: "ask", questions, answers };
    ctx.segments.push(seg);

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      c.pendingAsk = null;
      // Collapse to the same compact summary used when the transcript is restored,
      // so live-resolved and reloaded cards look identical.
      this.renderAskSummary(card, questions, answers);
      this.closeCard(ctx); // release the card slot — working row returns if needed
      resolve(answers);
    };
    // Stop (or turn teardown) cancels the card → the tool reports a dismissal.
    c.pendingAsk = () => {
      if (done) return;
      done = true;
      c.pendingAsk = null;
      this.closeCard(ctx); // cancelled (Stop / teardown) → release the slot
      reject(new Error("cancelled"));
    };
    this.plugin.emitConvoState(c.id, "needs-input", { reason: "ask" }); // fire-and-forget board hook (no-op when off; can't throw)

    const selections = questions.map(() => new Set<string>());
    const maybeSubmit = () => {
      if (questions.every((q, i) => selections[i].size > 0)) {
        questions.forEach((q, i) => (answers[q.header] = [...selections[i]].join(", ")));
        finish();
      }
    };

    // Submit is enabled only once every question has a selection (multi-question
    // cards); the single-question single-select case resolves without a Submit.
    let submitBtn: HTMLButtonElement | null = null;
    const allAnswered = () => questions.every((_, i) => selections[i].size > 0);
    const updateSubmit = () => submitBtn?.toggleClass("is-disabled", !allAnswered());

    questions.forEach((q, i) => {
      const qEl = card.createDiv({ cls: "mva-ask-q" });
      const chip = qEl.createSpan({ cls: "mva-ask-chip", text: q.header });
      qEl.createDiv({ cls: "mva-ask-question", text: q.question });
      const opts = qEl.createDiv({ cls: "mva-ask-opts" });
      const single = questions.length === 1 && !q.multiSelect;
      // Only multi-question cards get the per-question answered check.
      const markChip = () => {
        if (questions.length > 1) chip.toggleClass("is-answered", selections[i].size > 0);
      };

      let otherVal = "";
      let otherInput: HTMLInputElement | null = null;

      for (const o of q.options) {
        const b = opts.createEl("button", {
          cls: `mva-ask-opt ${q.multiSelect ? "is-multi" : "is-single"}`,
        });
        b.createSpan({ cls: "mva-ask-ind" });
        const txt = b.createDiv({ cls: "mva-ask-opt-text" });
        txt.createDiv({ cls: "mva-ask-opt-label", text: o.label });
        if (o.description) txt.createDiv({ cls: "mva-ask-opt-desc", text: o.description });
        b.onclick = () => {
          if (q.multiSelect) {
            const sel = !b.hasClass("is-sel");
            b.toggleClass("is-sel", sel);
            if (sel) selections[i].add(o.label);
            else selections[i].delete(o.label);
            markChip();
            updateSubmit();
          } else {
            opts.querySelectorAll(".mva-ask-opt").forEach((x) => (x as HTMLElement).removeClass("is-sel"));
            b.addClass("is-sel");
            selections[i].clear();
            selections[i].add(o.label);
            // Picking a preset option deselects any typed "Other" value.
            if (otherVal) selections[i].delete(otherVal);
            otherVal = "";
            if (otherInput) otherInput.value = "";
            markChip();
            if (single) {
              maybeSubmit();
              return;
            }
            updateSubmit();
          }
        };
      }

      // Ghost "Other…" row at the end — expands an inline input; the typed value
      // participates in the selection exactly like an option label.
      const otherRow = opts.createEl("button", { cls: "mva-ask-opt mva-ask-other-row" });
      setIcon(otherRow.createSpan({ cls: "mva-ask-ind mva-ask-ind-pencil" }), "pencil");
      const otherTxt = otherRow.createDiv({ cls: "mva-ask-opt-text" });
      const otherLabel = otherTxt.createDiv({ cls: "mva-ask-opt-label", text: "Other…" });
      const onOtherInput = () => {
        if (otherVal) selections[i].delete(otherVal);
        otherVal = (otherInput?.value ?? "").trim();
        if (otherVal) {
          if (!q.multiSelect) {
            opts.querySelectorAll(".mva-ask-opt").forEach((x) => (x as HTMLElement).removeClass("is-sel"));
            selections[i].clear();
          }
          selections[i].add(otherVal);
          otherRow.addClass("is-sel");
        } else {
          otherRow.removeClass("is-sel");
        }
        markChip();
        updateSubmit();
      };
      const expandOther = () => {
        if (otherInput) {
          otherInput.focus();
          return;
        }
        otherLabel.remove();
        otherInput = otherTxt.createEl("input", {
          cls: "mva-ask-other",
          attr: { type: "text", placeholder: "Type your answer…" },
        });
        // Clicks inside the input must not re-fire the row's expand handler.
        otherInput.addEventListener("click", (ev) => ev.stopPropagation());
        otherInput.addEventListener("input", onOtherInput);
        // Single-question single-select has no Submit button — let Enter resolve it.
        if (single) {
          otherInput.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") {
              ev.preventDefault();
              maybeSubmit();
            }
          });
        }
        otherInput.focus();
      };
      otherRow.onclick = () => expandOther();

      // Arrow-key navigation within a question's option rows (Enter/Space are
      // native button activation).
      opts.addEventListener("keydown", (ev) => {
        if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
        const rows = Array.from(opts.querySelectorAll<HTMLElement>(".mva-ask-opt"));
        const idx = rows.indexOf(document.activeElement as HTMLElement);
        if (idx < 0) return;
        ev.preventDefault();
        const next = ev.key === "ArrowDown" ? (idx + 1) % rows.length : (idx - 1 + rows.length) % rows.length;
        rows[next].focus();
      });
    });

    if (!(questions.length === 1 && !questions[0].multiSelect)) {
      const actions = card.createDiv({ cls: "mva-ask-actions" });
      submitBtn = actions.createEl("button", { cls: "mva-btn mva-btn-primary is-disabled", text: "Submit" });
      submitBtn.onclick = () => {
        if (!allAnswered()) return;
        questions.forEach((q, i) => (answers[q.header] = [...selections[i]].join(", ")));
        if (Object.values(answers).some((v) => v)) finish();
      };
      updateSubmit();
    }
    this.scrollConvo(c);
  }

  /** Compact resolved view of an ask card: header chip + question + chosen answer
   *  per question. Shared by live-resolve and transcript restore so they match. */
  private renderAskSummary(
    card: HTMLElement,
    questions: AskQuestion[],
    answers: Record<string, string>
  ): void {
    card.empty();
    card.addClass("is-resolved");
    for (const q of questions) {
      const qEl = card.createDiv({ cls: "mva-ask-q" });
      qEl.createSpan({ cls: "mva-ask-chip", text: q.header });
      qEl.createDiv({ cls: "mva-ask-question", text: q.question });
      qEl.createDiv({ cls: "mva-ask-answer", text: `→ ${answers[q.header] ?? "—"}` });
    }
  }

  /* ----------------------------- send ------------------------------- */

  private scrollToBottom(): void {
    this.scrollConvo(this.active);
  }

  /** Scroll a conversation to the bottom — only if it's the visible one AND the
   *  user hasn't scrolled up. Coalesced into one rAF write per frame to avoid
   *  layout thrash during streaming. */
  private scrollConvo(c: Convo): void {
    if (c !== this.active || !this.pinnedToBottom) {
      this.updateJumpPill();
      return;
    }
    if (this.scrollRaf !== null) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = null;
      this.listEl.scrollTop = this.listEl.scrollHeight;
      this.updateJumpPill();
    });
  }

  /** Attach the scroll-position tracker to a conversation's list element. */
  private wireScroll(c: Convo): void {
    this.registerDomEvent(c.listEl, "scroll", () => {
      if (c !== this.active) return;
      const el = c.listEl;
      this.pinnedToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      this.updateJumpPill();
      // Keep the outline's active tick in sync with the viewport (rAF-coalesced
      // so a fast scroll fires at most one rect read per frame).
      if (this.outlineRaf === null) {
        this.outlineRaf = requestAnimationFrame(() => {
          this.outlineRaf = null;
          this.updateOutlineActive();
        });
      }
    });
  }

  /** Rebuild the Notion-style outline from the ACTIVE conversation's DOM.
   *  Ported from the sibling `notion-outline` plugin: a full-height tick STRIP at the
   *  right edge that expands, on hover, into a floating PANEL of labelled rows —
   *  a JS `is-expanded` toggle with an anti-flicker collapse delay, not a bare
   *  CSS `:hover` (which snapped shut the moment the cursor left the thin strip).
   *  Derived from `.mva-user` turns (always in sync with what's rendered). Shown
   *  only with >=2 user messages and never over the gallery/capabilities panel.
   *  Idempotent — safe to call on any lifecycle transition. */
  private rebuildOutline(): void {
    this.outlineEl?.remove();
    this.outlineEl = null;
    if (this.outlineCollapseTimer !== null) {
      window.clearTimeout(this.outlineCollapseTimer);
      this.outlineCollapseTimer = null;
    }
    if (this.galleryEl || this.capsEl) return; // hidden behind full-pane overlays
    const turns = Array.from(this.listEl.querySelectorAll<HTMLElement>(".mva-user"));
    if (turns.length < 2) return; // no rail for a single-message conversation

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Root spans the full right edge but is click-through (pointer-events:none in
    // CSS); only the strip and the expanded panel capture the pointer, so the rest
    // of the conversation edge stays free for scrolling and the jump pill.
    const root = this.listWrap.createDiv({ cls: "mva-outline" });
    const strip = root.createDiv({ cls: "mva-outline-strip" });
    const panel = root.createDiv({ cls: "mva-outline-panel" });
    for (const turn of turns) {
      const raw = (turn.textContent || "").replace(/\s+/g, " ").trim();
      const label = raw.length > 60 ? raw.slice(0, 59).trimEnd() + "…" : raw || "(empty message)";
      const tick = strip.createDiv({ cls: "mva-outline-tick" });
      tick.setAttribute("aria-hidden", "true");
      tick.addEventListener("click", () => this.jumpToTurn(turn, reduce));
      const row = panel.createDiv({ cls: "mva-outline-row", text: label });
      row.setAttribute("aria-label", `Jump to message: ${label}`);
      this.clickable(row, () => this.jumpToTurn(turn, reduce));
    }
    // Expand/collapse with a collapse delay so crossing the strip→panel gap (during
    // the opacity swap) doesn't flicker the panel shut mid-interaction.
    root.addEventListener("mouseenter", () => {
      if (this.outlineCollapseTimer !== null) {
        window.clearTimeout(this.outlineCollapseTimer);
        this.outlineCollapseTimer = null;
      }
      root.addClass("is-expanded");
    });
    root.addEventListener("mouseleave", () => {
      this.outlineCollapseTimer = window.setTimeout(() => {
        root.removeClass("is-expanded");
        this.outlineCollapseTimer = null;
      }, 160);
    });
    this.outlineEl = root;
    this.updateOutlineActive();
  }

  /** Mark the tick + row whose user turn is nearest the top of the viewport. */
  private updateOutlineActive(): void {
    const root = this.outlineEl;
    if (!root) return;
    const turns = Array.from(this.listEl.querySelectorAll<HTMLElement>(".mva-user"));
    const ticks = Array.from(root.querySelectorAll<HTMLElement>(".mva-outline-tick"));
    const rows = Array.from(root.querySelectorAll<HTMLElement>(".mva-outline-row"));
    if (turns.length !== ticks.length) return; // out of sync — a rebuild will fix it
    const refTop = this.listEl.getBoundingClientRect().top;
    let activeIdx = 0;
    for (let i = 0; i < turns.length; i++) {
      // Last turn whose top edge is at or above the viewport top (+ small slack).
      if (turns[i].getBoundingClientRect().top - refTop <= 8) activeIdx = i;
      else break;
    }
    ticks.forEach((t, i) => t.toggleClass("is-active", i === activeIdx));
    rows.forEach((r, i) => r.toggleClass("is-active", i === activeIdx));
  }

  /** Smooth-scroll a user turn to near the top and flash it briefly. Instant
   *  scroll + no motion when reduced-motion is requested. */
  private jumpToTurn(turn: HTMLElement, reduce: boolean): void {
    turn.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    turn.removeClass("is-flash");
    void turn.offsetWidth; // restart the fade if the same turn is clicked twice
    turn.addClass("is-flash");
    window.setTimeout(() => turn.removeClass("is-flash"), 1000);
  }

  /** Show/hide the floating jump-to-bottom pill based on pin state. */
  private updateJumpPill(): void {
    const show = !this.pinnedToBottom;
    if (show) {
      if (!this.jumpPill) {
        const pill = this.listWrap.createDiv({
          cls: "mva-jump-pill",
          attr: { "aria-label": "Jump to latest" },
        });
        setIcon(pill, "chevron-down");
        this.clickable(pill, () => {
          this.pinnedToBottom = true;
          this.listEl.scrollTop = this.listEl.scrollHeight;
          this.updateJumpPill();
        });
        this.jumpPill = pill;
      }
    } else if (this.jumpPill) {
      this.jumpPill.remove();
      this.jumpPill = null;
    }
  }

  private setStreaming(c: Convo, on: boolean): void {
    c.streaming = on;
    if (on) this.plugin.emitConvoState(c.id, "turn-start"); // fire-and-forget board hook (no-op when off; can't throw)
    if (c === this.active) this.syncSendButton();
    this.refreshAgentIndicators(); // per-tab streaming dot + agent counts + pinned chip
    // Never show the tail "Related" section mid-stream — hide it the instant a
    // turn starts. The turn-end path (runTurn's `finally`) is responsible for
    // re-showing it once the queue is fully drained.
    if (on) {
      c.tailSurfaceEl?.remove();
      c.tailSurfaceEl = null;
    }
  }

  /** How many background agents a conversation owns RIGHT NOW: subagent (Task)
   *  tool-calls still in flight plus background Bash shells launched this turn.
   *  Read from the convo's live turn context (each convo has its own), so a chat
   *  streaming in the background reports its own count. Zero once the turn ends
   *  (currentCtx is cleared) — Exo never claims work it can no longer observe. */
  private agentCount(c: Convo): number {
    const ctx = c.currentCtx;
    return ctx ? ctx.runningTasks.size + ctx.bgTasks.size : 0;
  }

  /** Refresh both per-chat agent affordances: the per-tab count badges (via
   *  renderTabs) and the pinned chip above the composer, which reflects ONLY the
   *  open chat's own agents. Strictly local — a background chat's work never leaks
   *  into the chat you're looking at; you see its count on its own tab. */
  private refreshAgentIndicators(): void {
    this.renderTabs();
    const chip = this.agentChipEl;
    if (!chip) return;
    const n = this.active ? this.agentCount(this.active) : 0;
    chip.empty();
    chip.toggleClass("is-hidden", n === 0);
    if (n === 0) return;
    setIcon(chip.createSpan({ cls: "mva-agents-icon" }), "loader");
    chip.createSpan({ cls: "mva-agents-label", text: n === 1 ? "1 agent running" : `${n} agents running` });
    this.clickable(chip, () => this.scrollConvo(this.active));
  }

  /**
   * Terminal convo-state hook, fired once from `runTurn`'s `finally`. Maps the
   * turn's end state to the board vocabulary: user-stopped → `stopped`;
   * errored/poisoned → `needs-input` (reason `error`); otherwise a clean
   * `turn-end` (→ Review). A thin pass-through to the plugin channel, which is
   * already flag-guarded and try/catches every listener — so this cannot throw,
   * block, or slow the turn, and is a strict no-op when orchestration is off.
   */
  private emitTurnTerminal(c: Convo, poisoned: boolean): void {
    const { state, reason } = terminalConvoState({ stopped: c.stopped, poisoned });
    this.plugin.emitConvoState(c.id, state, reason ? { reason } : undefined);
  }

  private stop(source: "esc" | "button" = "button"): void {
    const c = this.active;
    // `stopped` resets at turn start, so true here means a PRIOR stop this turn
    // didn't settle it — the interrupt was swallowed (stuck transport, zombie
    // CLI). Escalate: dispose the session so the parked send() rejects, the
    // turn closes, and the composer unblocks. Next message starts fresh (the
    // on-disk transcript is still resumable). See stopAction in core/recovery.
    const action = stopAction(c.stopped);
    this.diag.push("stop", `${source} → ${action}`);
    c.stopped = true;
    c.queue = [];
    this.renderQueue(c);
    c.pendingPerm?.(); // cancel any open permission card
    c.pendingAsk?.(); // cancel any open ask card
    if (action === "dispose") {
      this.dropSession(c);
      new Notice("Exo — session force-reset");
      return;
    }
    c.session?.interrupt();
    // Esc is heavily overloaded in Obsidian and the view-level handler catches it
    // wherever focus sits inside the view — an accidental press silently killed
    // turns with zero attribution (2026-07-05: two "Exo si è bloccato" reports
    // that were really unnoticed Esc stops). The button gives its own feedback.
    if (source === "esc") new Notice("Exo — stopped (Esc)");
  }

  /** One-shot hidden prefix for the next send() — set by askInNewConversation
   *  on cross-plugin handoffs (e.g. Sonar's `?` intent), consumed exactly once. */
  private handoffPrefix: string | null = null;

  private send(): void {
    let text = this.composer.getInputValue().trim();
    const pendingImages = this.composer.getPendingImages();
    const handoff = this.handoffPrefix ?? undefined;
    this.handoffPrefix = null;
    const c = this.active;
    if (!text && pendingImages.length === 0) return;
    // `/compact [instructions]` is a local slash command, not a chat turn: route
    // it to compaction (mirrors the CLI, which intercepts /compact client-side)
    // instead of sending it to the model. Matches exactly "/compact" or
    // "/compact <instructions>" — never "/compactfoo".
    if (text === "/compact" || text.startsWith("/compact ")) {
      const instructions = text.slice("/compact".length).trim();
      this.composer.setInputValue("");
      this.composer.autoGrow();
      // compactActive() Notices on the no-session / streaming / non-Claude cases.
      this.compactActive(instructions || undefined);
      return;
    }
    const researchCommand = parseResearchCommand(text, c.researchMode, Date.now());
    let researchModeForTurn: ResearchModeState | undefined;
    if (researchCommand?.kind === "invalid") {
      new Notice(researchCommand.message);
      this.composer.focusInput();
      return;
    }
    if (researchCommand?.kind === "exit") {
      c.researchMode = researchCommand.state;
      this.composer.refreshResearch();
      this.composer.setInputValue("");
      this.persist();
      new Notice("Research Mode off");
      return;
    }
    if (researchCommand?.kind === "start") {
      c.researchMode = researchCommand.state;
      this.composer.refreshResearch();
      this.updateRecap();
      researchModeForTurn = researchCommand.state;
      text = researchCommand.question;
    }
    this.composer.setInputValue("");
    this.composer.autoGrow();
    const images = pendingImages.length ? pendingImages : undefined;
    this.composer.clearPendingImages();
    this.composer.renderImageStrip();
    // You always want to watch your own message land.
    this.pinnedToBottom = true;
    this.updateJumpPill();
    if (c.streaming) {
      // Mid-turn behavior. Default (steerMode "queue") always enqueues so the
      // message starts as the next turn. Opt-in "steer" injects into the live
      // turn (Claude Code parity). The provider's steer() owns the capability
      // contract — Codex has no steer (→ undefined → false), and Claude's steer
      // returns false when images are attached — so the shared path stays
      // provider-agnostic. A false return or a throw falls back to queue.
      let steered = false;
      if (!c.researchMode.enabled && this.plugin.settings.steerMode === "steer") {
        try {
          steered = c.session?.steer?.(text, images) ?? false;
        } catch {
          steered = false;
        }
      }
      if (steered) {
        // Render the user bubble now and flush it; the working row stays and the
        // turn continues folding this in — nothing is enqueued.
        this.addUserTurn(c, text, images);
        this.persist();
      } else {
        // queue while a turn is running (a handoff prefix rides along and is
        // forwarded by the queue-drain logic like the recovery recap)
        c.queue.push({
          text,
          images,
          sendPrefix: handoff,
          researchMode: researchModeForTurn ?? (
            c.researchMode.enabled ? { ...c.researchMode } : undefined
          ),
        });
        this.renderQueue(c);
      }
    } else {
      const turnOpts = handoff || researchModeForTurn
        ? { sendPrefix: handoff, researchMode: researchModeForTurn }
        : undefined;
      void this.runTurn(c, text, images, turnOpts);
    }
  }

  /** Run a multi-step workflow by enqueuing its steps; the turn-drain loop runs
   *  them in order. Stop (which clears the queue) aborts the remaining steps.
   *  Owns the "run first step, enqueue the rest" turn orchestration on behalf of
   *  the composer (which just hands over the resolved steps). */
  submitWorkflow(c: Convo, steps: string[]): void {
    if (steps.length === 0) return;
    const [first, ...rest] = steps;
    for (const s of rest) c.queue.push({ text: s });
    if (c.streaming) {
      // Busy: queue the first step too; it runs when the current turn drains.
      c.queue.unshift({ text: first });
      this.renderQueue(c);
    } else {
      this.renderQueue(c);
      void this.runTurn(c, first);
    }
  }

  /** Render queued (not-yet-sent) messages as removable chips. */
  private renderQueue(c: Convo): void {
    if (!c.queue.length) {
      c.pendingEl?.remove();
      c.pendingEl = null;
      return;
    }
    if (!c.pendingEl) c.pendingEl = c.listEl.createDiv({ cls: "mva-queue" });
    c.pendingEl.empty();
    c.queue.forEach((q, i) => {
      const row = c.pendingEl!.createDiv({ cls: "mva-queued" });
      setIcon(row.createSpan({ cls: "mva-queued-icon" }), "clock");
      row.createSpan({
        cls: "mva-queued-text",
        text: q.text + (q.images?.length ? `  📎${q.images.length}` : ""),
      });
      const x = row.createSpan({ cls: "mva-chip-x", attr: { "aria-label": "Remove" } });
      setIcon(x, "x");
      this.clickable(x, () => {
        c.queue.splice(i, 1);
        this.renderQueue(c);
      });
    });
    this.scrollConvo(c);
  }

  private async runTurn(
    c: Convo,
    text: string,
    images?: ImageAttachment[],
    opts?: {
      sendPrefix?: string;
      isRecoveryRetry?: boolean;
      reuseUserTurn?: boolean;
      researchMode?: ResearchModeState;
    }
  ): Promise<void> {
    const researchMode = opts?.researchMode ?? c.researchMode;
    let turnCaps: SessionCaps | null = c.session?.caps ?? null;
    const paths = c === this.active ? this.composer.contextPaths() : [];
    const message = paths.length
      ? `Context notes:\n${paths.map((p) => `- ${p}`).join("\n")}\n\n${text}`
      : text;

    // Images flow to both providers since Tranche A: Claude gets base64 blocks,
    // Codex gets temp files via `codex exec -i` (handled in the adapter).
    let imgs = images;
    const embedded = await this.composer.embeddedImages(text);
    if (embedded.length) imgs = [...(imgs ?? []), ...embedded];

    // Proactive recall (design 2026-07-09): pick the relevant, not-yet-injected
    // memories for THIS turn. Runs off the store's cached read; `[]` when the flag
    // is off or nothing clears the floor — in which case the outbound payload
    // below is built exactly as before this feature existed. Recovery retries skip
    // it: they reuse the prior turn's bubble and already carry a recap prefix.
    const recalled = opts?.isRecoveryRetry ? [] : await this.selectTurnRecall(c, message);

    // A recovery retry reuses the user bubble the poisoned turn already rendered —
    // don't render (or re-persist) a duplicate. The original message is still the
    // only "user" entry in c.messages for this turn.
    if (!opts?.isRecoveryRetry && !opts?.reuseUserTurn) {
      const userEl = this.addUserTurn(c, text, imgs);
      // Quiet "N memories recalled" affordance under the bubble — the trust
      // surface, so the injection is never invisible. Only when there were any.
      if (recalled.length) this.renderRecallAffordance(userEl, recalled);
      // Flush the user's message to disk immediately: it lives only in RAM until
      // the turn's finally otherwise, so an Obsidian crash mid-turn would lose the
      // exchange from the UI. The atomic write keeps this cheap and safe.
      this.persist();
    }
    const ctx = this.addAssistantTurn(c, text);
    c.currentCtx = ctx; // target for this conversation's ask_user cards
    c.stopped = false;
    this.setStreaming(c, true);

    // Working indicator (Feature 1): a persistent Claude-Code-style row so the
    // turn never looks dead between send/tools/output. One ticking timer per turn.
    const turnStart = Date.now();
    this.dropThinking(ctx); // the working row replaces the placeholder dots
    this.ensureWorking(ctx);
    const workingTimer = window.setInterval(() => {
      if (ctx.workingElapsed) ctx.workingElapsed.setText(`· ${this.fmtDuration(Date.now() - turnStart)}`);
      ctx.stepsRun?.tick((ms) => this.fmtDuration(ms));
      // Per-row elapsed (Task 4): tick every card still running, not just the
      // working-row/steps-header aggregates — a slow single tool (e.g. a long
      // Bash call) gets its own visible ticking time, including in parallel
      // subagent scenarios where several cards are running at once.
      for (const card of ctx.cards.values()) {
        if (card.card.hasClass("is-running")) {
          card.elapsedEl.setText(this.fmtDuration(Date.now() - card.startedAt));
        }
      }
      // Self-healing invariant: even if some future event branch forgets its
      // syncWorking call, the affordance repairs itself within a second — the
      // non-gated backstop that keeps a streaming turn from ever looking dead.
      this.syncWorking(ctx);
    }, 1000);

    const adapter = ADAPTERS[c.provider];
    const s = this.plugin.settings;

    // File snapshots taken before this turn's writes, for "Rewind code + conversation".
    const checkpoint: Checkpoint = new Map();
    // Pre-write snapshots are async; collect them so we can guarantee they've all
    // landed before we read/persist the checkpoint at turn end. (In acceptEdits /
    // bypass modes this tool-call-start snapshot is the only one — best-effort, it
    // races the write, but awaiting it keeps the checkpoint complete.)
    const snapshots: Promise<void>[] = [];

    // An error_during_execution result resolves the turn (no throw), so the catch's
    // dropSession never runs — the CLI session stays poisoned and every later turn
    // re-errors. Track it here and reset the session at turn end.
    let poisoned = false;

    // Diagnostics: first-delta latency markers (logged once per turn, deltas are
    // otherwise never logged — noise) + tool-id → name so result lines read well.
    this.diag.push("turn", `start convo=${c.id} provider=${c.provider}${opts?.isRecoveryRetry ? " (recovery-retry)" : ""}`);
    let sawText = false;
    let sawThinking = false;
    const toolNames = new Map<string, string>();

    const onEvent = (e: AgentEvent) => {
      switch (e.kind) {
        case "text-delta":
          if (!sawText) {
            sawText = true;
            this.diag.push("stream", "first text delta");
          }
          ctx.textStreaming = true;
          this.appendText(ctx, e.text);
          this.syncWorking(ctx); // the streaming caret is the feedback
          break;
        case "thinking-delta":
          if (!sawThinking) {
            sawThinking = true;
            this.diag.push("stream", "first thinking delta");
          }
          ctx.textStreaming = false;
          this.appendReasoning(ctx, e.text);
          this.setWorkingLabel(ctx, "Thinking…");
          this.syncWorking(ctx); // working row stays visible during thinking
          break;
        case "tool-call-start": {
          ctx.textStreaming = false; // any text segment ends when a tool runs
          if (e.name === "TodoWrite") {
            this.renderTodos(ctx, e.input);
            this.syncWorking(ctx); // keep the row below the todos panel
            break;
          }
          if (e.name === "mcp__obsidian__ask_user" || e.name === "AskUserQuestion") {
            // "AskUserQuestion" is the built-in name the model may emit — the
            // provider aliases it to mcp__obsidian__ask_user at execution time.
            this.diag.push("tool", "ask_user start");
            toolNames.set(e.id, "ask_user");
            // The ask card is rendered later by askBridge (which opens a card via
            // openCard). Until it appears, keep the working row visible so a stalled
            // or never-rendered card can never leave the turn looking dead.
            this.syncWorking(ctx);
            break;
          }
          // A real (non-interactive) tool is now running.
          toolNames.set(e.id, e.name);
          this.diag.push("tool", `${e.name} start${e.parentId ? " (sub)" : ""}`);
          // Observer cadence (W2-3): count this real tool-call as one step. Only
          // meaningful in "every-n-steps" mode; a no-op (state kept, never fires)
          // otherwise since the setting gate below short-circuits first.
          this.maybeStepObserve(c, ctx);
          // File tracking runs before the nesting branch: subagent writes must stay
          // rewindable (checkpoint) and visible in the touched-notes footer.
          const paths = toolFilePaths(e.name, e.input);
          if (e.name === "mcp__obsidian__insert_at_cursor") {
            const activePath = this.app.workspace.getActiveFile()?.path;
            if (activePath) paths.push(activePath);
          }
          const uniquePaths = [...new Set(paths.map((path) => this.concreteToolPath(path)))];
          if (uniquePaths.length) {
            const kind = WRITE_TOOLS.test(e.name) ? "write" : "read";
            for (const fp of uniquePaths) {
              if (kind === "read") ctx.sources.add(fp);
              else snapshots.push(this.snapshot(checkpoint, fp).catch(() => {})); // checkpoint before the write runs
              if (kind === "write") {
                // A file that doesn't exist yet at write-start is newly created this turn
                // (drives markdown preview cards; edits of existing notes don't get one).
                const rel = this.relPath(fp);
                if (!this.app.vault.getAbstractFileByPath(rel)) ctx.createdPaths.add(rel);
              }
              mergeTouched(ctx.touched, fp, kind);
            }
            if (kind === "write") {
              // Rename reveals/previews its destination; other tools use their
              // first (and normally only) path.
              ctx.writeById.set(e.id, uniquePaths[uniquePaths.length - 1]);
            }
          }
          // Feature 4: a subagent's tool call nests under its parent Task card
          // (ephemeral, live-only). Falls through to a flat card if the parent
          // isn't tracked, so nothing is lost.
          if (!(e.parentId && this.addSubagentRow(ctx, e.parentId, e.id, e.name, e.input))) {
            this.addToolCard(ctx, e.id, e.name, e.input);
            if (e.name === "Task") {
              this.registerTaskCard(ctx, e.id);
              ctx.runningTasks.add(e.id); // subagent in flight → counts as a running agent
            }
            this.trackBackgroundTask(ctx, e.id, e.name, e.input);
            // A flat, note-touching card is streaming-only feedback — dropped at
            // turn end once the touched-notes footer carries the same fact.
            if (uniquePaths.length) ctx.noteTouchIds.add(e.id);
            // Update the per-chat agent count when a subagent or a background shell
            // just launched (trackBackgroundTask records bg shells in ctx.bgTasks).
            if (e.name === "Task" || ctx.bgTasks.has(e.id)) this.refreshAgentIndicators();
          }
          // Working row: phase verb from the tool metadata, re-appended last so it
          // stays visible below the tool card during execution.
          this.setWorkingLabel(ctx, toolWorkingLabel(e.name, e.input));
          this.syncWorking(ctx);
          // Context panel goes live: show what this tool is doing right now. Guarded
          // to the active convo + wide main so nothing runs in the sidebar.
          if (c === this.active && this.isWideMain()) {
            this.currentActivity = { phrase: describeActivity(e.name, e.input) };
            this.updateContextLive(ctx);
          }
          break;
        }
        case "tool-call-result": {
          ctx.textStreaming = false;
          this.diag.push("tool", `${e.ok ? "ok" : "FAIL"} ${toolNames.get(e.id) ?? e.id.slice(0, 12)}`);
          // Feature 4: a nested subagent result updates its mini-row, not a card —
          // but the reveal path below still runs for nested writes.
          const nested = this.resolveSubagentRow(ctx, e.id, e.ok);
          if (!nested) {
            this.resolveToolCard(ctx, e.id, e.ok, e.output);
            this.linkBackgroundResult(ctx, e.id, e.output);
            this.markTaskDone(ctx, e.id); // Task's own result → mark section done
            // A subagent finished → drop it from the running count (delete returns
            // true only when it was a tracked Task, so plain tools don't refresh).
            if (ctx.runningTasks.delete(e.id)) this.refreshAgentIndicators();
          }
          const wp = ctx.writeById.get(e.id);
          // Reveal only while Mario is actually watching THIS chat: the convo is
          // active and the Exo view itself is visible. Writes from a background
          // conversation (or behind a hidden tab) must never hijack the workspace —
          // same guard the live context panel uses above. Not adding to `revealed`
          // on the skipped path keeps a later same-turn write eligible if he
          // switches back.
          if (
            e.ok &&
            wp &&
            this.plugin.settings.revealEditedNotes &&
            !ctx.revealed.has(wp) &&
            c === this.active &&
            this.containerEl.isShown()
          ) {
            ctx.revealed.add(wp);
            this.revealNote(wp);
          }
          // Live preview card: HTML artifacts (any write) + newly-created markdown
          // notes. Dedup per turn on the first successful write of that path.
          if (e.ok && wp) {
            const rel = this.relPath(wp);
            const lower = rel.toLowerCase();
            const isHtml = lower.endsWith(".html") || lower.endsWith(".htm");
            const isNewMd = lower.endsWith(".md") && ctx.createdPaths.has(rel);
            if ((isHtml || isNewMd) && !ctx.artifacts.has(rel)) {
              ctx.artifacts.add(rel);
              this.renderArtifactCard(ctx, rel);
            }
          }
          // The text segment (if any) ended before this tool ran — re-show the
          // working row while the agent decides what to do next.
          this.setWorkingLabel(ctx, "Thinking…");
          this.syncWorking(ctx);
          // The tool resolved: drop the live current row and fold the now-resolved
          // segment into the accumulated Context sections.
          if (c === this.active && this.isWideMain()) {
            this.currentActivity = null;
            this.updateContextLive(ctx);
          }
          break;
        }
        case "permission-request": {
          // ask_user is a user interaction, not a gated action — never card it.
          // Both names: the built-in AskUserQuestion is aliased to the MCP tool,
          // but the permission request may carry either name.
          if (e.tool === "mcp__obsidian__ask_user" || e.tool === "AskUserQuestion") {
            e.resolve({ behavior: "allow" });
            break;
          }
          if (
            researchMode.enabled
            && e.tool.startsWith("mcp__")
            && !e.tool.startsWith("mcp__obsidian__")
            && !isReadOnlyExternalTool(e.tool)
          ) {
            this.diag.push("research", `${e.tool} → external-write-deny`);
            e.resolve({
              behavior: "deny",
              message: "Research Mode allows read-only external MCP tools only.",
            });
            break;
          }
          // ExitPlanMode → the dedicated plan-approval card (the thing to review),
          // not the generic permission card. openCard makes the card the feedback;
          // closeCard on any exit brings the working row back.
          if (e.tool === "ExitPlanMode") {
            this.diag.push("perm", "ExitPlanMode → plan card");
            this.openCard(ctx); // the plan card is the feedback while it waits
            this.notifyOnce(ctx, "waiting", "Exo — plan ready", "The agent proposed a plan for your review.");
            void this.renderPlanCard(ctx, c, e.input, (d) => {
              this.closeCard(ctx); // the turn continues once resolved
              e.resolve(d);
            }).catch(() => {
              // Card failed to render — release the slot (working row returns) and
              // unblock the SDK so the turn can't park on an unresolved permission.
              this.closeCard(ctx);
              e.resolve({ behavior: "deny", message: "Exo couldn't render the plan card." });
            });
            break;
          }
          const isRead = READ_ONLY_TOOLS.has(e.tool) || OBSIDIAN_READ_TOOLS.has(e.tool);
          const fp = toolFilePath(e.tool, e.input);
          // Single source of truth for write-tool classification (WRITE_TOOLS) so
          // checkpointing, touched-footer, and rules can never disagree.
          const isWrite = !!fp && WRITE_TOOLS.test(e.tool);
          // Snapshot the target file (pre-edit) before letting a write proceed.
          const allow = (d: { behavior: "allow"; remember?: boolean }) => {
            if (isWrite && fp) {
              void this.snapshot(checkpoint, fp).then(
                () => e.resolve(d),
                () => e.resolve({ behavior: "deny", message: "Exo couldn't snapshot the target file; write denied." })
              );
            }
            else e.resolve(d);
          };
          const argText = permArgText(e.tool, e.input);
          const outcome = decidePermission({
            tool: e.tool,
            argText,
            isRead,
            isMemoryTool: OBSIDIAN_MEMORY_TOOLS.has(e.tool),
            alreadyAllowed: c.allow.has(allowKey(e.tool, e.input)),
            autoAllowRead: s.autoAllowRead,
            memoryWriteEnabled: s.memoryWriteEnabled,
            permDenyRules: s.permDenyRules,
            permAllowRules: s.permAllowRules,
          });
          switch (outcome) {
            case "deny-rule":
              this.diag.push("perm", `${e.tool} → rule-deny`);
              e.resolve({ behavior: "deny", message: "Denied by an Exo permission rule (settings)." });
              break;
            case "auto-allow":
              this.diag.push("perm", `${e.tool} → auto-allow`);
              allow({ behavior: "allow" });
              break;
            case "memory-deny":
              this.diag.push("perm", `${e.tool} → memory-deny`);
              e.resolve({ behavior: "deny", message: "Memory writing is disabled in Exo settings." });
              break;
            case "card":
              this.diag.push("perm", `${e.tool} → card`);
              this.openCard(ctx); // the card waiting for the user is the feedback
              this.notifyOnce(
                ctx,
                "waiting",
                "Exo — waiting for you",
                "The agent asked a question / needs permission."
              );
              this.addPermissionCard(ctx, c, e.tool, e.input, (d) => {
                this.closeCard(ctx); // the turn continues once resolved
                if (d.behavior === "allow") allow(d);
                else e.resolve(d);
              });
              break;
          }
          break;
        }
        case "usage":
          // Arrives after turn-end (async control round-trip), so the turn's own
          // persist() has already run — persist again so a restart keeps it.
          c.usage = e.usage;
          this.persist();
          if (c === this.active) this.composer.updateUsage(e.usage);
          break;
        case "rate-limit":
          // The badge is a single view-level control, so only the active convo's
          // quota drives it. Late reads (tab switch) come from session.rateLimit.
          this.plugin.lastRateLimit = { status: e.status, utilization: e.utilization, resetsAt: e.resetsAt, windowType: e.windowType };
          if (c === this.active) {
            this.composer.setLastRateLimit({
              status: e.status,
              utilization: e.utilization,
              resetsAt: e.resetsAt,
              windowType: e.windowType,
            });
            this.composer.updateRateBadge();
          }
          break;
        case "compact": {
          this.diag.push("turn", "compact boundary");
          const div = c.listEl.createDiv({ cls: "mva-compact-divider" });
          setIcon(div.createSpan({ cls: "mva-compact-icon" }), "scissors");
          div.createSpan({ text: "Context compacted" });
          this.scrollConvo(c);
          break;
        }
        case "turn-end":
          this.diag.push("turn", `result session=${e.sessionId ? e.sessionId.slice(0, 8) : "?"}`);
          if (e.sessionId) c.sessionId = e.sessionId;
          break;
        case "error":
          this.diag.push("error", e.message);
          this.dropThinking(ctx);
          this.resetTextStream(ctx);
          // Every path through this handler is a non-clean finish (user-stopped
          // or an in-band execution error that will be marked `poisoned` below).
          this.closeStepsRun(ctx, true);
          this.removeWorking(ctx);
          if (c.stopped) {
            // User pressed Stop — the provider reports an execution error as it
            // unwinds; render it as a clean stop, not a scary error.
            ctx.el.addClass("mva-aborted");
            if (!ctx.fullText && ctx.cards.size === 0) {
              ctx.bodyEl.createSpan({ cls: "mva-faint", text: "Stopped." });
            }
          } else {
            // An execution error crashes the CLI process — reusing the live
            // session re-errors forever, so the turn end (below) drops it. But the
            // on-disk transcript survives and a fresh process can resume it, so we
            // recover in two stages. The footer reflects which stage this is.
            poisoned = true;
            if (this.renderError(ctx, e.message, c, text).showRecoveryFooter) {
              ctx.bodyEl.createSpan({ cls: "mva-faint", text: this.recoveryFooter(c, !!opts?.isRecoveryRetry) });
            }
            this.notifyOnce(ctx, "error", "Exo — error", e.message.slice(0, 80));
          }
          break;
      }
    };

    try {
      const session = await this.ensureSession(c);
      turnCaps = session.caps ?? turnCaps;
      // sendPrefix (recovery recap) and the proactive-recall block are prepended to
      // the OUTBOUND provider message only — never to the rendered/persisted user
      // text, so they can't leak into the transcript, c.messages, or serialize().
      // Order: recap (if any) -> recalled memory -> research contract -> the
      // user's message.
      const recallBlock = recalled.length ? this.formatRecallBlock(recalled) : "";
      // Cold-spawn rehydration: a session spawned with no id starts on an EMPTY CLI
      // transcript, so a "continua/riprendi" has nothing to continue — the model
      // forages the vault (session-log, open-items) to reconstruct "which
      // conversation" instead of reading THIS thread. Whenever we spawn cold but the
      // convo already carries real history, reseed it with the same recap the
      // stage-2 recovery uses. This generalizes that narrow path to close every
      // cold-start hole (poisoned-and-stopped, nuclear reset, fresh process after a
      // crash) with one invariant. Skipped when a stage-2 recap prefix is already
      // present (never double) and on a convo's first turn (no prior message).
      const coldRecap = shouldColdReseed({
        hasSessionId: !!c.sessionId,
        hasRecapPrefix: !!opts?.sendPrefix,
        // The current user turn is already persisted before this send starts.
        hasPriorHistory: c.messages.length > 1,
      })
        ? buildRecap(c.messages)
        : "";
      if (coldRecap) this.diag.push("recall", "cold-spawn recap injected");
      // Codex compact emulation: the user's compaction focus rides the next
      // turn once (the recap itself comes from coldRecap above).
      const compactPrefix = c.pendingSendPrefix;
      if (compactPrefix) c.pendingSendPrefix = undefined;
      const researchMessage = buildResearchOutbound(researchMode, message);
      const outbound = [opts?.sendPrefix, coldRecap, compactPrefix, recallBlock, researchMessage].filter(Boolean).join("\n\n");
      await session.send(outbound, onEvent, imgs);
      // `session.send` can resolve cleanly even after a user Stop/Esc — the
      // adapter swallows the abort rather than throwing or emitting an
      // in-band "error" event, so `c.stopped` (set synchronously by stop())
      // is the only signal here that this wasn't a clean finish.
      this.flushRender(ctx, c.stopped);
      await Promise.all(snapshots); // ensure every pre-write snapshot landed before we read the checkpoint
      // Touched-notes footer renders collapsed by default (03-07 feedback), so
      // there's nothing to fold on older turns — every footer is already a quiet
      // "N files" toggle that opens on click.
      this.attachTouched(ctx.el, ctx.touched, checkpoint);
      // The footer above now carries every note this turn touched — drop the
      // matching live tool-call rows so the same file isn't shown twice (the
      // #1 finding of the 2026-07-03 impeccable critique on this surface).
      // Rows living inside a (folded) steps run dissolve through it, so its
      // count re-labels and an emptied run disappears entirely.
      for (const id of ctx.noteTouchIds) {
        const card = ctx.cards.get(id)?.card;
        if (!card) continue;
        const run = ctx.runById.get(id);
        if (run) run.dissolve(card);
        else card.remove();
      }
      if (ctx.fullText.trim()) {
        this.attachActions(ctx.el, ctx.fullText, text, c);
        // Turn duration (Feature 2): live-only, only when it's worth showing.
        // Always visible (completion feedback, CC's "Crunched for 2m 49s") — a
        // sibling AFTER the hover-gated actions bar, never inside it.
        const elapsed = Date.now() - turnStart;
        if (elapsed > 5000) {
          ctx.el
            .createDiv({ cls: "mva-turn-meta" })
            .createSpan({ cls: "mva-turn-duration", text: `✻ ${this.fmtDuration(elapsed)}` });
        }
        if (!c.stopped && !poisoned) {
          // Workflow Foundry records only privacy-safe deterministic metadata.
          // Proposal/distillation remains a later stage and never delays this turn.
          this.maybeRecordWorkflowSignal(ctx, c, !!opts?.isRecoveryRetry);
          // Legacy recurrence nudge remains until P4-T03 routes Foundry candidates
          // through the Proposal Kernel.
          this.maybeProposePlaybook(ctx, c, elapsed);
        }
      }
      // Turn finished normally (Feature 3): notify if it ran long and the window
      // is backgrounded. `poisoned` covers an in-band error already handled above.
      if (!c.stopped && !poisoned && Date.now() - turnStart > 10000) {
        const preview = ctx.fullText.trim().slice(0, 80) || "The agent finished working.";
        this.notifyOnce(ctx, "done", "Exo — turn finished", preview);
      }
    } catch (err) {
      // Reaching this catch at all means the turn didn't finish cleanly (abort,
      // user-stop, or a thrown session error) — fold the run with the x glyph.
      this.flushRender(ctx, true);
      this.dropSession(c); // a failed turn likely poisoned the session
      // `c.stopped` = the user asked for this (Stop/Esc, possibly the force-
      // dispose escalation whose "Session disposed." rejection is not an
      // AbortError) — render it as a clean stop, never a scary error.
      if (isAbort(err) || c.stopped) {
        ctx.el.addClass("mva-aborted");
        if (!ctx.fullText && ctx.cards.size === 0) {
          ctx.bodyEl.createSpan({ cls: "mva-faint", text: "Stopped." });
        }
      } else {
        this.dropThinking(ctx);
        const msg = describeError(err, adapter.displayName);
        if (isRecoverableSessionError(msg) && !c.stopped) {
          // A thrown session-death error (session expired/not found, "process
          // exited with code …", a failed resume) is the same failure class as an
          // in-band error_during_execution — route it into the SAME two-stage
          // recovery instead of surfacing a generic error. Mark poisoned so the
          // finally keeps c.sessionId and sets resumeRisky (stage 1); it does NOT
          // auto-retry here — that's stage 2's job on the next poisoned turn.
          poisoned = true;
          if (this.renderError(ctx, msg, c, text).showRecoveryFooter) {
            ctx.bodyEl.createSpan({ cls: "mva-faint", text: this.recoveryFooter(c, !!opts?.isRecoveryRetry) });
          }
          this.notifyOnce(ctx, "error", "Exo — error", msg.slice(0, 80));
        } else {
          this.renderError(ctx, msg, c, text);
          new Notice(msg);
          this.notifyOnce(ctx, "error", "Exo — error", msg.slice(0, 80));
          // Don't replay queued messages into a broken session — they'd just re-fail.
          if (c.queue.length) {
            c.queue = [];
            this.renderQueue(c);
          }
        }
      }
    } finally {
      this.diag.push(
        "turn",
        `end ${Math.round((Date.now() - turnStart) / 1000)}s stopped=${c.stopped} poisoned=${poisoned}`
      );
      window.clearInterval(workingTimer); // stop the elapsed ticker
      this.removeWorking(ctx); // drop the working row for good
      // Force-settle any tool card still 'running' when the turn ended abnormally
      // (interrupt/error before its result arrived). Otherwise its type icon keeps
      // CSS-pulsing forever and its elapsed freezes mid-tick — a row stuck
      // "processing" inside a run whose header already reads done/failed. No-op on
      // a clean turn: every card is already settled by its tool-result.
      for (const card of ctx.cards.values()) {
        if (card.card.hasClass("is-running")) this.finishToolCard(card, false, "");
      }
      await Promise.all(snapshots); // finalize the checkpoint even if the turn errored
      // Git auto-commit safety net: hand off the count of files this turn wrote
      // (however it ended — success, error, or user-stopped) so the plugin can
      // schedule a debounced commit. Synchronous and cheap — never awaited, never
      // on the turn's critical path; the plugin no-ops entirely when the setting
      // is off.
      const writtenPaths = ctx.touched.filter((t) => t.kind === "write").map((t) => t.path);
      if (writtenPaths.length > 0) this.plugin.noteVaultWrite(writtenPaths);
      // If the turn died with an interactive card still open (session crash while a
      // permission/ask was pending), CANCEL it — otherwise the card stays live in
      // the transcript and the in-process ask promise hangs forever. No-op on clean
      // turns (both are null once answered) and idempotent (done-guarded).
      const endedWithPendingInteraction = !!c.pendingPerm || !!c.pendingAsk || ctx.openCards > 0;
      c.pendingPerm?.();
      c.pendingPerm = null;
      c.pendingAsk?.();
      c.pendingAsk = null;
      c.currentCtx = null; // this turn is over — late ask_user calls reject cleanly
      // Confirm a user-initiated stop — ALWAYS, even mid-work. A turn that had
      // already streamed text/tool cards used to end with zero feedback when
      // stopped (guarded on "nothing rendered"), which read as "Exo è bloccato":
      // the user couldn't tell an aborted turn from one still thinking.
      if (c.stopped && !ctx.el.querySelector(".mva-faint, .mva-inline-error, .mva-onboard")) {
        ctx.el.addClass("mva-aborted");
        ctx.bodyEl.createSpan({ cls: "mva-faint", text: "Stopped." });
      }
      const researchReceipt = ctx.segments.length && researchMode.enabled
        ? buildResearchReceipt({
            state: researchMode,
            completedAt: Date.now(),
            availability: {
              vault: s.toolsEnabled,
              web: c.provider === "claude" && s.toolsEnabled,
              mcpServers: (turnCaps?.mcpServers ?? []).filter((server) =>
                server.name.toLowerCase() !== "obsidian"
              ),
            },
            tools: ctx.segments.flatMap((segment) =>
              segment.t === "tool"
                ? [{ name: segment.name, input: segment.input, ok: segment.ok }]
                : []
            ),
          })
        : undefined;
      if (ctx.segments.length) {
        c.messages.push({
          role: "assistant",
          segments: ctx.segments,
          ...(checkpoint.size ? { checkpoint } : {}),
          ...(researchReceipt ? { researchReceipt } : {}),
        });
      }
      if (researchReceipt && ctx.fullText.trim()) {
        this.attachResearchDossierAction(ctx.el, text, ctx.fullText, researchReceipt);
      }
      // Turn finalized — the live activity row is gone; refresh the conversation
      // recap (full-page rail only) as the idle post-hoc summary.
      this.currentActivity = null;
      if (c === this.active) this.updateRecap();
      // Background shells can outlive the turn (Exo can't poll them) — note them
      // honestly as "started this turn" rather than claiming a live running count.
      if (ctx.bgTasks.size) {
        const n = ctx.bgTasks.size;
        ctx.el.createDiv({
          cls: "mva-faint mva-bg-foot",
          text: `${n} background task${n > 1 ? "s" : ""} started this turn`,
        });
      }
      c.updatedAt = Date.now();
      // Two-stage session recovery (Claude-Code-style resume). The pure reducer
      // decides the session action + flags from the turn's state so this ladder,
      // the error-render footers, and recoveryFooter can never drift apart. A
      // poisoned live session re-errors if reused, so we drop it — but the on-disk
      // transcript can be resumed by a fresh process, so stage 1 keeps the sessionId.
      const plan = resolveRecovery({
        poisoned,
        stopped: c.stopped,
        isRecoveryRetry: !!opts?.isRecoveryRetry,
        resumeRisky: !!c.resumeRisky,
      });
      if (plan.session !== "none") this.dropSession(c);
      if (plan.session === "drop-clear-id") c.sessionId = undefined;
      c.resumeRisky = plan.nextResumeRisky;
      // First assistant turn just landed → refine the auto-derived tab title with a
      // Haiku-generated one (fire-and-forget, once per conversation). Placed AFTER the
      // recovery ladder so a recoverable-but-poisoned first turn (which triggers
      // dropSession → aborts titleAbort) still gets titled — the exchange is valid.
      // Gated to exactly one user + one assistant message so a user-renamed or later
      // turn can never be overwritten; the placeholder stays if the call fails.
      if (
        this.plugin.settings.aiTitles &&
        !c.titledByAi &&
        c.messages.length === 2 &&
        c.messages[0].role === "user" &&
        c.messages[1].role === "assistant" &&
        ctx.fullText.trim()
      ) {
        c.titledByAi = true; // fire once, even if the call later fails
        this.aiTitle(c, ctx.userText, ctx.fullText);
      }
      // Self-Writing Memory: observe HEALTHY turns only (not poisoned/errored, not
      // stopped). Fires off the critical path — never delays the next user turn.
      if (!poisoned && !c.stopped && ctx.fullText.trim()) {
        this.observeTurnEnd(c, ctx);
      }
      if (plan.enqueueRecapRetry) {
        // Stage 2: auto-retry the SAME user message once with a private recap
        // threaded to the provider only (never rendered, queued as a chip, or
        // persisted). Route via the queue FIRST so it can't race queued messages.
        const recap = buildRecap(c.messages);
        c.queue.unshift({
          text,
          images,
          sendPrefix: recap,
          isRecoveryRetry: true,
          researchMode,
        });
      }
      this.emitTurnTerminal(c, poisoned); // fire-and-forget board hook (no-op when off; can't throw)
      this.setStreaming(c, false);
      this.persist();
      // Proposal producer: the main response is already rendered and persisted.
      // Fire-and-forget so extraction can never delay the turn result or queue.
      void this.plugin.produceProposalsAfterTurn({
        successful: !poisoned && !c.stopped && !plan.enqueueRecapRetry,
        responseIsSubstantial: ctx.fullText.trim().length >= 80,
        responseHasError: ctx.segments.some((segment) => segment.t === "error"),
        hasPendingInteraction: endedWithPendingInteraction,
        stopped: c.stopped,
        poisoned,
        recoveryIncomplete: plan.nextResumeRisky || plan.enqueueRecapRetry,
        administrativeSlashCommand: /^\/(?!btw(?:\s|$))/i.test(ctx.userText.trim()),
        userText: ctx.userText,
        responseText: ctx.fullText,
        source: { convoId: c.id, turnId: String(turnStart), createdAt: turnStart },
      }).then((result) => {
        if (result.status !== "generated" || result.appended < 1 || !ctx.el.isConnected) return;
        const summary = ctx.el.createEl("button", {
          cls: "mva-proposal-summary",
          attr: { type: "button", "aria-label": "Review suggestions" },
        });
        setIcon(summary.createSpan({ cls: "mva-proposal-summary-icon" }), "lightbulb");
        summary.createSpan({
          text: `${result.appended} suggestion${result.appended === 1 ? "" : "s"}`,
        });
        summary.onclick = () => void this.plugin.openProposalsModal();
      }).catch((error) => {
        console.warn("[Exo] proposal producer failed after turn (no-op):", error);
      });
      this.scrollConvo(c);
      // Drain the queue: run the next message in this conversation. A recovery
      // retry item carries sendPrefix/isRecoveryRetry — forward them so the recap
      // reaches the provider and no duplicate user bubble is rendered.
      if (c.queue.length) {
        const next = c.queue.shift()!;
        this.renderQueue(c);
        const retryOpts =
          next.isRecoveryRetry || next.sendPrefix || next.researchMode
            ? {
                sendPrefix: next.sendPrefix,
                isRecoveryRetry: next.isRecoveryRetry,
                researchMode: next.researchMode,
              }
            : undefined;
        void this.runTurn(c, next.text, next.images, retryOpts);
      } else {
        // Turn (and any queue) is fully settled — safe to surface related notes again.
        this.renderTailSurfacing(c);
        // Warm session after Esc: a user stop dropped the (possibly mid-tool) live
        // session, so respawn+resume its transcript in the background right now.
        // The next message is warm instead of paying respawn+resume. Only for the
        // active convo (prewarm targets it) with nothing queued behind the stop.
        if (c.stopped && c === this.active) this.prewarm();
      }
    }
  }

  /** Recovery footer text for a poisoned/recoverable turn — reflects which stage
   *  of the two-stage session recovery this failure sits at. Both call sites (the
   *  in-band error event and the thrown-error catch path) render this only when
   *  the turn is poisoned and NOT stopped, so those inputs are fixed here; the
   *  footer text is single-sourced in the recovery reducer. */
  private recoveryFooter(c: Convo, isRecoveryRetry: boolean): string {
    return (
      resolveRecovery({ poisoned: true, stopped: false, isRecoveryRetry, resumeRisky: !!c.resumeRisky }).footer ??
      ""
    );
  }

  /** Persist and render a terminal turn failure. The retry reuses the existing
   *  user bubble, so an interrupted response never duplicates Mario's prompt. */
  private renderError(ctx: AssistantCtx, message: string, c: Convo, retryText: string) {
    // Some providers report one failure through multiple events (structured
    // error + process close). Persist and render the first one only: otherwise a
    // single interruption grows into repeated warning rows and retry buttons.
    const decision = recordTurnError(ctx.segments, message);
    if (decision.showErrorCard) this.renderErrorBody(ctx.bodyEl, message, c, retryText);
    return decision;
  }

  /** Rehydrate a persisted failure with the same retry affordance shown live. */
  private renderPersistedError(body: HTMLElement, message: string, c: Convo, retryText: string): void {
    this.renderErrorBody(body, message, c, retryText);
  }

  /** Inline error, upgraded to a setup card when the CLI isn't ready. */
  private renderErrorBody(body: HTMLElement, message: string, c: Convo, retryText: string): void {
    let actionHost: HTMLElement;
    if (/not found|not logged in|sign in|run it once/i.test(message)) {
      const card = body.createDiv({ cls: "mva-onboard" });
      setIcon(card.createDiv({ cls: "mva-onboard-icon" }), "plug-zap");
      card.createDiv({ cls: "mva-onboard-title", text: `${ADAPTERS[c.provider].displayName} isn't ready` });
      card.createDiv({ cls: "mva-onboard-msg", text: message });
      const steps = card.createEl("ol", { cls: "mva-onboard-steps" });
      steps.createEl("li", { text: `Open a terminal and run \`${c.provider}\` once to sign in.` });
      steps.createEl("li", { text: "If it's installed elsewhere, set the binary path in settings." });
      const btn = card.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Open settings" });
      btn.onclick = () => this.openSettings();
      actionHost = card;
    } else {
      // Keep failures visible without turning them into a dominant red card. The
      // compact row carries the human-readable state + retry; raw diagnostics stay
      // available behind a disclosure for the rare case they are needed.
      const friendly = describeCliFailure(message);
      const box = body.createDiv({ cls: "mva-inline-error" });
      const row = box.createDiv({ cls: "mva-error-row" });
      setIcon(row.createSpan({ cls: "mva-error-icon" }), "triangle-alert");
      const copy = row.createDiv({ cls: "mva-error-copy" });
      copy.createDiv({ cls: "mva-error-title", text: "Response interrupted" });
      copy.createDiv({
        cls: "mva-error-summary",
        text: friendly?.message ?? (message.length > 120 ? `${message.slice(0, 120)}…` : message),
      });
      actionHost = row;

      const detailText = [friendly?.hint, message].filter(Boolean).join("\n\n");
      const details = box.createEl("details", { cls: "mva-error-details" });
      details.createEl("summary", { text: "Details" });
      details.createDiv({ text: detailText });
    }

    if (!retryText) return;
    const retry = actionHost.createEl("button", { cls: "mva-error-retry", attr: { "aria-label": "Retry response" } });
    setIcon(retry.createSpan(), "refresh-cw");
    retry.createSpan({ text: "Retry" });
    let retrying = false;
    retry.onclick = () => {
      if (retrying || c.streaming) return;
      retrying = true;
      retry.disabled = true;
      void this.runTurn(c, retryText, undefined, { reuseUserTurn: true });
    };
  }

  private openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById("exo");
  }

  /* ------------------------- learning loop ------------------------- */

  private maybeRecordWorkflowSignal(ctx: AssistantCtx, c: Convo, recoveryRetry: boolean): void {
    if (!this.plugin.settings.learningLoop) return;
    const tools = ctx.segments.filter((segment): segment is Extract<Segment, { t: "tool" }> =>
      segment.t === "tool"
    );
    const toolNames = tools.map((tool) => tool.name);
    const hasArtifact = ctx.segments.some((segment) => segment.t === "artifact");
    const hasVaultWrite = tools.some((tool) => WRITE_TOOLS.test(tool.name));
    const structuredOutput = hasArtifact
      || hasVaultWrite
      || /(?:^|\n)(?:#{1,3}\s|\|.+\||```(?:json|csv)|[-*]\s+\[[ xX]\])/m.test(ctx.fullText);
    const outputType: WorkflowOutputType = hasArtifact
      ? "artifact"
      : hasVaultWrite
        ? "vault-write"
        : structuredOutput
          ? "structured"
          : /(?:^|\n)(?:#{1,3}\s|[-*]\s|\d+\.\s)/m.test(ctx.fullText)
            ? "markdown"
            : "message";
    const sensitive = tools.some((tool) =>
      tool.name === "Bash"
      || tool.name === "Shell"
      || WRITE_TOOLS.test(tool.name)
      || (
        tool.name.startsWith("mcp__")
        && !tool.name.startsWith("mcp__obsidian__")
        && !isReadOnlyExternalTool(tool.name)
      )
    );
    const eligibility = evaluateWorkflowEligibility({
      succeeded: true,
      stopped: c.stopped,
      errored: false,
      recoveryRetry,
      sideThread: /^\/btw(?:\s|$)/i.test(ctx.userText.trim()),
      playbookRun: ctx.userText.trim().startsWith("/"),
      sensitive,
      assistantChars: ctx.fullText.trim().length,
      toolNames,
      structuredOutput,
    });
    if (!eligibility.eligible) {
      this.diag.push("foundry", `signal skipped: ${eligibility.reason}`);
      return;
    }
    const now = Date.now();
    const signal = createWorkflowSignal({
      userText: ctx.userText,
      tools,
      outputType,
      createdAt: now,
      convoId: c.id,
      turnId: ctx.turnId,
      succeeded: true,
    });
    const threshold = Math.max(2, this.plugin.settings.playbookThreshold ?? 3);
    void this.plugin.workflowSignalStore.record(signal, now, { threshold }).then((result) => {
      this.diag.push(
        "foundry",
        result.candidate ? `threshold reached: ${result.candidate.occurrences}` : "signal recorded"
      );
    }).catch((error) => {
      console.warn("[Exo] workflow signal persistence failed (no-op):", error);
    });
  }

  /** After a substantial healthy turn, offer to save the flow as a reusable
   *  playbook (Hermes pattern). One-shot per conversation; free until accepted. */
  private maybeProposePlaybook(ctx: AssistantCtx, c: Convo, durationMs: number): void {
    if (!this.plugin.settings.learningLoop || c.playbookNudged) return;
    const tools = ctx.segments.filter((s): s is Extract<Segment, { t: "tool" }> => s.t === "tool");
    // Gate: fingerprint only substantial, healthy turns (not one-shot lookups,
    // not slash-command runs). Whether to actually PROPOSE is decided by topic
    // recurrence across turns — not by this single turn being "big".
    const qualifies = turnQualifies({
      ok: true,
      toolCount: tools.length,
      distinctTools: new Set(tools.map((t) => t.name)).size,
      durationMs,
      userText: ctx.userText,
    });
    if (!qualifies) return;
    c.playbookNudged = true;
    void this.recordAndMaybePropose(ctx);
  }

  /** Fold this turn into the topic-recurrence ledger and show the "save as
   *  playbook?" card only when a topic has recurred to the threshold. Ledger I/O
   *  is best-effort — a failure never breaks the turn. */
  private async recordAndMaybePropose(ctx: AssistantCtx): Promise<void> {
    const threshold = Math.max(2, this.plugin.settings.playbookThreshold ?? 3);
    try {
      const ledger = await loadSignalLedger(this.plugin.app);
      const { ledger: next, proposal } = recordTurnSignal(ledger, ctx.userText, Date.now(), { threshold });
      await saveSignalLedger(this.plugin.app, next);
      if (proposal) this.renderPlaybookNudge(ctx, proposal);
    } catch {
      /* ledger unavailable — skip the nudge silently, never break the turn */
    }
  }

  /** The recurrence nudge: "you've done this N times — save it as a playbook?"
   *  The free preview shows the recurring topic and the real example requests,
   *  not a transcript of one run. Save still distills + shows a review card. */
  private renderPlaybookNudge(ctx: AssistantCtx, proposal: PlaybookSignal): void {
    const card = ctx.el.createDiv({ cls: "mva-ll" });
    const head = card.createDiv({ cls: "mva-ll-head" });
    setIcon(head.createSpan({ cls: "mva-ll-icon" }), "sparkles");
    const label = head.createSpan({
      cls: "mva-ll-label",
      text: `L'hai fatto ${proposal.count} volte — salvarlo come playbook?`,
    });
    const chev = head.createSpan({ cls: "mva-ll-chev", attr: { "aria-label": "Cosa catturerebbe" } });
    setIcon(chev, "chevron-down");
    const save = head.createSpan({ cls: "mva-ll-btn", text: "Salva" });
    const dismiss = head.createSpan({ cls: "mva-ll-x", attr: { "aria-label": "Dismiss" } });
    setIcon(dismiss, "x");
    let previewEl: HTMLElement | null = null;
    const togglePreview = () => {
      if (previewEl) {
        previewEl.remove();
        previewEl = null;
        setIcon(chev, "chevron-down");
        return;
      }
      setIcon(chev, "chevron-up");
      previewEl = card.createDiv({ cls: "mva-ll-preview" });
      const examples = proposal.examples
        .map((e) => `• «${e.slice(0, 160)}${e.length > 160 ? "…" : ""}»`)
        .join("\n");
      previewEl.setText(
        `Tema ricorrente: ${signalLabel(proposal)}\n\nHai chiesto cose simili:\n${examples}` +
          `\n\nSalva → distillo un playbook riusabile e ti mostro nome e testo per conferma prima di salvarlo.`
      );
    };
    this.clickable(label, togglePreview);
    this.clickable(chev, togglePreview);
    this.clickable(save, () => void this.distillPlaybook(ctx, card));
    this.clickable(dismiss, () => card.remove());
  }

  /** Accepted: run the distillation on a transient utility session and show
   *  the extracted playbook for review — it is saved only on confirm. Soft
   *  failure — the card says so, nothing else changes. */
  private async distillPlaybook(ctx: AssistantCtx, card: HTMLElement): Promise<void> {
    card.empty();
    setIcon(card.createSpan({ cls: "mva-ll-icon is-working" }), "sparkles");
    card.createSpan({ cls: "mva-ll-label", text: "Distillo il playbook…" });
    const toolLines = ctx.segments
      .filter((s): s is Extract<Segment, { t: "tool" }> => s.t === "tool")
      .slice(0, 30)
      .map((t) => {
        const m = toolMeta(t.name, t.input);
        return `${m.label}${m.target ? `: ${m.target}` : ""}`;
      });
    const prompt = buildDistillPrompt({ userText: ctx.userText, toolLines, finalText: ctx.fullText });
    const ctrl = new AbortController();
    const raw = await this.plugin.runUtilityPass(prompt, { signal: ctrl.signal, timeoutMs: 90_000 });
    const parsed = parseDistillReply(raw);
    card.empty();
    if (!parsed) {
      setIcon(card.createSpan({ cls: "mva-ll-icon" }), "circle-alert");
      card.createSpan({ cls: "mva-ll-label", text: "Distillazione non riuscita — riprova più tardi." });
      window.setTimeout(() => card.remove(), 6000);
      return;
    }
    this.renderPlaybookReview(card, parsed);
  }

  /** Review step: the card shows exactly what got distilled (name + prompt)
   *  so the user knows what they are saving. Salva commits, X discards. */
  private renderPlaybookReview(card: HTMLElement, parsed: { name: string; prompt: string }): void {
    card.addClass("is-review");
    const head = card.createDiv({ cls: "mva-ll-head" });
    setIcon(head.createSpan({ cls: "mva-ll-icon" }), "sparkles");
    head.createSpan({ cls: "mva-ll-label", text: `Playbook estratto — "${parsed.name}"` });
    const save = head.createSpan({ cls: "mva-ll-btn", text: "Salva" });
    const dismiss = head.createSpan({ cls: "mva-ll-x", attr: { "aria-label": "Dismiss" } });
    setIcon(dismiss, "x");
    card.createDiv({ cls: "mva-ll-preview", text: parsed.prompt });
    this.clickable(save, () => void this.savePlaybook(card, parsed));
    this.clickable(dismiss, () => card.remove());
  }

  /** Confirmed: dedup the name against existing playbooks and persist. */
  private async savePlaybook(card: HTMLElement, parsed: { name: string; prompt: string }): Promise<void> {
    const s = this.plugin.settings;
    const name = uniquePlaybookName(parsed.name, (s.customPrompts ?? []).map((p) => p.name));
    s.customPrompts.push({ name, prompt: parsed.prompt });
    await this.plugin.saveSettings();
    card.empty();
    card.removeClass("is-review");
    setIcon(card.createSpan({ cls: "mva-ll-icon is-ok" }), "check");
    card.createSpan({ cls: "mva-ll-label", text: `Salvato: "${name}" — lo trovi nel menu / (modificabile in settings).` });
  }

  /** Live attention snapshot for the Cockpit: conversations blocked on a
   *  permission/ask card, or currently streaming. Plain data — no DOM refs. */
  convoAttention(): { id: string; title: string; blocked: boolean; streaming: boolean }[] {
    const all = this.convos.includes(this.active) ? this.convos : [...this.convos, this.active];
    return all
      .map((c) => ({
        id: c.id,
        title: c.title,
        blocked: !!(c.pendingPerm || c.pendingAsk),
        streaming: c.streaming,
      }))
      .filter((c) => c.blocked || c.streaming);
  }

  /** Open a conversation by id (Cockpit "Resume" rows). False when unknown. */
  openConvoById(id: string): boolean {
    const c = this.convos.find((x) => x.id === id);
    if (!c) return false;
    if (this.galleryEl) this.hideGallery();
    this.hideCapabilities();
    this.switchTo(c);
    return true;
  }

  private vaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    return "";
  }
}
