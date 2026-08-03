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
  Menu,
  debounce,
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
import { RecapPanel } from "./ui/recap";
import { buildRecap as buildConvoRecap } from "./core/recap";
import { assembleContext, formatContextDebug } from "./core/context-assembly";
import type { SessionSnapshot, SessionLane } from "./core/session-cards";
import { describeActivity } from "./core/activity";
import { clickable } from "./ui/dom";
import { StepsRun } from "./ui/steps";
import { firstErrorLine, stepPlacement, isSubagentTool, shouldFoldStepsRun } from "./core/steps";
import { hoistSlashCommand } from "./core/slash";
import type { GoalState } from "./core/goal-loop";
import { setGoal, clearGoal, advance, resumeGoal, buildContinuationPrompt } from "./core/goal-loop";
import { applyWorkflowProgress, createWorkflowRun, summarizeWorkflowRun, type WorkflowRun } from "./core/workflow-progress";
import {
  summarizeLiveTasks,
  liveTaskDotClass,
  liveTaskStatusText,
  fadedTaskIds,
  type LiveTask,
  type LiveTaskStatus,
} from "./core/live-tasks";
import { Composer, type ComposerDraft } from "./ui/composer";
import { renderEmptyState } from "./ui/empty-state";
import { isVaultSetUp, memorySetupNeeded } from "./core/vault-setup";
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
import { partitionConvos } from "./core/persistence";
import { planRetention, pinnedIdsOf, retentionBudgetBytes, visibleSelection } from "./core/retention";
import {
  planWorkingSet,
  stripCap,
  toTabCandidate,
  deriveTabState,
  tabSignature,
  tabAriaLabel,
  retiredFromStrip,
  countSurvivingRetirees,
  pinnedFirst,
  nextFocusAfterRemoval,
} from "./core/working-set";
import type { TabVM, TabFacts } from "./core/working-set";
import { chooseDensity } from "./core/strip-density";
import type { StripDensity } from "./core/strip-density";
import { groupByTime, matchesFilters, startOfDay, DAY_MS } from "./core/history";
import type { HistoryFilter, FilterableConvo } from "./core/history";
import { isAiTitleDue } from "./core/title";
import { projectDirName, resumeStatus, resumableFrom, eligibleForFreeing } from "./core/resume-status";
import type { ResumeStatus, SessionFileProbe } from "./core/resume-status";
import { reconcileList } from "./ui/keyed-reconcile";
import type { CardModel } from "./ui/keyed-reconcile";
import { DEFAULT_SETTINGS } from "./settings";
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
  buildResearchOutbound,
  initialResearchModeState,
  normalizeResearchModeState,
  parseResearchCommand,
  toggleResearchMode as nextResearchMode,
  type ResearchModeState,
} from "./core/research";
import {
  buildAgentBindingOutbound,
  parseAgentCommand,
  type AgentCommandResult,
  type AgentDef,
} from "./core/agents";

export type { AskQuestion } from "./core/model";

/** Prompt surface for the Memory Union Store — appended to the boot preamble only
 *  when the store tools are registered. Kept short: the tool descriptions carry
 *  the detail. */
const memoryStoreNote = (storeDir: string): string =>
  "### Memory union store\n" +
  `A persistent, append-only memory store lives in \`${storeDir}/\` — verbatim preferences, facts, decisions, and lessons from past sessions. ` +
  "Call `recall` before answering anything that may depend on prior sessions instead of guessing, and use `remember` to store new durable statements in the user's exact words (never summarized).";

/** Variant used when proactive recall is ON: the plugin auto-injects the relevant
 *  memories, so the model no longer needs to *decide* to call `recall`. Kept short —
 *  `recall`/`remember` tool descriptions carry the detail. */
const memoryStoreNoteProactive = (storeDir: string): string =>
  "### Memory union store\n" +
  `A persistent, append-only memory store lives in \`${storeDir}/\`. Relevant past memories are auto-provided each turn inside \`[recalled-memory]…[/recalled-memory]\` blocks — trusted verbatim context, but BACKGROUND from other sessions. ` +
  "When the user refers back to the running conversation ('continua', 'le altre cose proposte', 'quello sopra', 'as above', 'go on'), the referent is THIS conversation's own history — resolve it from the current thread, never from recalled memory or the boot `Recent sessions` digest. " +
  "Use `recall` for a deeper or explicit search (e.g. `as_of` point-in-time queries), and `remember` to store new durable statements in the user's exact words (never summarized).";

/** Prompt surface for the identity layer — appended when the agent folder is on
 *  and `rethink_memory` is registered. Explains WHEN to rethink (world-model
 *  change) vs `remember` (episodic), and the propose-only persona tier. */
const agentFolderNote = (agentDir: string): string =>
  "### Identity — `rethink_memory`\n" +
  `Your identity lives in \`${agentDir}/\` (persona, human, now) and is already in your boot context above. ` +
  "Call `rethink_memory` only when your MODEL OF THE WORLD changes — a shifted priority (now.md), a durable update to how you understand the user (human.md, pass a rationale). NOT for episodic notes — those go to `remember`. " +
  "`persona.md` is propose-only: a `rethink_memory` on it records a proposal for the user to approve, it does not write.";

export const VIEW_TYPE = "exo-view";
/** Custom Obsidian icon id for the Exo brand mark (registered in main.ts). */
export const EXO_ICON = "exo-star";

const MAX_PERSIST_OUTPUT = 2000;
const MAX_CHECKPOINT_FILE = 64_000; // don't persist a rewind snapshot larger than this (bloat guard)

interface ToolCard {
  card: HTMLElement;
  statusEl: HTMLElement;
  bodyEl: HTMLElement;
  elapsedEl: HTMLElement;
  startedAt: number;
  /** Live workflow status span — created on the first workflow-progress event
   *  for this card (Workflow launches only). */
  wfEl?: HTMLElement;
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
  /** Slug of the agent this conversation is bound to via `/as` (persisted). */
  agent?: string;
  /** True for chats the user archived (persisted to the separate archive store,
   *  never evicted). Absent/false for live chats. */
  archived?: boolean;
  /** Explicit user protection: never a retention cleanup candidate, never
   *  auto-retired from the tab strip. Persisted. */
  pinned?: boolean;
  /** When this conversation left the tab strip (retired or archived). Feeds the
   *  history's "Ritirate di recente" group. Absent = never been in the strip,
   *  or still in it. Persisted. */
  retiredAt?: number;
  /** When this conversation was last the focused tab. The strip's LRU key.
   *  Persisted so the retire order survives a reload: every site that assigns it
   *  (`switchTo`, `setActiveSilently`) schedules a conversation-store write, not
   *  just the settings write that saves the tab set. */
  lastActiveAt?: number;
  /** Manually-assigned Session-Cockpit column (persisted). Absent = default. */
  boardStatus?: SessionLane;
  messages: PersistedMessage[];
}

/** A live task plus its scroll-to target card. The DOM-free `LiveTask` fields
 *  feed the pure core; `cardEl` is view-only. */
export type LiveTaskRecord = LiveTask & { cardEl: HTMLElement };

export interface Convo {
  id: string;
  listEl: HTMLElement;
  title: string;
  sessionId?: string;
  /** True when the user archived this chat: hidden from the board's active
   *  Session-Cockpit lanes and moved to a separate untrimmed store (never
   *  evicted). Persisted. */
  archived?: boolean;
  /** Explicit user protection: never a retention cleanup candidate, never
   *  auto-retired from the tab strip. Persisted. */
  pinned?: boolean;
  /** When this conversation left the tab strip (retired or archived). Feeds the
   *  history's "Ritirate di recente" group. Absent = never been in the strip,
   *  or still in it. Persisted. */
  retiredAt?: number;
  /** When this conversation was last the focused tab. The strip's LRU key.
   *  Persisted so the retire order survives a reload: every site that assigns it
   *  (`switchTo`, `setActiveSilently`) schedules a conversation-store write, not
   *  just the settings write that saves the tab set. */
  lastActiveAt?: number;
  /** Manually-assigned Session-Cockpit column (persisted). When set and the chat
   *  is idle, its card sits here instead of the default review lane; running /
   *  needs-input still auto-override. */
  boardStatus?: SessionLane;
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
  /** Active `/goal`. In-memory: not persisted across reloads. */
  goal?: GoalState;
  pendingPerm: (() => void) | null; // cancels an open permission card on stop
  pendingAsk: (() => void) | null; // cancels an open ask card on stop
  /** A turn completed on this conversation while it was not the focused tab.
   *  Runtime-only, never persisted (same discipline as `aiTitleAttempts`): after
   *  a reload there is nothing you "have not seen". */
  unread?: boolean;
  queue: {
    text: string;
    images?: ImageAttachment[];
    sendPrefix?: string;
    isRecoveryRetry?: boolean;
    researchMode?: ResearchModeState;
    /** Agent slug bound to this queued message (`@agent` picked before send). */
    agent?: string;
  }[];
  pendingEl: HTMLElement | null; // container for queued-message chips
  /** The in-flight assistant turn of THIS conversation (null when idle) — the
   *  target for its session's ask_user cards, so parallel conversations can't
   *  cross-render into each other's transcripts. */
  currentCtx: AssistantCtx | null;
  /** Live background work this conversation owns RIGHT NOW — subagents, background
   *  Bash, and Workflow agents. Lives on the Convo (NOT the per-turn AssistantCtx)
   *  so it OUTLIVES the turn: keep-alive Level 1. Keyed by tool-call id (subagent/
   *  bash) or Workflow tool_use id. Drives the expandable agents chip. Runtime-only. */
  liveTasks: Map<string, LiveTaskRecord>;
  /** The discreet "Related" section appended below the last turn when the
   *  transcript doesn't fill the viewport (null when not shown). */
  tailSurfaceEl: HTMLElement | null;
  /** True once the proactive ≥75% compaction nudge has been shown for this
   *  conversation — one-shot, so it never re-appears after dismiss or compaction. */
  compactNudged?: boolean;
  /** Unsent composer draft (text + attachments), stashed when the user switches
   *  away so every chat keeps its own composer — runtime-only, never persisted. */
  draft?: ComposerDraft;
  /** Provider-only prefix for the NEXT turn (Codex compact emulation: the
   *  recap that reseeds a fresh session). Consumed once, never UI/persisted. */
  pendingSendPrefix?: string;
  /** Persisted per-conversation Research Mode; never shared across tabs. */
  researchMode: ResearchModeState;
  /** Slug of the agent this whole conversation is bound to (`/as <agent>`).
   *  Persisted. Deliberately does NOT alter `SessionOpts`: the binding is a
   *  provider-only rider that routes the turn to the engine's own subagent, so
   *  it can never desync `sessionSigOf()` or force a session respawn. */
  agent?: string;
  /** Count of AI-title generation attempts fired for this conversation — counts
   *  fires, not successes (a call that times out still consumes one). Feeds
   *  `isAiTitleDue` (core/title.ts), which allows at most 2: one after the first
   *  assistant turn, and — if the title is still not `aiTitleApplied` — one more
   *  after a later turn. Runtime-only (never persisted). */
  aiTitleAttempts?: number;
  /** True once a real AI title has actually landed and been swapped into
   *  `c.title`. The authoritative "no more retries" signal — deliberately a
   *  separate explicit flag rather than inferred by comparing `c.title` against
   *  the shape of a derived placeholder, since a user's own text can
   *  coincidentally look like a finished title. Runtime-only (never persisted). */
  aiTitleApplied?: boolean;
  /** Proactive recall (design 2026-07-09): ids of store entries already injected
   *  into THIS conversation's outbound turns, so each memory is paid for once and
   *  then lives in cached history. Runtime-only — never persisted (a reloaded
   *  conversation re-injects from scratch, which is correct: the cached history is
   *  gone too). Mirrors the runtime-only pattern of `aiTitleAttempts` above. */
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
  /** Ids proposed for cleanup by the last persist (over-budget). Advisory:
   *  nothing is ever deleted without explicit confirmation. Runtime-only. */
  private retentionCandidateIds: string[] = [];
  /** Ids selezionati nella cronologia per un'azione bulk. Runtime-only, azzerato
   *  a ogni apertura della gallery. */
  private gallerySelection = new Set<string>();
  /** Active history filter chips. Runtime-only, cleared on every gallery open —
   *  same lifetime as `gallerySelection`, so reopening the history is always a
   *  clean slate and never a filter the user forgot they left on. */
  private historyFilters = new Set<HistoryFilter>();
  /** Session ids the Claude CLI holds for this vault, read once per gallery
   *  open. `null` means the read failed or the directory is absent — and then
   *  the UI shows NO resume badge at all, never "everything restarts". The
   *  distinction is the whole safety property: a false warning on all thirty
   *  cards at once is worse than the feature not existing. Runtime-only. */
  private sessionsOnDisk: Set<string> | null = null;
  /** Memo behind `convoSizeOf`, keyed by conversation id and invalidated by
   *  `updatedAt`. Runtime-only; an entry dies with its conversation. */
  private convoSizeCache = new Map<string, { updatedAt: number | undefined; bytes: number }>();
  /** Disarms the bulk bar's pending delete (timer + outside-click listener).
   *  Set while a bar is armed, so rebuilding or closing the gallery can never
   *  strand the document-level listener. */
  private bulkDisarm: (() => void) | null = null;
  /** Re-runs the open gallery's grid against current state, preserving the
   *  search text and the active chips. Non-null exactly while a gallery is up.
   *  Exists because `renderGrid` is a closure over `showGallery`'s locals, and
   *  an action that changes what the cards say — freeing a session file — has
   *  to repaint them without tearing the history down and losing the user's
   *  place in it. */
  private galleryRerender: (() => void) | null = null;

  /** The strip's outer row. Owns the gutter and the hidden state, so hiding the
   *  strip still hides the trailing controls along with the tabs. */
  private tabsRowEl!: HTMLElement;
  /** Holds ONLY reconciled tabs. Its children are keyed and owned by
   *  `reconcileList`, which positions the desired models by child INDEX —
   *  nothing else may be appended here. An unkeyed child is not removed (the
   *  reconciler only collects nodes carrying `data-cardKey`); it survives, takes
   *  up an index, and the tabs get inserted around it, so the strip's order and
   *  the model list's order drift apart. */
  private tabsEl!: HTMLElement;
  /** Trailing strip controls (the overflow counter and the `+` button). A
   *  sibling of `tabsEl` precisely because they are not models: living among
   *  the tabs, they would be unkeyed children shuffled around by the
   *  reconciler's index-based positioning. */
  private tabsTailEl!: HTMLElement;
  /** "N chats left the strip" — built once, like the `+`; only its numeral is
   *  state, and `renderTabs` owns that. */
  private tabsOverflowEl!: HTMLElement;
  /** Last count painted into `tabsOverflowEl`. Same ethic as the tab signature:
   *  repaint on a real change, not on every render. -1 = never painted. */
  private overflowPainted = -1;
  /** The dense-mode hover label: the title of the tab under the cursor. A
   *  sibling of `tabsEl`, never a child of a tab — see `showTabHover` for the
   *  measurement that forced that. */
  private tabHoverEl!: HTMLElement;
  /** The tab the label is currently describing, so a repaint that discards that
   *  node can take the label down with it. */
  private tabHoverAnchor: HTMLElement | null = null;
  /** Current strip density. Runtime-only: recomputed from the live row width on
   *  every resize and on every change of tab count, never persisted — it is a
   *  property of the pane the strip happens to be in, not of the session. */
  private stripDensity: StripDensity = "wide";
  /** How many tabs the last render drew — kept current on EVERY render, the
   *  hidden-row one included. Two jobs: it is the count the resize path
   *  re-decides density with, and it is the guard that keeps `renderTabs` from
   *  measuring the DOM on every state repaint. Density can only move when the
   *  row's width changes (the observer) or when this does. */
  private stripTabCount = 0;
  private stripResizeObserver: ResizeObserver | null = null;
  /** What the active tab takes when it shows its title: `.mva-tab`'s max-width.
   *  A documented constant and NOT a measurement of the rendered tab — reading
   *  the DOM here would feed the decision its own last output, and the width it
   *  would read in dense mode is the width dense mode produced. */
  private static readonly STRIP_ACTIVE_TAB_PX = 170;
  private listWrap!: HTMLElement;
  /** Pinned "N agents running" chip above the composer, reflecting ONLY the chat
   *  currently open (its own subagents + background tasks). Always visible while
   *  that chat has background work, even when the working row scrolls off. */
  private agentChipEl: HTMLElement | null = null;
  /** The enumerable list popover for `agentChipEl`, when open. */
  private agentPopoverEl: HTMLElement | null = null;
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
  private brandDot!: HTMLElement;
  private lastPersistErrorNotice = 0;
  /** Coalesces persist() bursts into one write. Many state changes (every
   *  streaming chunk, tab tweak, turn boundary) call persist(); without this
   *  each one re-serialized ALL conversations (~MBs) and rotated the .bak —
   *  dozens of full-file writes per active minute, each re-uploaded by Sync.
   *  A trailing debounce collapses a burst into a single write; MAX_WAIT bounds
   *  worst-case latency so a continuous stream still flushes periodically. Any
   *  pending write is flushed synchronously on close. */
  private persistTimer: number | null = null;
  private persistScheduledAt = 0;
  private static readonly PERSIST_DEBOUNCE_MS = 1500;
  private static readonly PERSIST_MAX_WAIT_MS = 8000;
  /** How many tabs must retire in ONE wave before `applyWorkingSet` says so.
   *  Set at 3 because the steady state is 1: the only wave that clears it is the
   *  first one after the cap ships, when a long-accumulated strip collapses at
   *  once. Lowering it to 1 would turn the cap into a nag; raising it would let
   *  the migration pass unannounced, which is the case it exists for. */
  private static readonly RETIRE_NOTICE_MIN = 3;
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
  /** One-shot listeners resolved the next time a session's init caps arrive —
   *  how `reloadMcpConnections()` (Connections pane) awaits the fresh MCP
   *  statuses after a respawn without polling. Flushed in the onCaps handler. */
  private capsWaiters: Array<(caps: SessionCaps) => void> = [];
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
    // The strip is one flex row made of two containers: the tabs (reconciled,
    // scrollable) and a tail of controls that must survive every reconcile.
    // The `+` is built once here rather than on every render — it is chrome,
    // not state.
    this.tabsRowEl = root.createDiv({ cls: "mva-tabstrip" });
    this.tabsEl = this.tabsRowEl.createDiv({ cls: "mva-tabs" });
    this.tabsTailEl = this.tabsRowEl.createDiv({ cls: "mva-tabs-tail" });
    // The counter goes BEFORE the `+`: it is the continuation of the tab list
    // ("…and N more that left"), so it belongs against the tabs, while the `+`
    // is the action that grows the list and stays at the far edge.
    this.tabsOverflowEl = this.tabsTailEl.createDiv({ cls: "mva-tab-overflow is-hidden" });
    // The node is new and empty, so the memo has to be: `onOpen` can run again on
    // the same view (the root is emptied above), and a memo surviving the node it
    // describes would leave the counter blank until the number happened to move.
    this.overflowPainted = -1;
    this.clickable(this.tabsOverflowEl, () => this.toggleGallery("retired"));
    const addTab = this.tabsTailEl.createDiv({ cls: "mva-tab-add", attr: { "aria-label": "New tab" } });
    setIcon(addTab, "plus");
    this.clickable(addTab, () => this.newConversation());
    // The dense-mode hover label. Absolutely positioned against the ROW, so it
    // is out of the flex flow and belongs to neither container: putting it in
    // `tabsEl` would make it an unkeyed child of the reconciled list, and
    // putting it inside a tab would put it inside a scroll container.
    // `aria-hidden`: its text is a duplicate of the title the hovered tab's own
    // `aria-label` already carries, and in browse mode a screen reader walks the
    // DOM — it would meet the same conversation twice, once as a tab and once as
    // a floating label with no role. It is a pointer affordance only.
    this.tabHoverEl = this.tabsRowEl.createDiv({
      cls: "mva-tab-hover is-hidden",
      attr: { "aria-hidden": "true" },
    });
    // Same reason as `overflowPainted` above: `onOpen` can run again on the same
    // view, and an anchor surviving the row it pointed into would keep a label
    // alive that has nothing left to describe.
    this.tabHoverAnchor = null;
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
    this.clickable(this.agentChipEl, () => this.toggleAgentPopover());
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
    this.composer.refreshAgentChip();
    this.composer.refreshContext();
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.composer.refreshContext();
        this.refreshSurfacing();
      })
    );
    // Resizing the pane can flip a short transcript into overflow (or back) without
    // any content change — keep the tail "Related" section in sync with that too.
    // Debounced: a drag emits a continuous stream of resize ticks, and each tail
    // render is markdown work — collapse the burst into one render at rest.
    const renderTailDebounced = debounce(() => this.renderTailSurfacing(this.active), 120, true);
    const tailResizeObserver = new ResizeObserver(() => renderTailDebounced());
    tailResizeObserver.observe(this.listWrap);
    this.register(() => {
      renderTailDebounced.cancel();
      tailResizeObserver.disconnect();
    });
    // Recap Rail: full-page-only. Re-evaluate `is-wide` on container resize and on
    // layout-change (dragging the leaf between sidebar and main), then build/clear.
    // Debounced for the same reason; the discrete layout-change event below still
    // drives applyWideMode() promptly when the leaf is docked/undocked.
    const applyWideDebounced = debounce(() => this.applyWideMode(), 120, true);
    this.recapResizeObserver = new ResizeObserver(() => applyWideDebounced());
    this.recapResizeObserver.observe(root);
    this.register(() => {
      applyWideDebounced.cancel();
      this.recapResizeObserver?.disconnect();
      this.recapResizeObserver = null;
    });
    this.registerEvent(this.app.workspace.on("layout-change", () => this.applyWideMode()));
    // Strip density: the same debounce shape as the two observers above, for the
    // same reason — a drag emits a continuous stream of ticks.
    //
    // It observes the strip ROW and not the tab list. The row's box is the pane's
    // width and a fixed height, neither of which density can move; `.mva-tabs`
    // sizes to its own content, so observing it would feed the decision the
    // consequence of the last decision and let a flip re-trigger itself. The
    // repaint is also gated on an actual change of density, which closes the
    // loop from the other side.
    const applyDensityDebounced = debounce(() => {
      if (this.updateStripDensity()) this.renderTabs();
    }, 120, true);
    this.stripResizeObserver = new ResizeObserver(() => applyDensityDebounced());
    this.stripResizeObserver.observe(this.tabsRowEl);
    this.register(() => {
      applyDensityDebounced.cancel();
      this.stripResizeObserver?.disconnect();
      this.stripResizeObserver = null;
    });
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
      { enabled: this.active.researchMode.enabled }
    );
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
      { enabled: this.active.researchMode.enabled }
    );
  }

  async onClose(): Promise<void> {
    if (this.scrollRaf !== null) {
      cancelAnimationFrame(this.scrollRaf);
      this.scrollRaf = null;
    }
    // Flush any debounced conversation write before we tear down, so a change
    // made in the last debounce window isn't lost when the view closes.
    if (this.persistTimer !== null) this.flushPersist();
    // this.active is always within this.convos, so the loop covers it.
    for (const c of this.convos) this.dropSession(c);
    this.memoryObserver?.dispose();
    this.memoryObserver = null;
    this.closeAgentPopover();
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
      clearBoundAgent: () => this.clearBoundAgent(),
      compactActive: (instructions) => this.compactActive(instructions),
      handleGoalCommand: (c, text) => this.handleGoalCommand(c, text),
      resumeGoalLoop: (c) => this.resumeGoalLoop(c),
      togglePlanMode: () => this.togglePlanMode(),
      toggleResearchMode: () => this.toggleResearchMode(),
      onProviderChange: (next, explicitModel) => this.onProviderChange(next, explicitModel),
      allModelChoices: () => this.allModelChoices(),
      persistModel: () => this.persistModel(),
      persist: () => this.persist(),
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

  /** Append text to the active tab's draft and focus — the hub's Skills tab
   *  chip-click idiom (`/command `, `@agent `). Targets whichever conversation
   *  is currently active in this view; the plugin-level wrapper reveals the
   *  view first so the user sees where the text landed. */
  insertIntoComposer(text: string): void {
    this.composer.insertText(text);
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

    const hasObsidianTools = s.obsidianToolsEnabled && s.toolsEnabled;
    // Claude receives the native in-process MCP server; Codex receives the same
    // registry through its isolated loopback bridge below.
    const useObsidian = hasObsidianTools && c.provider === "claude";
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
          this.plugin.loopsWriteQueue,
          this.plugin.paths
        )
      : undefined;

    let memoryPreamble: string | undefined;
    // Provider-agnostic since Tranche A (Codex parity): Claude appends it to
    // the system prompt; Codex prefixes it to the session's first turn.
    if (s.memoryReadEnabled) {
      if (!this.memoryPreamble)
        this.memoryPreamble = await readBootContext(this.app, this.plugin.paths, {
          agentFolderEnabled: s.agentFolderEnabled,
        });
      memoryPreamble = this.memoryPreamble || undefined;
      // Tell the agent the union store exists whenever its tools are registered
      // (obsidian tools on + memory read on ⇒ `recall`, +write ⇒ `remember`).
      // With proactive recall ON, swap in the variant that says memories are
      // auto-provided (the model needn't decide to call `recall`).
      if (hasObsidianTools) {
        const note = s.proactiveRecall
          ? memoryStoreNoteProactive(this.plugin.paths.store)
          : memoryStoreNote(this.plugin.paths.store);
        memoryPreamble = (memoryPreamble ? `${memoryPreamble}\n\n` : "") + note;
        // The Agent Is the Folder: when the identity layer is on and its tool is
        // registered, tell the model when to `rethink` (world-model change, not
        // episodic notes — those go to `remember`).
        if (s.memoryWriteEnabled && s.agentFolderEnabled) {
          memoryPreamble = `${memoryPreamble}\n\n${agentFolderNote(this.plugin.paths.agentDir)}`;
        }
      }
    }

    // Codex ↔ Obsidian tools bridge (Tranche B1): same registry as Claude's SDK
    // server, swapped per session. SANDBOX HONESTY: bridge writes happen in the
    // Obsidian process and bypass codex's sandbox, so a read-only sandbox gets
    // read tools only.
    let codexBridge: { port: number; token: string; scriptPath: string; stop?: () => void } | undefined;
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
          agentFolderEnabled: s.agentFolderEnabled && !readOnlySandbox,
          rethinkBridge: (req) => this.rethinkBridge(c, req),
          paths: this.plugin.paths,
        });
        const READ_BASENAMES = new Set(
          [...OBSIDIAN_READ_TOOLS].map((n) => n.replace("mcp__obsidian__", ""))
        );
        b.bridge.setTools(
          readOnlySandbox ? all.filter((t) => READ_BASENAMES.has(t.name) || t.name === "ask_user") : all
        );
        codexBridge = {
          port: b.bridge.port,
          token: b.bridge.token,
          scriptPath: b.scriptPath,
          stop: b.release,
        };
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
      autoCompact: s.autoCompactEnabled,
      sandboxMode: s.codexSandbox,
      approvalPolicy: s.codexApproval,
      codexBridge,
      requestUserInput: async (questions) => {
        const answers = await this.askBridge(c, questions);
        return Object.fromEntries(
          questions.map((question) => [question.id, answers[question.header] ?? ""])
        );
      },
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
      this.plugin.refreshHub(); // the hub pane tracks the same live snapshot
      // Release any reconnect (Connections pane) waiter parked on the next caps.
      if (this.capsWaiters.length) {
        const waiters = this.capsWaiters;
        this.capsWaiters = [];
        for (const w of waiters) {
          try {
            w(caps);
          } catch {
            /* a waiter must never break the caps handler */
          }
        }
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

  /** Reconnect the active conversation's MCP servers by respawning its CLI
   *  session. Because the spawn resumes the on-disk session id, the conversation
   *  and its context survive — only the MCP connections are re-attempted, which
   *  also picks up fresh OAuth credentials (after `claude mcp login`) and any
   *  `.mcp.json` edits. Declines mid-turn (a respawn would kill the in-flight
   *  turn). Resolves with the fresh MCP statuses once the new session's init
   *  caps arrive (or after an 8s cap so the Connections pane never hangs). */
  async reloadMcpConnections(): Promise<{ ok: boolean; error?: string; servers?: SessionCaps["mcpServers"] }> {
    const c = this.active;
    if (!c) {
      return { ok: false, error: "No active session to reconnect." };
    }
    if (c.streaming) {
      return { ok: false, error: "A turn is running — stop it, then reconnect." };
    }
    // Park a one-shot waiter BEFORE the respawn so we catch the new session's
    // first init caps (not a stale prewarm's). Bounded so a session that never
    // reports caps (older CLI) still resolves.
    const nextCaps = new Promise<SessionCaps | null>((resolve) => {
      const timer = window.setTimeout(() => resolve(this.plugin.lastSessionCaps), 8000);
      this.capsWaiters.push((caps) => {
        window.clearTimeout(timer);
        resolve(caps);
      });
    });
    this.dropSession(c);
    try {
      await this.ensureSession(c);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const caps = await nextCaps;
    return { ok: true, servers: caps?.mcpServers };
  }

  /** Spin up the active conversation's CLI session in the background so the first
   *  message skips the cold start. No-op if disabled, already warm, streaming, or
   *  already warm. Errors are swallowed; a
   *  real send surfaces them through the normal UX. */
  private prewarm(): void {
    if (!this.plugin.settings.prewarmSession) return;
    const c = this.active;
    if (!c || c.session || c.streaming) return;
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

    // Apps menu — the single entry point for Exo's side surfaces (Cockpit,
    // Connections, Board). These live here, not in the global Obsidian ribbon.
    const apps = header.createEl("button", { cls: "mva-icon-btn", attr: { "aria-label": "Apps" } });
    setIcon(apps, "hi-puzzle");
    setTooltip(apps, "Apps");
    apps.onclick = (e) => {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle("Cockpit").setIcon("hi-dashboard-speed").onClick(() => void this.plugin.openCockpit()));
      menu.addItem((i) => i.setTitle("Capabilities").setIcon("hi-puzzle").onClick(() => void this.plugin.activateHub()));
      if (this.plugin.settings.orchestrationEnabled) {
        menu.addItem((i) => i.setTitle("Orchestration board").setIcon("hi-workflow").onClick(() => void this.plugin.activateBoard()));
      }
      menu.showAtMouseEvent(e);
    };

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
    this.persist();
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
      const runtimeModels = provider === "codex" ? this.plugin.lastSessionCaps?.models : undefined;
      for (const m of runtimeModels?.length ? runtimeModels : a.models()) {
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
    const live = (await this.plugin.loadConversations()) as ConvoData[];
    const archivedRaw = (await this.plugin.loadArchivedConversations()) as ConvoData[];
    // Merge the live store with the separate, untrimmed archive store. Archived
    // chats carry archived:true — present (retrievable) but hidden by the board
    // from active lanes. A missing/corrupt archive file just yields no archives.
    const raw = [
      ...(Array.isArray(live) ? live : []),
      ...(Array.isArray(archivedRaw) ? archivedRaw : []),
    ];
    // Only build transcript DOM for conversations that will actually be shown
    // (open tabs + the active one). Everything else renders lazily on first
    // open (switchTo) — with dozens of stored conversations this is the bulk
    // of the view's startup cost.
    const wantDom = new Set([...(this.plugin.settings.openTabIds ?? []), this.plugin.settings.activeTabId]);
    // First pass: seed the id counter from the highest numeric id suffix present,
    // NOT the conversation count — ids climb past the count after deletions and
    // history trimming, so a count-based seed produces colliding ids.
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
        archived: d.archived === true,
        pinned: d.pinned === true,
        retiredAt: d.retiredAt,
        lastActiveAt: d.lastActiveAt,
        boardStatus: d.boardStatus,
        provider,
        model,
        allow: new Set(),
        updatedAt: d.updatedAt,
        usage: d.usage,
        researchMode: normalizeResearchModeState(d.researchMode),
        agent: typeof d.agent === "string" && d.agent ? d.agent : undefined,
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
        liveTasks: new Map(),
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

  /** Map a live Convo to its on-disk shape. Shared by the live and archive
   *  serializers; `archived` is written only when true (keeps the file clean). */
  private toConvoData(c: Convo): ConvoData {
    return {
      id: c.id,
      title: c.title,
      provider: c.provider,
      model: c.model,
      sessionId: c.sessionId,
      updatedAt: c.updatedAt,
      usage: c.usage,
      researchMode: c.researchMode,
      ...(c.agent ? { agent: c.agent } : {}),
      ...(c.archived ? { archived: true } : {}),
      // Strict `=== true`, matching the two sites that READ it (`pinnedIdsOf`
      // and `restore`): one rule for pinning, stated the same way everywhere.
      ...(c.pinned === true ? { pinned: true } : {}),
      ...(c.retiredAt ? { retiredAt: c.retiredAt } : {}),
      ...(c.lastActiveAt ? { lastActiveAt: c.lastActiveAt } : {}),
      ...(c.boardStatus ? { boardStatus: c.boardStatus } : {}),
      messages: c.messages.map((message) =>
        persistMessage(message, {
          maxToolOutput: MAX_PERSIST_OUTPUT,
          maxCheckpointFile: MAX_CHECKPOINT_FILE,
        })
      ),
    };
  }

  /** All conversations including the active one — which isn't always in `convos`
   *  (several paths push it lazily). The canonical "full set" for persistence and
   *  snapshots. */
  private allConvos(): Convo[] {
    return this.convos.includes(this.active) ? this.convos : [...this.convos, this.active];
  }

  /** Split the conversation set into the live payload (for conversations.json)
   *  and the archived payload (for the separate store). Neither side is trimmed:
   *  over-budget live conversations become advisory cleanup candidates, never
   *  deletions — only empty, unprotected "New chat" husks are dropped. One
   *  partition, one `saveActive`: the two payloads are a single consistent
   *  snapshot with no ordering coupling. See core/retention for the contract.
   *
   *  ONE deliberate loss, recorded here because nothing else in the tree records
   *  it: an EMPTY conversation that is neither active nor pinned is dropped even
   *  when it is currently a tab in the strip, so an empty non-active tab is
   *  garbage-collected on reload (`restore()` then filters its now-dangling id
   *  out of `openTabIds`). The old planner protected `[activeId, ...openTabIds]`
   *  precisely to stop that. Removing the tab set from the protection rule is
   *  the point of this plan — while it was in there, CLOSING a tab is what made
   *  a conversation deletable — so the protection is not coming back. Nothing
   *  the user wrote is lost: a husk holds zero messages. Recreating those tab
   *  placeholders belongs to the strip, not to the retention policy: Plan 2. */
  private serializeSplit(): { live: ConvoData[]; archived: ConvoData[] } {
    this.saveActive();
    const { live, archived } = this.recomputeRetention();
    return {
      live: live.map((c) => this.toConvoData(c)),
      archived: archived.map((c) => this.toConvoData(c)),
    };
  }

  /** Run the retention policy over the current set and refresh the advisory
   *  candidate list. Split out of `serializeSplit` because the plan used to
   *  exist only as a side effect of persisting: `restore()` never persists, so
   *  after every reload the proposal was empty and the gallery banner stayed
   *  dead until the user happened to send a message. The gallery now computes it
   *  on open. Returns the partition so the persist path plans and partitions
   *  once, not twice. */
  private recomputeRetention(): { live: Convo[]; archived: Convo[] } {
    const all = this.allConvos();
    const { live, archived } = partitionConvos(all);
    const plan = planRetention(live, {
      activeId: this.active.id,
      pinnedIds: pinnedIdsOf(all),
      // Clamped, not trusted: data.json is hand-editable and a 0/negative/
      // non-numeric budget would propose every conversation for cleanup.
      budgetBytes: retentionBudgetBytes(
        this.plugin.settings.retentionBudgetMb,
        DEFAULT_SETTINGS.retentionBudgetMb
      ),
      sizeOf: (c) => this.convoSizeOf(c),
    });
    this.retentionCandidateIds = plan.candidates.map((c) => c.id);
    return { live: plan.keep, archived };
  }

  /** Weight of one conversation AS THE STORE WILL HOLD IT — hence the trip
   *  through `toConvoData`, which is what actually lands on disk — memoized per
   *  conversation and invalidated by `updatedAt`.
   *
   *  The memo is not an optimization detail, it is what keeps the cost bounded:
   *  `persist()` forces a flush every PERSIST_MAX_WAIT_MS during a stream, and
   *  the planner measures each kept conversation and again each candidate. Left
   *  unmemoized that is several full serializations of the entire store, on the
   *  main thread, every few seconds — and unlike the count cap this replaced,
   *  the byte budget only proposes, so nothing bounds how large the store gets.
   *  A streaming conversation is never cached: it grows between `updatedAt`
   *  bumps, so a cached weight would be stale exactly while it is moving.
   *
   *  The figure counts UTF-16 code units, not bytes, so a store full of
   *  non-ASCII text weighs more on disk than the setting labelled "MB" implies.
   *  Deliberate: this feeds a proposal the user confirms, not a hard limit, and
   *  an exact byte count means a second encoding pass per conversation. Same
   *  reasoning for title-only edits (`aiTitle`), which do not move `updatedAt`
   *  and so are not re-measured until the next real change — a few characters. */
  private convoSizeOf(c: Convo): number {
    if (c.streaming) return JSON.stringify(this.toConvoData(c)).length;
    const hit = this.convoSizeCache.get(c.id);
    if (hit && hit.updatedAt === c.updatedAt) return hit.bytes;
    const bytes = JSON.stringify(this.toConvoData(c)).length;
    this.convoSizeCache.set(c.id, { updatedAt: c.updatedAt, bytes });
    return bytes;
  }

  /** Schedule a debounced write. Callers fire this freely; the actual
   *  serialize+write is coalesced in flushPersist(). */
  private persist(): void {
    const now = Date.now();
    if (this.persistScheduledAt === 0) this.persistScheduledAt = now;
    // Bound worst-case staleness: if we've been coalescing past MAX_WAIT
    // (e.g. an unbroken stream of changes), stop deferring and write now.
    if (now - this.persistScheduledAt >= ChatView.PERSIST_MAX_WAIT_MS) {
      this.flushPersist();
      return;
    }
    if (this.persistTimer !== null) window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => this.flushPersist(), ChatView.PERSIST_DEBOUNCE_MS);
  }

  /** Serialize the current conversation set and enqueue the atomic write. Runs
   *  the debounce trailing edge and any forced/close-time flush. */
  private flushPersist(): void {
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistScheduledAt = 0;
    const { live, archived } = this.serializeSplit();
    void this.plugin.saveConversations(live).then((ok) => {
      if (ok) return;
      // Throttle so a persistent disk problem doesn't spam a Notice every turn.
      const now = Date.now();
      if (now - this.lastPersistErrorNotice > 30_000) {
        this.lastPersistErrorNotice = now;
        new Notice("Exo couldn't save conversation history — check disk space and vault permissions.");
      }
    });
    // Archive store is best-effort and shares the same serialized write queue; a
    // failure just retries on the next persist (the flag stays in memory).
    void this.plugin.saveArchivedConversations(archived);
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
      liveTasks: new Map(),
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

  /** Enforce the strip's soft cap. Called after anything that adds a tab or
   *  changes which one is focused. Retiring removes from the strip and stamps
   *  `retiredAt`; the conversation itself is untouched and stays in the history
   *  (see core/retention: being an open tab no longer affects survival).
   *
   *  Self-contained on purpose: when it changes anything it re-renders the strip
   *  and persists both halves of the change (the tab set in settings, `retiredAt`
   *  in the conversation store), so no caller has to remember to. */
  private applyWorkingSet(): void {
    const byId = new Map(this.allConvos().map((c) => [c.id, c]));
    const candidates = this.openTabs
      .map((id) => byId.get(id))
      .filter((c): c is Convo => !!c)
      .map((c) => toTabCandidate(c));

    const plan = planWorkingSet(candidates, {
      activeId: this.active.id,
      // Clamped, not trusted — same reasoning as `retentionBudgetBytes` above:
      // data.json is hand-editable and a 0/negative/non-numeric cap would retire
      // every non-exempt tab in the strip at once.
      cap: stripCap(this.plugin.settings.stripMaxTabs, DEFAULT_SETTINGS.stripMaxTabs),
    });
    if (plan.retire.length === 0) return;

    const now = Date.now();
    const retired = new Set(plan.retire);
    const retiredConvos: Convo[] = [];
    for (const id of plan.retire) {
      const c = byId.get(id);
      if (!c) continue;
      c.retiredAt = now; // never 0: toConvoData drops a falsy value
      retiredConvos.push(c);
      this.dropSession(c); // free the live session; resumable from the history
    }
    // Remove exactly what was retired, rather than assigning `plan.visible`:
    // the plan is built from resolvable ids only, so assigning it would ALSO
    // purge orphan ids — but only on the turns where something retires. That
    // half-time cleanup is worse than none. `renderTabs` already purges orphans
    // unconditionally, so it stays the single owner of that.
    this.openTabs = this.openTabs.filter((id) => !retired.has(id));
    // Silence is right in the steady state: a seventh tab pushing out a sixth is
    // the cap doing exactly its job, and nagging every time would make the whole
    // mechanism feel like an interruption. It is wrong exactly ONCE — the first
    // switch after this ships retires every pre-upgrade tab in a single click
    // (nothing streams after a cold restore and drafts are not persisted, so no
    // tab is exempt), and a bulk event on real data must not go unobserved. The
    // threshold fires on that migration and effectively never again, because a
    // steady-state wave is one tab. The wording is load-bearing too: retiring is
    // not deleting (see core/retention), and the one thing the user must not
    // conclude from a strip that just emptied is that they lost the chats.
    //
    // The threshold and the number both read `countSurvivingRetirees`, not
    // `plan.retire.length`: an empty "New chat" husk retires like everything
    // else here but has no card in the history after the next persist (see
    // `retention.ts` and `retiredFromStrip`), so counting it would put a number
    // on the Notice that nothing behind it matches — and a batch of nothing but
    // husks must stay silent, not announce zero.
    const survivingCount = countSurvivingRetirees(retiredConvos);
    if (survivingCount >= ChatView.RETIRE_NOTICE_MIN) {
      new Notice(
        `${survivingCount} chat ritirate dalla strip — sono nella cronologia, nulla è stato eliminato.`
      );
    }
    this.renderTabs();
    this.persistTabs();
    this.persist(); // `retiredAt` lives in the conversation store, not in settings
  }

  private switchTo(c: Convo): void {
    if (c === this.active) return;
    this.saveActive();
    this.active.draft = this.composer.getDraft();
    if (!this.convos.includes(this.active)) this.convos.push(this.active);
    this.active = c;
    // You are looking at it now.
    c.unread = false;
    // The LRU key. Set before applyWorkingSet runs below, so the tab you just
    // opened is the freshest one and can never be the one that retires.
    c.lastActiveAt = Date.now();
    // Coming back from the history un-retires: it is in the strip again.
    c.retiredAt = undefined;
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
    this.composer.refreshAgentChip();
    // Reflect the newly-active convo's session quota (if any) on the badge.
    this.composer.setLastRateLimit((c.session as { rateLimit?: RateLimitInfo | null } | null)?.rateLimit ?? null);
    this.composer.updateRateBadge();
    this.renderTabs();
    this.applyWorkingSet();
    this.persistTabs();
    // Both facts recorded above — the LRU key and the cleared `retiredAt` — live
    // in the CONVERSATION store, which `persistTabs` (settings only) does not
    // touch, and `applyWorkingSet` persists only on the turns where something
    // actually retired. Without this a switch followed by a quit loses them, and
    // the retire order after a reload is whatever the last unrelated write
    // happened to capture. Debounced and coalesced, so a burst of tab switching
    // is still one file write.
    this.persist();
    this.scrollConvo(c);
    this.renderTailSurfacing(c);
    this.rebuildOutline();
    this.updateRecap();
    this.prewarm();
  }

  /* ----------------------------- tab bar ---------------------------- */

  /**
   * Repaint the strip. Cheap by construction — keyed reconciliation rebuilds
   * only the tabs whose signature actually changed — so it is safe to call on
   * every state transition, which is the whole point: before this, the strip
   * repainted only on structural events and the streaming pulse was correct
   * mostly by coincidence, whenever an agent count happened to move.
   *
   * The entry point for STATE transitions — streaming, needs-input, turn end,
   * agent counts. The structural sites (restore, switchTo, closeTab, retire)
   * keep calling `renderTabs` directly: they already had a reason to repaint.
   * The split is the whole point of the name — it says "a fact this strip
   * renders just changed", which is why later work adds calls here and not
   * scattered `renderTabs` calls.
   */
  private refreshTabs(): void {
    this.renderTabs();
  }

  /** Render the open-conversation tab strip. */
  private renderTabs(): void {
    if (!this.tabsEl) return;
    const ids = this.openTabs.filter((id) => this.convos.some((c) => c.id === id));
    this.openTabs = ids; // cleanup only: this is also planWorkingSet's LRU input,
    // so it must stay in true (unsorted) order — never the display order below.
    // Painted before the early return below so the numeral is already right
    // whenever the row comes back, rather than lagging a render behind it.
    // `this.convos` and not `allConvos()`: the active convo is always in
    // `openTabs`, so the filter excludes it either way, and `convos` is the set
    // that already exists before `restore()` assigns `active`.
    this.renderOverflow(retiredFromStrip(this.convos, this.openTabs, Date.now()).length);
    // A lone empty tab needs no bar — keep the chrome minimal. The whole row
    // hides, tail included: the `+` used to live inside `tabsEl` and disappear
    // with it. The counter does NOT keep the row alive: it is an affordance OF
    // the strip, and with one chat open there is no strip and nothing it is
    // hiding — a count there would just duplicate the header's History icon.
    this.tabsRowEl.toggleClass("is-hidden", ids.length <= 1);
    if (ids.length <= 1) {
      reconcileList(this.tabsEl, []); // drop the lone tab, as the old empty() did
      this.hideTabHover(); // the row is going away; so must anything it was showing
      // Keep the field honest. Left at the old count it would describe a render
      // that no longer exists, while `is-dense` sits on a display:none row — dead
      // state rather than a bug (the row is unmeasurable, so nothing can flip),
      // but state that stops meaning what its docstring says.
      this.stripTabCount = ids.length;
      return;
    }

    // Adding or removing a tab changes the density's divisor, so it has to
    // re-decide here as well as on resize. Gated on the count actually moving:
    // `renderTabs` runs on every state transition (a streaming pulse, an agent
    // count), and `updateStripDensity` reads layout — measuring on each of those
    // would trade a repaint we avoid for a forced reflow we did not need.
    if (ids.length !== this.stripTabCount) {
      this.stripTabCount = ids.length;
      // Return value ignored on purpose: the class is applied inside, and we are
      // already about to repaint every tab that needs it.
      this.updateStripDensity();
    }

    const isPinnedId = (id: string): boolean => this.convos.find((c) => c.id === id)?.pinned === true;
    // Display order only: pinned tabs sort to the left so they sit at a stable,
    // always-visible edge. `ids` (this.openTabs) stays unsorted — see above.
    const shown = pinnedFirst(ids, isPinnedId);
    // The tab that opens the unpinned group, but only when a pinned block comes
    // before it: with nothing pinned there is no boundary to draw, and with
    // everything pinned there is no unpinned group to open. `shown` is already
    // in pinned-first order, so "the first unpinned one" is the boundary — and
    // when there is none, `undefined` matches no id.
    const firstUnpinnedId = shown.some(isPinnedId) ? shown.find((id) => !isPinnedId(id)) : undefined;
    const models: CardModel[] = [];
    for (const id of shown) {
      const c = this.convos.find((x) => x.id === id);
      if (!c) continue;
      const vm = deriveTabState({
        streaming: c.streaming,
        pendingPerm: c.pendingPerm != null,
        pendingAsk: c.pendingAsk != null,
        unread: c.unread === true,
        stopped: c.stopped,
        poisoned: !!c.resumeRisky,
      });
      const agents = this.agentCount(c);
      const pinned = c.pinned === true;
      const isActive = c === this.active;
      // Untitled and empty renders as the placeholder, which the title string
      // alone cannot express: "New chat" with a first message in it is a plain
      // title.
      const placeholder = !c.title || (c.title === "New chat" && c.messages.length === 0);
      // ONE object for the signature and for the build, rather than two argument
      // lists that have to agree: a fact the tab paints and the signature omits
      // is a tab that goes stale, and this makes the two structurally the same
      // set of facts instead of a convention the next reader has to keep.
      const facts: TabFacts = {
        title: c.title,
        placeholder,
        state: vm.state,
        needsInput: vm.needsInput,
        reason: vm.reason,
        agents,
        pinned,
        active: isActive,
        density: this.stripDensity,
        firstUnpinned: id === firstUnpinnedId,
      };
      models.push({
        key: c.id,
        sig: tabSignature(facts),
        build: () => this.buildTab(c, vm, facts),
      });
    }
    reconcileList(this.tabsEl, models);
    // A repaint can discard the very node the hover label is describing (the
    // density flip does exactly that, to every tab at once). The label outlives
    // its anchor's `mouseleave`, so it has to be taken down here.
    if (this.tabHoverAnchor && !this.tabHoverAnchor.isConnected) this.hideTabHover();
  }

  /**
   * Re-decide the strip's density from the live row width, apply the class, and
   * report whether it moved. Deliberately does NOT repaint: `renderTabs` calls
   * this on its way to a repaint it was already doing, and the resize path
   * repaints only when this returns true — which is what keeps an observer that
   * triggers a repaint from re-triggering itself.
   *
   * The width is the ROW's, minus the tail. Not `tabsEl`'s: that one is sized by
   * its content, so in dense mode it reports the width dense mode produced and
   * the strip would never come back.
   *
   * KNOWN BIAS, accepted. `clientWidth` includes the row's two 10px gutters, and
   * the subtraction leaves in the 2px flex gap before the tail, so this reports
   * ~22px more than the tabs can actually use. That is a systematic offset, not
   * noise — hysteresis absorbs noise and does nothing about a constant, which
   * simply shifts both thresholds down together. It divides by `tabCount - 1`,
   * so the error is ~4px per tab at six tabs (harmless) but the whole ~22px on
   * the single divisor at two tabs, moving the effective entry point from 90 to
   * ~68: at low tab counts the strip goes dense one band late. Accepted rather
   * than paying a `getComputedStyle` on every resize tick, because that is the
   * count where wide already fits comfortably and the flip matters least.
   */
  private updateStripDensity(): boolean {
    if (!this.tabsRowEl || !this.tabsTailEl) return false;
    const next = chooseDensity({
      availableWidth: this.tabsRowEl.clientWidth - this.tabsTailEl.offsetWidth,
      tabCount: this.stripTabCount,
      activeTabWidth: ChatView.STRIP_ACTIVE_TAB_PX,
      current: this.stripDensity,
    });
    if (next === this.stripDensity) return false;
    this.stripDensity = next;
    this.tabsRowEl.toggleClass("is-dense", next === "dense");
    return true;
  }

  /**
   * Show the dense-mode hover label for `tab`.
   *
   * It is a child of the strip ROW and positioned by hand, rather than an
   * `position: absolute` child of the tab, because of what the real tree does:
   * `.mva-tabs` is a scroll container (`overflow-x: auto`) and clips positioned
   * descendants, and dense mode cannot simply turn that off — pinned tabs are
   * exempt from the strip cap, so a dense strip is not guaranteed to fit and
   * still has to scroll. Letting the label escape instead was measured on the
   * live pane: `.view-content` computes `overflow: auto`, and its scrollWidth
   * went from 457px to 1390px — a horizontal scrollbar on the whole chat.
   *
   * Clamped to the row for the same reason: the label may cover its neighbours,
   * which is the point, but it may never reach past the row that holds it.
   */
  private showTabHover(tab: HTMLElement, title: string): void {
    const el = this.tabHoverEl;
    if (!el) return;
    el.setText(title);
    el.removeClass("is-hidden");
    const row = this.tabsRowEl.getBoundingClientRect();
    const at = tab.getBoundingClientRect();
    // Anchored just past the tab, so the mark it is naming stays visible; pushed
    // back left only as far as it takes to keep its right edge inside the row.
    // The 10 is the row's right gutter (`.mva-tabstrip`'s padding).
    const rightLimit = row.width - 10 - el.offsetWidth;
    el.style.left = `${Math.max(0, Math.min(at.right - row.left + 4, rightLimit))}px`;
    this.tabHoverAnchor = tab;
  }

  private hideTabHover(): void {
    this.tabHoverAnchor = null;
    this.tabHoverEl?.addClass("is-hidden");
  }

  /**
   * Paint the overflow counter: how many chats left the strip and can be got
   * back. Rendered only when there are any — a zero would be chrome reporting
   * nothing.
   *
   * It opens the whole history for now. Plan 3 adds the "Ritirate di recente"
   * group and points this straight at it; until then the destination is wider
   * than the group, but the NUMBER is already exactly the group's size — that
   * is the seam, and it is on the destination side, never on the count.
   */
  private renderOverflow(n: number): void {
    if (this.overflowPainted === n) return;
    this.overflowPainted = n;
    const el = this.tabsOverflowEl;
    el.empty();
    el.toggleClass("is-hidden", n === 0);
    if (n === 0) {
      // Also drop the label: an aria-label on a display:none node is invisible
      // to sighted users and still stale to everyone else.
      el.removeAttribute("aria-label");
      return;
    }
    // English, like every other accessible name in this row ("Close tab", "New
    // tab", "N agents running", and the state words in `tabAriaLabel`). An
    // aria-label is a terse element name and follows the codebase's convention;
    // Notices are sentences addressed to the user and stay Italian. Mixing the
    // two INSIDE the strip was the actual defect: the tab announced "running"
    // and the counter twenty pixels away answered in Italian.
    el.setAttr("aria-label", `${n} retired chat${n === 1 ? "" : "s"} — open history`);
    el.createSpan({ cls: "mva-tab-overflow-n", text: String(n) });
    // A noun with a direction, not a state: the chevron says "there is more that
    // way", which is the whole message.
    setIcon(el.createSpan({ cls: "mva-tab-overflow-ico" }), "chevron-right");
  }

  /**
   * Build one tab, DETACHED: `reconcileList` owns insertion and ordering, so
   * creating this under `tabsEl` would duplicate the node and corrupt the order.
   * It paints exactly `f` — the same object the caller signed — so a fact it
   * reads is a fact the signature carries by construction.
   */
  private buildTab(c: Convo, vm: TabVM, f: TabFacts): HTMLElement {
    const { agents, pinned, active: isActive, placeholder } = f;
    // In dense mode a non-active tab is its status mark and nothing else. The
    // title it would have shown at 170px is ~14 characters of a sentence that
    // starts the same way as every other one in the strip — the widest possible
    // tab buying no recognition — so it costs ~18px instead of 170 and the title
    // arrives on hover, where it can be read in full.
    const bare = f.density === "dense" && !isActive;
    const tab = createDiv({ cls: "mva-tab" + (isActive ? " is-active" : "") });
    const title = placeholder ? "New chat" : c.title || "New chat";
    // The separator between the pinned block and the rest. A border on the tab
    // that opens the group, never a node between tabs: `tabsEl` holds only keyed
    // children, and a foreign element there takes an index and shifts every tab
    // after it out of the order the reconciler asked for.
    tab.toggleClass("is-first-unpinned", f.firstUnpinned);
    // "Blocked on you" rides the TAB, not the mark: it is the only state where
    // the work is stopped AND the user is the reason, so it earns the whole
    // tab's weight instead of a share of the 6px slot. It also has to coexist
    // with a streaming mark — a turn waiting on a permission prompt is still
    // streaming — which one slot could not express.
    tab.toggleClass("is-blocked", vm.needsInput);
    // The colour and the shape say all of this to a sighted user; the label
    // says it to everyone else. It has to carry everything the tab shows,
    // including the badge and the pin: setting it here REPLACES
    // name-from-content, so their own labels stop being announced.
    //
    // Unconditional, and identical in both densities. What dense mode drops is
    // pixels, not facts: below, the title, the pin and the × leave the DOM, so
    // this attribute becomes the ONLY place a screen reader can learn which
    // conversation this mark belongs to.
    tab.setAttr("aria-label", tabAriaLabel(title, vm, { agents, pinned }));

    // One 6px slot, five states, zero pictograms — and nothing else: the
    // provider colour deliberately does NOT live here.
    //
    // The class is stamped for EVERY state, `idle` included. It used to be
    // omitted, on the reasoning that idle draws nothing and so needs no hook —
    // but dense mode gives idle something to draw (see the `.is-idle` rule in
    // styles.css), and a hook the CSS can name beats selecting idle as "none of
    // the other four": that form has to be extended by hand for every state
    // added later, and out-specifies the new state's own rule when it is not.
    const mark = tab.createSpan({ cls: "mva-tab-mark" });
    mark.addClass(`is-${vm.state}`);

    if (!bare) {
      const titleEl = tab.createSpan({ cls: "mva-tab-title" + (placeholder ? " is-placeholder" : "") });
      if (placeholder) {
        setIcon(titleEl, "pencil");
        titleEl.append("New chat");
      } else {
        titleEl.setText(title);
      }

      // Pinned is a noun, so it gets an icon (states never do). Dropped in dense
      // for the same reason the title is: the separator says "these are the
      // pinned ones" once for the whole group, at 1px, instead of 11px per tab.
      if (pinned) setIcon(tab.createSpan({ cls: "mva-tab-pin" }), "pin");
    }

    // Per-tab agent count: how many subagents/background tasks THIS chat is
    // running right now — local to its own tab, so a busy background chat is
    // visible at a glance without leaking into the chat you're reading.
    if (agents > 0) {
      const badge = tab.createSpan({
        cls: "mva-tab-agents",
        attr: { "aria-label": `${agents} agent${agents > 1 ? "s" : ""} running` },
      });
      // Motion budget: one moving element per tab. While the tab is streaming
      // the mark carries the motion and this stays a static numeral — two
      // animations on one tab compete for attention instead of informing.
      const icon = badge.createSpan({
        cls: "mva-tab-agents-icon" + (vm.state === "streaming" ? "" : " is-spinning"),
      });
      setIcon(icon, "loader");
      badge.createSpan({ text: String(agents) });
    }

    // The × goes with the title in dense mode: keeping it would either double
    // every dense tab (12px icon + 6px gap against an 18px tab, and the strip
    // stops fitting again) or make it appear on hover, which reflows the strip
    // under the cursor — the one thing the hover label exists to avoid. Closing
    // does NOT go with it: the context menu below carries it in both densities.
    if (!bare) {
      const x = tab.createSpan({ cls: "mva-tab-x", attr: { "aria-label": "Close tab" } });
      setIcon(x, "x");
      this.clickable(x, (e) => {
        e.stopPropagation();
        this.closeTab(c);
      });
    }
    if (bare) {
      // The title, on hover, over the neighbours. Wired per node like the ×
      // above, so the listeners die with the tab the reconciler discards.
      tab.addEventListener("mouseenter", () => this.showTabHover(tab, title));
      tab.addEventListener("mouseleave", () => this.hideTabHover());
    }
    this.clickable(tab, () => this.switchTo(c));
    // Right-click is where a tab's own actions live. Wired per node like the ×
    // above: the listener dies with the tab the reconciler discards, so nothing
    // has to unregister it, and the convo it acts on is the closure's — `c`,
    // this tab's own conversation — never a lookup back from the event target.
    //
    // Closing lives HERE and not only on the ×, which is what makes dropping the
    // × in dense mode affordable. The × is pointer-only and, in dense, gone: the
    // fallback of "activate the tab, then close it" would change which
    // conversation is open as a side effect of wanting to close a different one.
    // This item closes the right-clicked tab whatever the density, and reaches
    // the keyboard through Shift+F10 / the context-menu key.
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem((i) =>
        i
          .setTitle(pinned ? "Unpin tab" : "Pin tab")
          .setIcon(pinned ? "pin-off" : "pin")
          .onClick(() => this.togglePin(c))
      );
      // Last: it is the one item that takes something away.
      menu.addItem((i) => i.setTitle("Close tab").setIcon("x").onClick(() => this.closeTab(c)));
      menu.showAtMouseEvent(e);
    });
    return tab;
  }

  /**
   * The ONLY site that assigns `Convo.pinned` — the affordance and its mutation
   * point are one change on purpose: a painted pin nothing can set is a state
   * that never appears and never repaints.
   *
   * Pinning is the user's answer to "stop retiring this one": `planWorkingSet`
   * excludes pinned tabs from the cap's count AND from its retire candidates.
   * `pinned` is part of `tabSignature`, so `refreshTabs` repaints exactly this
   * tab; `persist` writes it (`toConvoData` keeps it when true), so it survives
   * a reload.
   *
   * Deliberately does NOT run `applyWorkingSet`. Un-pinning does put a tab back
   * inside the budget, but retiring "only ever happens as a consequence of the
   * user opening something, never while they are away" (core/working-set) —
   * running the cap from here would make a menu click on one tab tear away a
   * different one. The cap catches up on the next switch.
   */
  private togglePin(c: Convo): void {
    c.pinned = c.pinned !== true;
    this.refreshTabs();
    this.persist();
  }

  /**
   * Close a tab: it leaves the strip, the conversation stays in the history.
   *
   * Stamps `retiredAt`, so "left the strip" means one thing whichever way you
   * left it — the cap (`applyWorkingSet`), both archive gestures, and this ×.
   * Without it the overflow counter would silently skip every hand-closed tab
   * while claiming to count what the history holds, and by every user-visible
   * measure a hand-closed tab has left the strip exactly as hard as a retired
   * one. Retiring is not deleting: nothing here touches the conversation.
   */
  private closeTab(c: Convo): void {
    const idx = this.openTabs.indexOf(c.id);
    if (idx === -1) return;
    // Visual (pinned-first) order, captured BEFORE the splice below, so the
    // neighbour picked for focus is the one the eye sees next to `c` right
    // now — see `nextFocusAfterRemoval`.
    const visualOrder = pinnedFirst(this.openTabs, (id) => this.convos.find((x) => x.id === id)?.pinned === true);
    // After the guard, like `setConvoArchived`: a chat that was never a tab must
    // not claim to have left one.
    c.retiredAt = Date.now();
    this.openTabs.splice(idx, 1);
    this.dropSession(c); // free the live session; resumable from history
    if (c === this.active) {
      const nextId = nextFocusAfterRemoval(visualOrder, c.id);
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
    // Terminal state belongs to the turn that ended, and that turn is gone.
    // Both feed `deriveTabState` (`stopped`, and `resumeRisky` as `poisoned`),
    // so leaving them set would paint the stopped ring or the error dot on a tab
    // whose transcript is empty — a mark reporting an event with nothing left on
    // screen to explain it. Cleared here rather than trusting the next turn to:
    // the tab repaints below, and a "New chat" may sit untouched for hours.
    c.stopped = false;
    c.resumeRisky = false;
    c.researchMode = initialResearchModeState();
    c.agent = undefined;
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
  /** Retire the focused tab: it leaves the strip and stays in the history. The
   *  ONE command behind that gesture — closing IS retiring since `closeTab`
   *  stamps `retiredAt`, and shipping a second entry under the other name would
   *  be two bindable hotkeys for one action. Pinned tabs go too: the pin defends
   *  against the cap, which is automatic, not against a command just run. */
  cmdCloseTab(): void {
    this.closeTab(this.active);
  }
  /** Move focus one tab along the strip, wrapping at both ends. Goes through
   *  `switchTo` like a click, so it can run the cap — and like a click it can
   *  never cost you the tab you just landed on (the active tab is exempt) nor a
   *  pinned one; at or under the cap it retires nothing at all. */
  cmdCycleTab(delta: number): void {
    // Same pinned-first order the strip renders (see `renderTabs`), so
    // next/previous walks the row the user is actually looking at.
    const ids = pinnedFirst(this.openTabs, (id) => this.convos.find((c) => c.id === id)?.pinned === true);
    if (ids.length < 2) return;
    const at = ids.indexOf(this.active.id);
    // `openTabs` always contains the active id; if it somehow does not, start
    // from the head rather than doing nothing.
    const from = at === -1 ? 0 : at;
    const next = ids[(((from + delta) % ids.length) + ids.length) % ids.length];
    const target = this.convos.find((x) => x.id === next);
    if (target) this.switchTo(target);
  }
  cmdTogglePin(): void {
    const c = this.active;
    this.togglePin(c);
    // The pin shows in the strip, and the strip hides at a single tab — a
    // command with no visible target has to say what it did.
    new Notice(c.pinned ? "Tab pinned — the strip cap will leave it alone." : "Tab unpinned.");
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
   * Read API for the Session Cockpit (Session Cockpit plan, U2): project every
   * live conversation into a UI-free `SessionSnapshot` the board turns into
   * session-cards. The active convo isn't guaranteed to be in `convos` (it's
   * pushed lazily in several paths), so it's folded in — mirroring the serialize
   * idiom — else the chat most likely to be running would be silently dropped.
   * Pure read; never mutates chat state. `poisoned` is best-effort from
   * `resumeRisky` (the durable "last turn ended poisoned" hint; the transient
   * in-turn `poisoned` local is not kept on the Convo). The lane derivation
   * itself lives in the pure `deriveLane` (core/session-cards), not here.
   */
  listSessionSnapshots(): SessionSnapshot[] {
    // Scope to the OPEN chats (tabs) + the active one + anything currently
    // running or waiting on input — the "parallel chats I'm working with", NOT
    // the whole persisted history (`this.convos` holds every stored conversation,
    // dozens of them, which floods the board). Running/pending convos are shown
    // even if their tab is closed, so a background turn is never invisible.
    const openIds = new Set(this.openTabs);
    if (this.active) openIds.add(this.active.id);
    return this.convos
      .filter(
        (c) => openIds.has(c.id) || c.streaming || c.pendingPerm != null || c.pendingAsk != null,
      )
      .map((c) => ({
      id: c.id,
      title: c.title,
      streaming: c.streaming,
      pendingPerm: c.pendingPerm != null,
      pendingAsk: c.pendingAsk != null,
      poisoned: !!c.resumeRisky,
      stopped: c.stopped,
      hasMessages: c.messages.length > 0,
      archived: !!c.archived,
      boardStatus: c.boardStatus,
      updatedAt: c.updatedAt,
    }));
  }

  /**
   * Set or clear the archived flag on a conversation and persist. Used by the
   * board's Session Cockpit archive / un-archive actions (U6). Archiving hides
   * the chat from the board's active lanes and moves it to the separate
   * untrimmed store; it stays open in the chat gallery. Returns false if the
   * convo id isn't found.
   */
  setConvoArchived(convoId: string, archived: boolean): boolean {
    const c =
      this.convos.find((x) => x.id === convoId) ??
      (this.active?.id === convoId ? this.active : undefined);
    if (!c) return false;
    c.archived = archived;
    if (archived) {
      // "Archived" and "open in the working set" are contradictory states. Leave
      // the strip when archived; reopening from the history brings it back (and
      // resuming a turn un-archives it, see setStreaming).
      const idx = this.openTabs.indexOf(c.id);
      if (idx !== -1) {
        // Visual order captured BEFORE the splice, same reasoning as `closeTab`.
        const visualOrder = pinnedFirst(
          this.openTabs,
          (id) => this.convos.find((x) => x.id === id)?.pinned === true,
        );
        // Stamped here because this path does not go through `closeTab` (which
        // owns the stamp for every other exit). Inside the guard: `retiredAt`
        // means "left the strip", so a chat that was never a tab must not claim
        // to have left one.
        c.retiredAt = Date.now();
        this.openTabs.splice(idx, 1);
        if (c === this.active) {
          const nextId = nextFocusAfterRemoval(visualOrder, c.id);
          const next = nextId ? this.convos.find((x) => x.id === nextId) : undefined;
          // switchTo re-renders and re-persists the strip itself (and runs the
          // cap over the now-smaller set). It cannot re-enter here: `c` is
          // already out of openTabs, and nothing in switchTo archives.
          if (next) this.switchTo(next);
          else {
            // Archiving the last tab would otherwise leave an empty strip with
            // the archived chat still on screen. Same fallback as closeTab.
            const fresh = this.makeConvo();
            this.convos.push(fresh);
            this.openTabs.push(fresh.id);
            this.switchTo(fresh);
          }
        }
        this.persistTabs();
      }
    }
    // Repaint on EVERY path, not just the one that changed the tab set. The
    // overflow counter is the first strip-rendered fact that depends on
    // conversations which are NOT tabs, so archiving a chat with no tab — and
    // un-archiving anything — now changes what the strip says. Left inside the
    // branch, the strip would keep announcing a set it no longer opens until
    // some unrelated repaint happened along.
    this.renderTabs();
    this.persist();
    return true;
  }

  /** Set the manually-assigned board column for a conversation (Session Cockpit
   *  drag) and persist. Running/needs-input still auto-override at render time.
   *  Returns false if the convo id isn't found. */
  setConvoBoardStatus(convoId: string, status: SessionLane): boolean {
    const c =
      this.convos.find((x) => x.id === convoId) ??
      (this.active?.id === convoId ? this.active : undefined);
    if (!c) return false;
    c.boardStatus = status;
    this.persist();
    return true;
  }

  /** The board × action: archive a conversation AND close its sidebar tab. The
   *  card leaves the board, the tab closes, and the chat is kept in the separate
   *  archive store (retrievable via "Show archived"). Returns false if not found. */
  archiveAndCloseTab(convoId: string): boolean {
    const c =
      this.convos.find((x) => x.id === convoId) ??
      (this.active?.id === convoId ? this.active : undefined);
    if (!c) return false;
    c.archived = true;
    // closeTab frees the session, switches active if needed, and persists (→ the
    // archive store). For a convo that isn't an open tab, persist directly.
    if (this.openTabs.includes(c.id)) {
      // `closeTab` stamps `retiredAt` itself now, so this gesture and the board's
      // archive toggle (setConvoArchived, which does not route through closeTab
      // and keeps its own stamp) still agree on what "left the strip" means.
      this.closeTab(c);
    } else {
      // Same obligation as setConvoArchived above: `archived` is a fact the
      // strip now reads through the counter, even for a chat that has no tab,
      // so this branch owes a repaint it never used to.
      this.renderTabs();
      this.persist();
    }
    return true;
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

  /** Manually compact the active conversation's context, optionally
   *  steered by free-text `instructions` (from the /compact slash command). */
  private compactActive(instructions?: string): void {
    const c = this.active;
    if (c.streaming) {
      new Notice("Wait for the current turn to finish, then compact.");
      return;
    }
    if (!c.session?.compact) {
      new Notice("Send a message first — nothing to compact yet.");
      return;
    }
    const effectiveInstructions = c.provider === "codex" ? undefined : instructions;
    c.session.compact(effectiveInstructions);
    // Any compaction retires the proactive nudge for good.
    c.compactNudged = true;
    this.composer.hideCompactNudge();
    new Notice(
      instructions && c.provider === "codex"
        ? "Compacting the conversation… Codex does not support custom compact instructions."
        : instructions ? "Compacting with your instructions…" : "Compacting the conversation…",
    );
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

  /** Open/close the gallery. With a `preset` the caller is naming a destination
   *  (the strip counter says "open the retired ones"), so an already-open
   *  gallery showing something else SWITCHES to that preset instead of closing
   *  — silently closing would break the affordance the counter advertises.
   *  Clicking it again, once the preset is exactly what's on screen, closes:
   *  that keeps the counter a toggle for its own destination, and the
   *  no-preset header icon behaves exactly as before. */
  private toggleGallery(preset?: HistoryFilter): void {
    if (this.galleryEl) {
      const alreadyThere = !preset || (this.historyFilters.size === 1 && this.historyFilters.has(preset));
      this.hideGallery();
      if (alreadyThere) return;
      void this.showGallery(preset);
      return;
    }
    void this.showGallery(preset);
  }

  private hideGallery(): void {
    // The bulk bar's armed state owns a document-level listener; the bar is about
    // to be removed with its container, so drop it here or it outlives the DOM.
    this.bulkDisarm?.();
    this.bulkDisarm = null;
    // The grid it would repaint is about to be gone; holding the closure would
    // also pin the search input and every card it built.
    this.galleryRerender = null;
    this.galleryEl?.remove();
    this.galleryEl = null;
    // The session-id set is only ever read while the gallery is up, and every
    // render path sits downstream of a fresh read — so this frees ~800 strings
    // rather than fixing a bug. Dropping it also keeps the field's meaning
    // honest: null means "not read", which is exactly true once the history is
    // closed.
    this.sessionsOnDisk = null;
    this.listEl.show();
    this.composer.getComposerEl().show();
    this.rebuildOutline();
  }

  /** List the session ids the Claude CLI currently holds for this vault.
   *  Returns null on ANY failure: a missing, unreadable, or unidentifiable
   *  directory is an unknown, not a verdict. `resumeStatus` turns that null into
   *  `unknown` for every conversation, which draws nothing — whereas returning
   *  an empty Set would be a confident "none of them resume". */
  private async readSessionsOnDisk(): Promise<Set<string> | null> {
    try {
      const base = this.vaultPath();
      // No base path (mobile, or any non-filesystem adapter) encodes to "" and
      // would aim at ~/.claude/projects itself: a directory that reads just
      // fine and holds no .jsonl — a *successful* read meaning "nothing
      // resumes". Refuse to answer instead of answering wrongly.
      if (!base) return null;
      const fs = require("fs") as typeof import("fs");
      const os = require("os") as typeof import("os");
      const dir = `${os.homedir()}/.claude/projects/${projectDirName(base)}`;
      const names = await fs.promises.readdir(dir);
      return new Set(names.filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -6)));
    } catch {
      return null;
    }
  }

  /** Resume status of one conversation as the gallery sees it. Single seam, so
   *  the badge and the "Riparte da capo" chip cannot drift apart: they are the
   *  same call on the same input, not two expressions that agree today.
   *
   *  A Codex conversation always reports `unknown`: its session id is a Codex
   *  thread under ~/.codex, not a Claude CLI session file, so checking it
   *  against the Claude project directory would mark every Codex chat
   *  "restarts" — the exact false alarm this feature exists to avoid.
   *
   *  A conversation with no messages reports `unknown` too. It has no session
   *  because no turn ever ran, so "restarts" is technically true and completely
   *  uninformative: there is no context to lose. The gallery always shows the
   *  focused chat even when it is empty, so without this the freshly opened
   *  "New chat" card would permanently wear a warning about losing nothing. */
  private resumeStatusOf(c: Convo): ResumeStatus {
    if (c.messages.length === 0) return "unknown";
    return resumeStatus(c, c.provider === "claude" ? this.sessionsOnDisk : null);
  }

  /** Whether sending on this conversation would actually pick up its context.
   *  Asked once per turn, so it looks at ONE file instead of listing the
   *  ~900-entry project directory the gallery badge scans.
   *
   *  The decision — the guard order and the asymmetric default that makes only a
   *  positive absence change behavior — lives in `resumableFrom`, where it is
   *  unit-tested without a disk. All that remains here is the stat itself. */
  private isSessionResumable(c: Convo): boolean {
    const vaultBase = this.vaultPath();
    return resumableFrom({
      provider: c.provider,
      sessionId: c.sessionId,
      vaultBase,
      probe: () => this.probeSessionFile(vaultBase, c.sessionId ?? ""),
    });
  }

  /** Look up one Claude CLI session file. `statSync` with `throwIfNoEntry: false`
   *  rather than `existsSync`: it is the only spelling that separates "the file
   *  is not there" (undefined) from "the lookup failed" (throws, e.g. EACCES),
   *  which `existsSync` flattens into a plain false. That distinction is the
   *  whole point — see `resumableFrom`, which is allowed to act on the first and
   *  never on the second. */
  private probeSessionFile(vaultBase: string, sessionId: string): SessionFileProbe {
    try {
      const fs = require("fs") as typeof import("fs");
      const os = require("os") as typeof import("os");
      const file = `${os.homedir()}/.claude/projects/${projectDirName(vaultBase)}/${sessionId}.jsonl`;
      return fs.statSync(file, { throwIfNoEntry: false }) === undefined ? "absent" : "present";
    } catch {
      return "failed";
    }
  }

  /** `preset` accepts one filter or a set of them: a single value is what the
   *  strip counter passes, while the internal rebuild sites hand back the
   *  filters that were active before they tore the gallery down, so an
   *  unrelated event never silently undoes the user's chip selection. */
  private async showGallery(preset?: HistoryFilter | readonly HistoryFilter[]): Promise<void> {
    this.saveActive();
    this.gallerySelection.clear();
    this.historyFilters.clear();
    if (preset) for (const f of typeof preset === "string" ? [preset] : preset) this.historyFilters.add(f);
    if (!this.convos.includes(this.active)) this.convos.push(this.active);
    this.listEl.hide();
    this.composer.getComposerEl().hide();
    const wrap = this.listHost.createDiv({ cls: "mva-gallery-wrap" });
    this.galleryEl = wrap;
    this.rebuildOutline(); // drop the outline rail while the gallery is up
    wrap.createDiv({ cls: "mva-gallery-title", text: "Conversations" });

    // Plan on OPEN, not only on persist: the candidate list is runtime state and
    // restore() never persists, so a freshly reloaded plugin would show no
    // banner however far over budget the store is. Cheap on reopen — convoSizeOf
    // is memoized, so this re-measures only what actually changed.
    this.recomputeRetention();

    // Retention proposal (R3): over budget we SHOW, we never delete. The banner
    // is inert until the user acts on it — it only preselects the candidates.
    if (this.retentionCandidateIds.length > 0) {
      const banner = wrap.createDiv({ cls: "mva-gallery-retention" });
      const n = this.retentionCandidateIds.length;
      banner.createSpan({
        cls: "mva-gallery-retention-text",
        text: `La cronologia ha superato il budget. ${n} conversazion${n === 1 ? "e" : "i"} tra le più vecchie possono essere eliminate.`,
      });
      const act = banner.createSpan({ cls: "mva-gallery-retention-act", text: "Seleziona" });
      this.clickable(act, () => this.selectCandidates());
    }

    const sorted = [...this.convos]
      .filter((c) => c.messages.length > 0 || c === this.active)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

    if (sorted.length === 0) {
      wrap.createDiv({ cls: "mva-gallery" }).createDiv({ cls: "mva-empty-sub", text: "No conversations yet." });
      return;
    }

    // Which convos belong to a "done" orchestration task, for the gallery's
    // Done/Archiviata chip. taskStore exists even with Orchestration off, so
    // this is always safe — it just resolves empty in that case.
    const { tasks } = await this.plugin.taskStore.load();
    if (this.galleryEl !== wrap) return; // gallery was closed while we awaited
    const doneConvoIds = new Set(tasks.filter((t) => t.status === "done" && t.convo).map((t) => t.convo!));

    // Which chats still have a CLI session behind them. Read once per open, not
    // per card: the answer is the same for the whole grid, and the search box
    // re-runs renderGrid on every keystroke.
    this.sessionsOnDisk = await this.readSessionsOnDisk();
    // Second suspension point, second guard — the one above covers only the
    // await it follows. Without this, closing the history while the directory
    // read is in flight leaves us building chips and cards into a detached DOM.
    if (this.galleryEl !== wrap) return; // gallery was closed while we awaited

    // Filter chips, multi-select with AND semantics. Declared before `renderGrid`
    // on purpose: the DOM order is banner → chips → search → grid, and the click
    // handlers only dereference `renderGrid`/`search` when the user clicks, long
    // after both bindings are initialised. Same shape as the search box's own
    // `input` listener below.
    const chipsWrap = wrap.createDiv({ cls: "mva-gallery-chips" });
    const CHIP_LABELS: Record<HistoryFilter, string> = {
      open: "Aperte",
      retired: "Ritirate",
      archived: "Archiviate",
      olderThan30: "Più vecchie di 30 giorni",
      shortConvo: "Meno di 3 messaggi",
      restarts: "Riparte da capo",
    };
    for (const key of Object.keys(CHIP_LABELS) as HistoryFilter[]) {
      const chip = chipsWrap.createDiv({ cls: "mva-gallery-chip" });
      chip.setText(CHIP_LABELS[key]);
      // Class and `aria-pressed` move together, same discipline as
      // setCardSelected: clickable() stamps role="button" on the chip, and a
      // button with no `aria-pressed` announces no state at all — the active
      // chip would be visible to sighted users only.
      const paint = () => {
        const on = this.historyFilters.has(key);
        chip.toggleClass("is-active", on);
        chip.setAttr("aria-pressed", String(on));
      };
      paint();
      this.clickable(chip, () => {
        if (this.historyFilters.has(key)) this.historyFilters.delete(key);
        else this.historyFilters.add(key);
        paint();
        renderGrid(search.value);
      });
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
      const active = [...this.historyFilters];
      const now = Date.now();
      // Hoisted: the open-tab set is the same for every conversation in this
      // pass, so building it per card would be one allocation per card for no
      // difference in result.
      const openTabIds = new Set(this.openTabs);
      // Chips restrict, then the text search restricts what is left, then the
      // grouping applies to the survivors (R5). Order matters only for cost:
      // the result is the same set either way, and `convoMatches` is the
      // expensive half, so it runs last.
      const filtered = sorted.filter((c) => {
        const asFilterable: FilterableConvo = {
          id: c.id,
          updatedAt: c.updatedAt,
          retiredAt: c.retiredAt,
          archived: c.archived,
          openTabIds,
          messages: c.messages,
          restarts: this.resumeStatusOf(c) === "restarts",
        };
        return matchesFilters(asFilterable, active, now) && (!ql || this.convoMatches(c, ql));
      });

      // "Ritirate di recente" pulls from the ALREADY filtered set, and the rest
      // is the complement of it — so a conversation lands in exactly one group,
      // never in both its retired group and its time bucket.
      const retiredGroup = retiredFromStrip(filtered, this.openTabs, now);
      const retiredIds = new Set(retiredGroup.map((c) => c.id));
      const rest = filtered.filter((c) => !retiredIds.has(c.id));

      if (retiredGroup.length > 0) {
        this.renderHistoryGroup(grid, "Ritirate di recente", retiredGroup, doneConvoIds, true);
      }
      for (const g of groupByTime(rest, now)) {
        this.renderHistoryGroup(grid, g.label, g.items, doneConvoIds);
      }

      if (filtered.length === 0) {
        grid.createDiv({ cls: "mva-empty-sub", text: "No matching conversations." });
      }
      // Filtering changes which cards exist, and the bulk bar counts only cards
      // the user can see — so the bar has to be recomputed with the grid, not
      // just when the selection itself changes.
      this.renderBulkBar();
    };
    search.addEventListener("input", () => renderGrid(search.value));
    // Re-render on demand from outside this closure, keeping whatever the user
    // has typed and toggled. Bound here rather than exposing renderGrid itself
    // so callers cannot accidentally reset the search box by passing "".
    this.galleryRerender = () => renderGrid(search.value);
    renderGrid("");
  }

  /** One temporal group: a header row plus its cards. The cards stay DIRECT
   *  children of the grid — the group header is a sibling, not a wrapper — so
   *  every existing `.mva-card` consumer (bulk selection, `visibleCardIds`,
   *  `refreshSelectionUI`) keeps working without knowing groups exist. */
  private renderHistoryGroup(
    grid: HTMLElement,
    label: string,
    items: Convo[],
    doneConvoIds: Set<string>,
    retiredContext = false,
  ): void {
    if (items.length === 0) return;
    grid.createDiv({ cls: "mva-gallery-group-header", text: label });
    for (const c of items) this.renderCard(grid, c, doneConvoIds, retiredContext);
  }

  private renderCard(
    grid: HTMLElement,
    c: Convo,
    doneConvoIds: Set<string>,
    retiredContext = false,
  ): void {
    const card = grid.createDiv({ cls: "mva-card" });
    // Cards carry their id in the DOM: the bulk bar needs a DOM-to-id mapping
    // that survives the grid re-render the search box triggers.
    card.dataset.convoId = c.id;
    // A conversation is "active" when it's the focused tab, and "open" when it's
    // any of the tabs currently in the tab strip. Both get a visible marker so the
    // gallery mirrors what's open above it.
    const isActive = c === this.active;
    const isOpen = this.openTabs.includes(c.id);
    if (isActive) card.addClass("is-active");
    if (isOpen) card.addClass("is-open");
    this.setCardSelected(card, this.gallerySelection.has(c.id));
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

    // Why this chat left the active board: a completed orchestration task
    // ("Done") beats a plain manual archive ("Archiviata") when both are true.
    const badges = head.createDiv({ cls: "mva-card-badges" });
    if (doneConvoIds.has(c.id)) {
      badges.createSpan({ cls: "mva-card-status-badge is-done", text: "Done" });
    } else if (c.archived) {
      badges.createSpan({ cls: "mva-card-status-badge is-archived", text: "Archiviata" });
    }
    // Only the exception is drawn: a conversation that resumes with its full
    // context says nothing, exactly like an idle tab draws no mark. `unknown`
    // draws nothing either — see resumeStatus's contract. Not an `else` on the
    // block above: a chat can be archived AND no longer resumable, and hiding
    // the second fact behind the first would lose the one that costs context.
    if (this.resumeStatusOf(c) === "restarts") {
      // One word, deliberately. The badge cluster is `flex: 0 0 auto` and never
      // wraps or compresses, so every character it costs comes straight out of
      // `.mva-card-title` — and cards are ~180px wide. "Riparte da capo" is
      // ~105px of a ~152px head, leaving about three characters of title; with
      // "Archiviata" and "Active" alongside it the demanded width doubles the
      // space available and `overflow: hidden` clips the Open/Active badge off
      // the card. "Riparte" is ~45px, in line with "Active", and matches the
      // one-word badge family. The full sentence lives in title/aria-label, so
      // the meaning is a hover or a screen reader away, not lost.
      badges.createSpan({
        cls: "mva-card-status-badge is-restarts",
        text: "Riparte",
        attr: {
          title: "Riparte da capo: la sessione non è più disponibile",
          "aria-label": "Riparte da capo: la sessione non è più disponibile",
        },
      });
    }
    if (isOpen) {
      badges.createSpan({
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
    // Only inside the retired group: elsewhere the retirement date answers a
    // question nobody asked, here it explains why the card is in this group.
    if (retiredContext && c.retiredAt) {
      meta.createSpan({ text: `ritirata ${this.formatRelative(c.retiredAt)}` });
    }

    this.clickable(card, (e) => {
      // Cmd/Ctrl-click toggles selection; a plain click still opens the chat.
      // Once anything is selected, a plain click toggles too — otherwise the
      // first stray click would blow away a multi-selection.
      const mod = e as MouseEvent | KeyboardEvent;
      if (mod.metaKey || mod.ctrlKey || this.gallerySelection.size > 0) {
        if (this.gallerySelection.has(c.id)) this.gallerySelection.delete(c.id);
        else this.gallerySelection.add(c.id);
        this.setCardSelected(card, this.gallerySelection.has(c.id));
        this.renderBulkBar();
        return;
      }
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
    // Visual order captured BEFORE either splice below, same reasoning as
    // `closeTab` / `setConvoArchived`: pinned status is still readable off
    // `this.convos` at this point, and `c.id` is still in `this.openTabs`.
    const visualOrder = pinnedFirst(this.openTabs, (id) => this.convos.find((x) => x.id === id)?.pinned === true);
    const tabIdx = this.openTabs.indexOf(c.id);
    if (tabIdx !== -1) this.openTabs.splice(tabIdx, 1);
    const convoIdx = this.convos.indexOf(c);
    if (convoIdx !== -1) this.convos.splice(convoIdx, 1);

    if (c === this.active) {
      const nextId = nextFocusAfterRemoval(visualOrder, c.id);
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
    // This card may have been part of a pending bulk selection: drop it so the
    // bulk bar never announces more conversations than it can actually delete.
    if (this.gallerySelection.delete(c.id)) this.renderBulkBar();
    // ...and out of the retention proposal, which the banner's "Seleziona" reads
    // straight into a selection. Left in, a dangling id would make the bar
    // over-report and the delete under-deliver.
    this.retentionCandidateIds = this.retentionCandidateIds.filter((id) => id !== c.id);
    this.convoSizeCache.delete(c.id);
    // Group headers are SIBLINGS of the cards, not wrappers, so removing the
    // last card of a group leaves its header standing above the next group's
    // cards. A header owns exactly the cards that immediately follow it, so
    // "no card right after me" is precisely "my group is now empty" — one pass
    // over a static NodeList settles every header, in any order.
    grid.querySelectorAll<HTMLElement>(".mva-gallery-group-header").forEach((h) => {
      if (!h.nextElementSibling?.classList.contains("mva-card")) h.remove();
    });
    if (!grid.querySelector(".mva-card")) {
      grid.createDiv({ cls: "mva-empty-sub", text: "No conversations yet." });
    }
    this.persist();
  }

  /* ------------------------ gallery bulk selection ---------------------- */

  /** Paint selection state on a card. The class and `aria-pressed` move together
   *  so selection is never visible to sighted users only: `clickable()` gives
   *  every card `role="button"`, and a button with no `aria-pressed` announces
   *  no state at all. */
  private setCardSelected(card: HTMLElement, selected: boolean): void {
    card.toggleClass("is-selected", selected);
    card.setAttr("aria-pressed", String(selected));
  }

  /** Ids of the cards the grid is currently painting — i.e. what the user can
   *  actually see, after the search box has had its say. */
  private visibleCardIds(): Set<string> {
    const ids = new Set<string>();
    this.galleryEl?.querySelectorAll<HTMLElement>(".mva-card").forEach((el) => {
      const id = el.dataset.convoId;
      if (id) ids.add(id);
    });
    return ids;
  }

  /** The selection, restricted to what is on screen. Every consumer — the bar's
   *  count, the armed label, the delete itself — goes through this, so the
   *  number the user confirms and the set that is deleted are the same set by
   *  construction. See `visibleSelection` in core/retention for why. */
  private effectiveSelection(): string[] {
    return visibleSelection(this.gallerySelection, this.visibleCardIds());
  }

  /** Preselect the retention candidates so the user can review and confirm in
   *  one action. Selecting is not deleting: the bulk bar still asks. Under an
   *  active search the bar counts only the candidates actually on screen — the
   *  selection keeps the rest, and they come back when the filter clears. */
  private selectCandidates(): void {
    this.gallerySelection = new Set(this.retentionCandidateIds);
    this.refreshSelectionUI();
  }

  /** Paint the current selection onto the cards already on screen and refresh
   *  the bulk bar. Cards render their own `is-selected` from `gallerySelection`,
   *  so changing the selection in bulk needs no gallery teardown: the search
   *  box, the scroll position and the card DOM all survive. */
  private refreshSelectionUI(): void {
    this.galleryEl?.querySelectorAll<HTMLElement>(".mva-card").forEach((el) => {
      const id = el.dataset.convoId;
      this.setCardSelected(el, !!id && this.gallerySelection.has(id));
    });
    this.renderBulkBar();
  }

  /** The bulk action bar — visible only while something on screen is selected.
   *  Rebuilt on every selection change AND on every grid re-render, which also
   *  disarms a pending delete: neither growing the selection nor changing the
   *  filter can inherit a confirmation the user gave for a different set. */
  private renderBulkBar(): void {
    // Always drop the previous bar's arm state first — it owns a timer and a
    // document-level listener that must not outlive the element.
    this.bulkDisarm?.();
    this.bulkDisarm = null;
    const wrap = this.galleryEl;
    if (!wrap) return;
    wrap.querySelector(".mva-gallery-bulk")?.remove();
    const selected = this.effectiveSelection();
    const n = selected.length;
    if (n === 0) return;
    const bar = wrap.createDiv({ cls: "mva-gallery-bulk" });
    bar.createSpan({ text: `${n} selezionat${n === 1 ? "a" : "e"}` });

    // Claude-only, exactly like the badge (`resumeStatusOf`): a Codex sessionId
    // names a thread under ~/.codex, a different id space entirely — matching it
    // against Claude's project directory is meaningless, and filtering here is
    // what keeps a Codex thread id from ever reaching an unlink call.
    //
    // `this.sessionsOnDisk` is the set showGallery() already read; the button and
    // the badge answer from the same snapshot, and neither costs a second scan.
    // Null (unread / unreadable) collapses to an empty set: no evidence, so
    // nothing is eligible and no control appears — the safe direction here.
    //
    // Indexed once rather than two `find()` scans per selected id: this runs on
    // every search keystroke, and the selection can be the entire history.
    const byId = new Map(this.convos.map((c) => [c.id, c] as const));
    const freeable = eligibleForFreeing(
      selected.filter((id) => byId.get(id)?.provider === "claude"),
      (id) => byId.get(id)?.sessionId,
      this.sessionsOnDisk ?? new Set(),
      this.active.id,
    );
    // No eligible session → no control at all. A button that looks actionable and
    // silently does nothing teaches the user the wrong thing about the action.
    const freeDisarm = freeable.length > 0 ? this.addBulkFree(bar, freeable) : null;

    const del = bar.createSpan({ cls: "mva-gallery-bulk-del", text: "Elimina" });
    // Same arm/disarm shape as the per-card trash (addCardDelete): a 3s timer
    // plus a capturing outside-click. The N-conversation control must not be
    // guarded more weakly than the one-conversation one, which is what a bare
    // closure flag — armed until the bar happens to be rebuilt — amounted to.
    let armed = false;
    let disarmTimer: number | null = null;
    const outside = (ev: MouseEvent) => {
      if (ev.target !== del && !del.contains(ev.target as Node)) disarm();
    };
    const disarm = () => {
      armed = false;
      del.removeClass("is-armed");
      del.setText("Elimina");
      if (disarmTimer) {
        window.clearTimeout(disarmTimer);
        disarmTimer = null;
      }
      document.removeEventListener("click", outside, true);
    };
    // The bar owns ONE teardown but can now hold two armed controls, and neither
    // hideGallery nor the next renderBulkBar knows which one the user touched —
    // so clear both.
    this.bulkDisarm = () => {
      freeDisarm?.();
      disarm();
    };
    this.clickable(del, () => {
      if (!armed) {
        armed = true;
        del.addClass("is-armed");
        del.setText(`Elimina ${n} definitivamente`);
        disarmTimer = window.setTimeout(disarm, 3000);
        document.addEventListener("click", outside, true);
        return;
      }
      disarm();
      this.deleteSelected();
    });
    const cancel = bar.createSpan({ cls: "mva-gallery-bulk-cancel", text: "Annulla" });
    this.clickable(cancel, () => {
      this.gallerySelection.clear();
      this.refreshSelectionUI();
    });
  }

  /** The "free the session file" control, sitting between the count and
   *  `Elimina`. Returns its own disarm so the bar can tear down whichever
   *  control the user armed.
   *
   *  Deliberately lighter than `Elimina`: muted rather than error red, and NOT
   *  pushed right — that slot belongs to the one action that removes something
   *  the user reads. This removes a support file; the conversation itself is
   *  untouched. The two-stage confirm is `Elimina`'s exact shape (3s timer plus
   *  a capturing outside click) because the action is still irreversible — only
   *  the visual weight differs, never the guard.
   *
   *  `ids` are already the ELIGIBLE ones, each resolved to a session file the
   *  gallery just saw on disk. So the number on the button is the number of
   *  files that will actually go, never the raw selection count: a control that
   *  promises 5 and frees 2 is a control that lies. */
  private addBulkFree(bar: HTMLElement, ids: readonly string[]): () => void {
    const label = `Libera ${ids.length} session${ids.length === 1 ? "e" : "i"}`;
    const free = bar.createSpan({ cls: "mva-gallery-bulk-free", text: label });
    let armed = false;
    let disarmTimer: number | null = null;
    const outside = (ev: MouseEvent) => {
      if (ev.target !== free && !free.contains(ev.target as Node)) disarm();
    };
    const disarm = () => {
      armed = false;
      free.removeClass("is-armed");
      free.setText(label);
      if (disarmTimer) {
        window.clearTimeout(disarmTimer);
        disarmTimer = null;
      }
      document.removeEventListener("click", outside, true);
    };
    this.clickable(free, () => {
      if (!armed) {
        armed = true;
        free.addClass("is-armed");
        free.setText(`Conferma — libera ${ids.length}`);
        disarmTimer = window.setTimeout(disarm, 3000);
        document.addEventListener("click", outside, true);
        return;
      }
      disarm();
      void this.freeAndRefresh(ids);
    });
    return disarm;
  }

  /** Free the session files, then make the open gallery tell the truth again.
   *
   *  The snapshot is stale the moment an unlink lands, and simply nulling it was
   *  wrong in two directions at once. Nulling blanks the resume badge for EVERY
   *  conversation on screen — including the ones whose session files were never
   *  touched — as soon as anything re-renders, which one keystroke in the search
   *  box is enough to trigger. And `disarm()` restores the resting label without
   *  rebuilding the bar, so the control would go on advertising "Libera 2
   *  sessioni" for files that no longer exist; a second click would unlink
   *  nothing and report "0 sessioni liberate". That is precisely the
   *  looks-actionable-but-isn't failure the eligibility rule exists to prevent,
   *  leaking back in on the far side of the action.
   *
   *  So: re-read, then repaint. This is not the second read the plan rules out —
   *  that rule keeps the eligibility DECISION on one consistent snapshot, while
   *  reading back a change we just made is the only way the next decision starts
   *  from the truth. Order is load-bearing: read first, so the rebuild sees it.
   *
   *  Both steps are skipped when the gallery closed mid-flight — `hideGallery`
   *  has already set the snapshot to null, which is then correct ("not read"),
   *  and the next open re-reads anyway. */
  private async freeAndRefresh(ids: readonly string[]): Promise<void> {
    const freed = await this.freeSessions(ids);
    if (this.galleryEl) {
      this.sessionsOnDisk = await this.readSessionsOnDisk();
      // Rebuilds the cards AND the bulk bar (renderGrid ends in renderBulkBar):
      // the freed conversations pick up "Riparte da capo" immediately, the
      // untouched ones keep their badge, and the control recounts against what
      // is actually left — or disappears when nothing is.
      this.galleryRerender?.();
    }
    new Notice(
      `${freed} session${freed === 1 ? "e" : "i"} liberat${freed === 1 ? "a" : "e"}. Il contenuto resta intatto.`,
    );
  }

  /** Delete the CLI session files for `ids`, and only those — never anything
   *  else in the shared projects directory. Every path is built from a
   *  `sessionId` the eligibility check already matched against a real file in
   *  this vault's own project directory, and `projectDirName` is reused rather
   *  than re-derived so the encoding cannot drift from the read that found them.
   *
   *  Best-effort per file: one failure (EACCES, a file already gone) must not
   *  stop the rest, and there is nothing useful to surface per file — the badge
   *  self-corrects on the next gallery open either way.
   *
   *  Nothing on the `Convo` is touched. Freeing a session is not editing a
   *  conversation, and leaving `sessionId` in place keeps the badge honest: it
   *  reports what the disk says, not what this method remembers doing. */
  private async freeSessions(ids: readonly string[]): Promise<number> {
    const base = this.vaultPath();
    if (!base) return 0;
    const fs = require("fs") as typeof import("fs");
    const os = require("os") as typeof import("os");
    const dir = `${os.homedir()}/.claude/projects/${projectDirName(base)}`;
    let freed = 0;
    for (const id of ids) {
      const sessionId = this.convos.find((x) => x.id === id)?.sessionId;
      if (!sessionId) continue;
      try {
        await fs.promises.unlink(`${dir}/${sessionId}.jsonl`);
        freed++;
      } catch {
        /* best-effort: a failed unlink is not worth aborting the rest for */
      }
    }
    return freed;
  }

  /** Permanently drop every selected conversation. The only deletion path that
   *  this plan adds — and it is always user-confirmed (armed twice).
   *
   *  Deletes the VISIBLE selection, never the raw set: the count the user just
   *  confirmed came from the same call, so the blast radius can never exceed
   *  what the confirmation showed. */
  private deleteSelected(): void {
    const ids = this.effectiveSelection();
    const removed: string[] = [];
    for (const id of ids) {
      const c = this.convos.find((x) => x.id === id);
      if (!c || c === this.active) continue; // never delete the focused chat
      this.dropSession(c);
      const tabIdx = this.openTabs.indexOf(c.id);
      if (tabIdx !== -1) this.openTabs.splice(tabIdx, 1);
      const idx = this.convos.indexOf(c);
      if (idx !== -1) this.convos.splice(idx, 1);
      this.convoSizeCache.delete(id);
      removed.push(id);
    }
    // Clear the WHOLE selection, not just what was deleted: any id that was
    // selected but filtered out of view was never confirmed, so it must not
    // survive as a live selection into whatever the user does next.
    this.gallerySelection.clear();
    // Only what actually went away leaves the candidate list: a skipped active
    // chat is still over budget and must still be proposed next time.
    const gone = new Set(removed);
    this.retentionCandidateIds = this.retentionCandidateIds.filter((id) => !gone.has(id));
    this.persistTabs();
    this.persist();
    this.renderTabs();
    // Carry the active chips across the rebuild: the user chose them, and a
    // delete they asked for must not silently reset what they are looking at.
    const keepFilters = [...this.historyFilters];
    this.hideGallery();
    void this.showGallery(keepFilters);
    // Il caso zero non è un "0 eliminate": succede quando la selezione conteneva
    // solo la chat attiva, che il ciclo salta. Dirlo, invece di riportare un
    // numero che sembra un errore.
    const n = removed.length;
    new Notice(
      n === 0
        ? "Nessuna conversazione eliminata: la chat attiva non si elimina da qui."
        : n === 1
          ? "1 conversazione eliminata."
          : `${n} conversazioni eliminate.`
    );
  }

  /** Point `active` at another conversation without leaving the gallery overlay:
   *  its transcript is prepared (rendered, hidden behind the gallery) so a later
   *  hideGallery/switchTo reveals it correctly. */
  private setActiveSilently(next: Convo): void {
    this.active.draft = this.composer.getDraft();
    this.active = next;
    // Same as switchTo: this is the focused tab now. Needed here too, because a
    // later switchTo to the SAME convo returns early on `c === this.active` and
    // would never get the chance to clear it.
    next.unread = false;
    this.provider = next.provider;
    this.model = next.model;
    // Same two facts switchTo records: this is now the focused tab (LRU key) and
    // it is back in the strip. The cap itself is left to the next switchTo —
    // retiring a tab out from under an open gallery overlay would be invisible.
    next.lastActiveAt = Date.now();
    next.retiredAt = undefined;
    if (!this.openTabs.includes(next.id)) this.openTabs.push(next.id);
    if (next.messages.length && next.listEl.childElementCount === 0) this.renderConvoDom(next);
    next.listEl.hide(); // gallery is on top; reveal happens on hideGallery/switchTo
    this.listHost.appendChild(next.listEl);
    if (next.listEl.childElementCount === 0) this.renderEmptyState();
    this.refreshProviderUI();
    this.syncSendButton();
    this.composer.updateUsage(next.usage ?? null);
    this.composer.setDraft(next.draft);
    this.composer.refreshGoal(next);
    this.renderTabs();
    this.persistTabs();
    // Same reason as switchTo: `lastActiveAt` and the cleared `retiredAt` are
    // conversation-store state, and `persistTabs` writes settings only.
    this.persist();
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
                  : seg.t === "notice"
                    ? ""
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

  /** "3 giorni fa" style relative time, for the retired-group badge — absolute
   *  dates (formatDate) answer "when"; this answers "how long has it been
   *  sitting there", which is what explains why the card is in this group.
   *
   *  Counts CALENDAR days, the same vocabulary `groupByTime` uses, not raw
   *  24-hour periods: a chat retired yesterday at 23:00 and read this morning
   *  is "ieri", not "oggi". `Math.round` because a DST day is 23 or 25 hours
   *  long and the quotient would otherwise land just off the integer. */
  private formatRelative(ts: number): string {
    const days = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / DAY_MS);
    if (days <= 0) return "oggi";
    if (days === 1) return "ieri";
    return `${days} giorni fa`;
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
        memorySetupNeeded(
          this.plugin.settings.memorySetup,
          isVaultSetUp((p) => !!this.app.vault.getAbstractFileByPath(p), this.plugin.paths)
        ),
      applyMemorySetup: (preset) => void this.plugin.applyMemorySetup(preset),
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
          } else if (s.t === "notice") {
            flushRun();
            body.createDiv({ cls: "mva-faint mva-notice", text: s.message });
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
        c.aiTitleApplied = true; // authoritative "don't retry" signal — see isAiTitleDue
        this.renderTabs();
        // Rebuild the open gallery so its card shows the refreshed title — but
        // NOT while a bulk selection is in progress: showGallery() clears the
        // selection, so a title landing in the background would silently undo
        // the user's in-progress multi-select. A stale card title is the lesser
        // surprise, and the next gallery open fixes it.
        // The filters get the same protection, by being replayed rather than
        // skipped: they are equally user-chosen state showGallery() would clear.
        if (this.galleryEl && this.gallerySelection.size === 0) {
          const keepFilters = [...this.historyFilters];
          this.hideGallery();
          void this.showGallery(keepFilters);
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
        this.plugin.memoryWriteQueue,
        this.plugin.paths.store
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
      this.agentFolder = new AgentFolder(this.app, this.plugin.memoryWriteQueue, this.plugin.paths.agentDir);
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
   *  memory read + agentic mode). Any false → the send path is byte-identical
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
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(`${this.plugin.paths.store}/`));
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
   *  path. Gated by both memory toggles; never blocks the turn or the next one.
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
      this.refreshTabs(); // the title is a rendered fact: a state transition
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
  /** Fold the current steps-run — but keep it live (in-progress, still ticking, no
   *  ✓) while a foreground subagent it launched is still running: the run's completed
   *  state depends on its children, not just the parent's own tool calls. The next
   *  natural close trigger (parent text resumes, turn-end) folds it once the subagent
   *  has resolved. `force` (turn-end) and `interrupted` fold regardless, so a subagent
   *  that never resolves can't strand the run open. */
  private closeStepsRun(ctx: AssistantCtx, interrupted = false, force = false): void {
    const run = ctx.stepsRun;
    if (!run) return;
    if (
      !run.closed &&
      !shouldFoldStepsRun({ runningSubagents: ctx.runningTasks.size, force, interrupted })
    ) {
      return; // a descendant subagent is still in flight — stay in-progress
    }
    run.close(ctx.convo.listEl, interrupted);
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
    this.closeStepsRun(ctx, interrupted, /* force */ true); // turn is over — fold regardless of tracked subagents
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
          if (name === "KillShell") {
            this.liveStatus(ctx.convo, this.bgIdForShell(ctx, sid), "stopped");
          }
          break;
        }
      }
    }
  }

  /** Find the live-task id (original background Bash tool-call id) for a shell
   *  id — background Bash entries are keyed by their launching tool-call id, not
   *  the shell id KillShell/BashOutput reference. Guard: `liveStatus(c, "", …)`
   *  is a harmless no-op (`liveTasks.get("")` → undefined). */
  private bgIdForShell(ctx: AssistantCtx, sid: string): string {
    for (const [id, task] of ctx.bgTasks) if (task.shellId === sid) return id;
    return "";
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
      this.setPendingCard(c, "perm", null);
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
    this.setPendingCard(c, "perm", () => finishCard("Cancelled", { behavior: "deny", message: "Stopped." }));
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
      this.setPendingCard(c, "perm", null);
      seg.approved = approved;
      // building=true only on a live approval — the historical/restored card omits it.
      this.renderPlanSettled(card, md, approved, approved);
      resolve(d);
    };

    // Stop cancels the open card (provider side already unblocked via interrupt).
    this.setPendingCard(c, "perm", () => finish(false, { behavior: "deny", message: "Stopped." }));
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
      this.setPendingCard(c, "ask", null);
      // Collapse to the same compact summary used when the transcript is restored,
      // so live-resolved and reloaded cards look identical.
      this.renderAskSummary(card, questions, answers);
      this.closeCard(ctx); // release the card slot — working row returns if needed
      resolve(answers);
    };
    // Stop (or turn teardown) cancels the card → the tool reports a dismissal.
    this.setPendingCard(c, "ask", () => {
      if (done) return;
      done = true;
      this.setPendingCard(c, "ask", null);
      this.closeCard(ctx); // cancelled (Stop / teardown) → release the slot
      reject(new Error("cancelled"));
    });
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
          attr: { type: q.secret ? "password" : "text", placeholder: "Type your answer…" },
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
    if (this.galleryEl) return; // hidden behind a full-pane overlay
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
    if (on) {
      // A resumed turn on an archived chat auto-un-archives it (Session Cockpit
      // R6): never leave a live, token-burning turn invisible on the board.
      if (c.archived) c.archived = false;
      this.plugin.emitConvoState(c.id, "turn-start"); // fire-and-forget board hook (no-op when off; can't throw)
    }
    if (c === this.active) this.syncSendButton();
    this.refreshAgentIndicators(); // per-tab streaming dot + agent counts + pinned chip
    // Never show the tail "Related" section mid-stream — hide it the instant a
    // turn starts. The turn-end path (runTurn's `finally`) is responsible for
    // re-showing it once the queue is fully drained.
    if (on) {
      c.tailSurfaceEl?.remove();
      c.tailSurfaceEl = null;
    }
    // Both directions. `refreshAgentIndicators` above happens to repaint the
    // strip too, but relying on that is exactly the incidental coupling that
    // left the pulse stale: streaming is a fact the strip renders, so
    // `setStreaming` owns repainting it. The second pass compares signatures
    // and writes no DOM.
    this.refreshTabs();
  }

  /** The single mutation point for a conversation's open-card cancel handles.
   *  `needsInput` is a fact the strip renders, so every set AND every clear has
   *  to repaint — and there are nine assignment sites across the permission,
   *  plan and ask cards plus the turn teardown, far too many to sprinkle
   *  repaints over. Routing them through here means a future card cannot forget.
   *  The two construction sites (`makeConvo`, `restore`) stay literal: a
   *  conversation being built has no tab to repaint yet. */
  private setPendingCard(c: Convo, kind: "perm" | "ask", cancel: (() => void) | null): void {
    if (kind === "perm") c.pendingPerm = cancel;
    else c.pendingAsk = cancel;
    this.refreshTabs();
  }

  /** Terminal live-task rows linger this long before eviction, so a
   *  done/error/stopped entry is visible rather than vanishing instantly. */
  private static readonly LIVE_FADE_MS = 2000;

  /** How many background agents a conversation owns RIGHT NOW: every live task
   *  tracked on the convo — subagents, background Bash, and Workflow runs —
   *  regardless of whether the turn that spawned them is still streaming. Read
   *  from `Convo.liveTasks` (not the live turn context), so the chip survives
   *  turn end while the work itself is still going (keep-alive L1). */
  private agentCount(c: Convo): number {
    return c.liveTasks.size;
  }

  /** Insert or update a live task on a convo and refresh the chip. The single
   *  mutation point so the count/label and any open popover stay in sync. */
  private liveUpsert(c: Convo, rec: LiveTaskRecord): void {
    c.liveTasks.set(rec.id, rec);
    this.refreshAgentIndicators();
    this.renderAgentPopover();
  }

  /** Mark a live task terminal (done/error/stopped), stamp `doneAt`, and schedule
   *  its eviction after the fade window so the row lingers briefly then leaves. */
  private liveStatus(c: Convo, id: string, status: LiveTaskStatus): void {
    const rec = c.liveTasks.get(id);
    if (!rec) return;
    rec.status = status;
    rec.doneAt = Date.now();
    this.refreshAgentIndicators();
    this.renderAgentPopover();
    if (status !== "running") {
      window.setTimeout(() => this.liveRemove(c, id), ChatView.LIVE_FADE_MS);
    }
  }

  /** Evict a live task and refresh the chip. */
  private liveRemove(c: Convo, id: string): void {
    if (c.liveTasks.delete(id)) {
      this.refreshAgentIndicators();
      this.renderAgentPopover();
    }
  }

  /** (Re)draw the popover rows from the active convo's live tasks. No-op when the
   *  popover is closed; auto-closes when the list empties. */
  private renderAgentPopover(): void {
    const pop = this.agentPopoverEl;
    if (!pop) return;
    const c = this.active;
    const tasks = c ? [...c.liveTasks.values()] : [];
    if (!tasks.length) {
      this.closeAgentPopover();
      return;
    }
    pop.empty();
    for (const rec of tasks) {
      const row = pop.createDiv({ cls: "mva-agents-row" });
      row.createSpan({ cls: `mva-subagent-dot ${liveTaskDotClass(rec.status)}` });
      row.createSpan({ cls: "mva-agents-row-label", text: rec.label });
      row.createSpan({ cls: "mva-agents-row-status", text: liveTaskStatusText(rec.status) });
      this.clickable(row, (e) => {
        e.stopPropagation();
        this.jumpToLiveTask(rec);
      });
      const x = row.createSpan({ cls: "mva-agents-row-x" });
      setIcon(x, "x");
      this.clickable(x, (e) => {
        e.stopPropagation();
        if (c) this.liveRemove(c, rec.id);
      });
    }
  }

  /** Scroll the task's card into view, flash it, and close the popover. */
  private jumpToLiveTask(rec: LiveTaskRecord): void {
    this.closeAgentPopover();
    if (!rec.cardEl.isConnected) return; // card was cleaned (old turn) — nothing to show
    rec.cardEl.scrollIntoView({ block: "center", behavior: "smooth" });
    this.flashCard(rec.cardEl);
  }

  /** Transient highlight so the eye lands on the right card after a jump. */
  private flashCard(el: HTMLElement): void {
    el.addClass("mva-flash");
    window.setTimeout(() => el.removeClass("mva-flash"), 1000);
  }

  /** Turn-start reconciliation: drop live tasks whose card was cleaned (orphaned by
   *  a finished turn) or whose terminal fade window has elapsed. The keep-alive L1
   *  backstop — without a session-level event pump (L2, out of scope), a task that
   *  finished with no active stream can't self-clear; this sweeps it on the next turn. */
  private reconcileLiveTasks(c: Convo): void {
    let changed = false;
    for (const [id, rec] of c.liveTasks) {
      if (!rec.cardEl.isConnected) {
        c.liveTasks.delete(id);
        changed = true;
      }
    }
    for (const id of fadedTaskIds([...c.liveTasks.values()], Date.now(), ChatView.LIVE_FADE_MS)) {
      c.liveTasks.delete(id);
      changed = true;
    }
    if (changed) {
      this.refreshAgentIndicators();
      this.renderAgentPopover();
    }
  }

  /** Refresh both per-chat agent affordances: the per-tab count badges (via
   *  renderTabs) and the pinned chip above the composer, which reflects ONLY the
   *  open chat's own agents. Strictly local — a background chat's work never leaks
   *  into the chat you're looking at; you see its count on its own tab. Label and
   *  spinner come from the core `summarizeLiveTasks` projection, so terminal
   *  (fading) rows still count until evicted by `liveRemove`. */
  private refreshAgentIndicators(): void {
    this.refreshTabs(); // the count is a rendered fact: a state transition
    const chip = this.agentChipEl;
    if (!chip) return;
    chip.empty();
    const c = this.active;
    const tasks = c ? [...c.liveTasks.values()] : [];
    const sum = summarizeLiveTasks(tasks);
    chip.toggleClass("is-hidden", sum.count === 0);
    if (sum.count === 0) return;
    const icon = chip.createSpan({ cls: "mva-agents-icon" });
    icon.toggleClass("is-idle", !sum.spinner); // stop the spin when nothing runs
    setIcon(icon, sum.spinner ? "loader" : "check");
    chip.createSpan({ cls: "mva-agents-label", text: sum.chipLabel });
    setIcon(chip.createSpan({ cls: "mva-agents-caret" }), "chevron-up");
    if (this.agentPopoverEl) chip.appendChild(this.agentPopoverEl);
  }

  /** Toggle the enumerable list of this chat's live tasks, anchored above the chip. */
  private toggleAgentPopover(): void {
    if (this.agentPopoverEl) {
      this.closeAgentPopover();
      return;
    }
    if (!this.agentChipEl || !this.active?.liveTasks.size) return;
    const pop = this.agentChipEl.createDiv({ cls: "mva-agents-list" });
    this.agentPopoverEl = pop;
    this.renderAgentPopover();
    // Close on outside click / Esc (registered next tick so THIS click doesn't fire it).
    window.setTimeout(() => {
      document.addEventListener("click", this.onAgentPopoverOutside);
      document.addEventListener("keydown", this.onAgentPopoverKey);
    }, 0);
  }

  private closeAgentPopover(): void {
    this.agentPopoverEl?.remove();
    this.agentPopoverEl = null;
    document.removeEventListener("click", this.onAgentPopoverOutside);
    document.removeEventListener("keydown", this.onAgentPopoverKey);
  }

  private onAgentPopoverOutside = (e: MouseEvent): void => {
    if (this.agentChipEl && !this.agentChipEl.contains(e.target as Node)) this.closeAgentPopover();
  };

  private onAgentPopoverKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.closeAgentPopover();
  };

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
    // `/goal` is a built-in the SDK doesn't expand — handle it client-side like
    // /compact. First hoist a mid-message /goal to the front (completes the
    // known-command hoisting from 6a5998a), so "fix all tests\n/goal" becomes
    // "/goal fix all tests" and the surrounding text is the condition.
    const hoisted = hoistSlashCommand(text, new Set(["goal"]));
    if (hoisted === "/goal" || hoisted.startsWith("/goal ")) {
      this.composer.setInputValue("");
      this.composer.autoGrow();
      this.handleGoalCommand(c, hoisted);
      return;
    }
    // `/as <agent>` binds the whole conversation to a named agent (client-side,
    // like /compact and /goal — the CLI has no such command).
    const agentCommand = parseAgentCommand(text);
    if (agentCommand) {
      this.composer.setInputValue("");
      this.composer.autoGrow();
      void this.applyAgentCommand(c, agentCommand);
      return;
    }
    // A `@agent` pick in the composer binds THIS turn only; `/as` binds the tab.
    const agentForTurn = this.composer.takePendingAgent() ?? undefined;
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
      // turn. The provider's steer() owns the capability contract; both
      // providers return false when images are attached, so the shared path stays
      // provider-agnostic. A false return or a throw falls back to queue.
      let steered = false;
      if (!c.researchMode.enabled && this.plugin.settings.steerMode === "steer") {
        try {
          steered = c.session?.steer?.(this.hoistOutbound(text), images) ?? false;
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
          agent: agentForTurn,
        });
        this.renderQueue(c);
      }
    } else {
      const turnOpts = handoff || researchModeForTurn || agentForTurn
        ? { sendPrefix: handoff, researchMode: researchModeForTurn, agent: agentForTurn }
        : undefined;
      void this.runTurn(c, text, images, turnOpts);
    }
  }

  /**
   * Apply `/as <agent>` — bind or clear this conversation's agent.
   *
   * Binding is provider-only: it changes what rides the outbound turn, never
   * `SessionOpts`. That is why it needs no `sessionSigOf()` entry and can never
   * force a session respawn mid-conversation.
   */
  private async applyAgentCommand(c: Convo, cmd: AgentCommandResult): Promise<void> {
    if (cmd.kind === "invalid") {
      new Notice(cmd.message);
      this.composer.focusInput();
      return;
    }
    if (cmd.kind === "clear") {
      c.agent = undefined;
      this.composer.refreshAgentChip();
      this.persist();
      new Notice("Agent binding cleared");
      return;
    }
    if (!(await this.plugin.agentsReady())) {
      new Notice("Named agents are off — enable them in Exo settings.");
      return;
    }
    const found = this.plugin.agentStore.resolve(cmd.query);
    if (!found) {
      new Notice(`No agent named "${cmd.query}".`);
      this.composer.focusInput();
      return;
    }
    c.agent = found.brain.slug;
    this.composer.refreshAgentChip();
    this.persist();
    new Notice(`Bound to ${found.brain.name} — every turn in this chat routes to it.`);
    this.composer.focusInput();
  }

  /** Drop the active conversation's `/as` binding (composer chip click). */
  clearBoundAgent(): void {
    const c = this.active;
    if (!c.agent) return;
    c.agent = undefined;
    this.composer.refreshAgentChip();
    this.persist();
  }

  /** Resolve the agent a turn is bound to (per-turn `@` pick wins over `/as`).
   *  Returns null whenever the feature is off or the slug no longer resolves —
   *  a renamed or deleted agent degrades to a normal turn, never an error. */
  private async resolveTurnAgent(c: Convo, perTurn?: string): Promise<AgentDef | null> {
    const slug = perTurn ?? c.agent;
    if (!slug) return null;
    if (!(await this.plugin.agentsReady())) return null;
    return this.plugin.agentStore.resolve(slug);
  }

  /** Client-side `/goal` handler shared by both providers. */
  handleGoalCommand(c: Convo, text: string): void {
    if (!this.plugin.settings.enableGoal) {
      new Notice("The /goal command is disabled in settings.");
      return;
    }
    const arg = text.slice("/goal".length).trim();
    const CLEAR = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);
    if (!arg) {
      // Status query, mirroring the native no-arg behavior.
      if (c.goal && c.goal.status !== "idle") {
        new Notice(`Goal active: "${c.goal.condition}" · run ${c.goal.windowRuns}/${c.goal.maxIterations}`);
      } else {
        new Notice("No goal set. Usage: /goal <condition>");
      }
      return;
    }
    if (CLEAR.has(arg.toLowerCase())) {
      if (c.goal) c.goal = clearGoal(c.goal);
      this.composer.refreshGoal(c);
      new Notice("Goal cleared.");
      return;
    }
    if (c.streaming) {
      new Notice("Wait for the current turn to finish, then set a goal.");
      return;
    }
    c.goal = setGoal(arg, this.plugin.settings.goalMaxIterations, Date.now());
    this.composer.refreshGoal(c);
    // Kick off the first working turn toward the condition.
    void this.runTurn(c, arg);
  }

  /** Called once per clean turn end. Records the turn against the active goal
   *  and either queues a continuation, pauses for confirmation, or clears.
   *  A user-queued message takes precedence and cancels the goal. */
  private advanceGoal(c: Convo, assistantText: string): void {
    if (!c.goal || c.goal.status === "idle" || c.goal.status === "met") return;
    // Human input wins: if the user queued their own message during the turn,
    // stop the auto-loop and let their message run.
    // Invariant: at turn-end c.queue holds only USER-queued messages (the goal's
    // own continuation is pushed below, after this check; recovery retries are
    // gated out by the !poisoned caller). If that ever changes, this precedence
    // check would misread a system-queued item as user input and kill the goal.
    if (c.queue.length) {
      c.goal = clearGoal(c.goal);
      this.composer.refreshGoal(c);
      return;
    }
    const { next, action } = advance(c.goal, assistantText);
    c.goal = next;
    if (action === "continue") {
      c.queue.push({ text: buildContinuationPrompt(next.condition) });
    }
    this.composer.refreshGoal(c);
  }

  /** Continue a paused goal for another window (the pill's "Continue +N"). */
  resumeGoalLoop(c: Convo): void {
    if (!c.goal || c.goal.status !== "paused") return;
    if (c.streaming) {
      new Notice("Wait for the current turn to finish, then continue the goal.");
      return;
    }
    c.goal = resumeGoal(c.goal);
    this.composer.refreshGoal(c);
    void this.runTurn(c, buildContinuationPrompt(c.goal.condition));
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

  /** TUI parity: the CLI only expands /commands that OPEN the message, so a
   *  known command typed mid/end-message ("do X\n/goal") is hoisted to the
   *  front — but ONLY in the outbound payload. The bubble and history keep
   *  what the user actually typed, the same contract as sendPrefix and
   *  recall blocks (payload-only riders). */
  private hoistOutbound(text: string): string {
    const caps = this.sessionCaps ?? this.plugin.lastSessionCaps;
    return caps?.commands?.length ? hoistSlashCommand(text, new Set(caps.commands)) : text;
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
      /** Agent slug bound to THIS turn (a `@agent` pick), overriding `c.agent`. */
      agent?: string;
    }
  ): Promise<void> {
    const researchMode = opts?.researchMode ?? c.researchMode;
    // Resolved before the session work below so a missing/renamed agent simply
    // yields null and the turn proceeds as normal chat.
    const boundAgent = await this.resolveTurnAgent(c, opts?.agent);
    const sendText = this.hoistOutbound(text);
    // Active-context assembly (2026-07-30): attached-note paths AND the ambient
    // selection the chip is showing — both read from the same composer state the
    // UI renders from, so what the user sees is exactly what the model receives.
    // Optionally inline note bodies so open pages are read, not just referenced.
    // Only the active convo owns the composer, so a background turn carries none.
    const isActiveConvo = c === this.active;
    const paths = isActiveConvo ? this.composer.contextPaths() : [];
    const selection = isActiveConvo ? this.composer.contextSelection() : null;
    const injectContent = this.plugin.settings.injectContextContent;
    let contents: Record<string, string> | undefined;
    if (injectContent && paths.length) {
      contents = {};
      for (const p of paths) {
        const f = this.app.vault.getAbstractFileByPath(p);
        if (f instanceof TFile) {
          try {
            contents[p] = await this.app.vault.cachedRead(f);
          } catch {
            /* missing → assembleContext degrades this path to a bare-path line */
          }
        }
      }
    }
    const assembled = assembleContext({ paths, selection, injectContent, contents });
    const message = assembled.block ? `${assembled.block}\n\n${sendText}` : sendText;
    if (this.plugin.settings.debugContext && isActiveConvo) {
      const chips = this.composer.contextChips();
      console.info(
        formatContextDebug({
          turnLabel: `${c.id.slice(0, 6)}#${c.messages.length}`,
          chips: { doc: chips.doc, manual: chips.manual, selectionChars: selection?.text.length ?? null },
          assembled,
          outboundBytes: new TextEncoder().encode(message).length,
        })
      );
    }

    // Images flow to both providers: Claude gets base64 blocks; Codex's
    // app-server gets temporary local-image paths (handled in the adapter).
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
    this.reconcileLiveTasks(c); // drop orphaned/faded entries before this turn adds new ones
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
    // Live workflow runs this turn, keyed by the launching Workflow tool_use id.
    // Fed by system/task_* events (the only window into background workflow
    // agents — they never surface as tool calls) and rendered as a status line
    // on the Workflow card.
    const workflowRuns = new Map<string, WorkflowRun>();

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
            if (isSubagentTool(e.name)) {
              this.registerTaskCard(ctx, e.id);
              ctx.runningTasks.add(e.id); // subagent in flight → counts as a running agent
              const subCard = ctx.cards.get(e.id)?.card;
              if (subCard) {
                const m = toolMeta(e.name, e.input);
                this.liveUpsert(c, {
                  id: e.id,
                  kind: "subagent",
                  label: m.target || m.label, // description if present, else "Subagent"
                  status: "running",
                  startedAt: Date.now(),
                  cardEl: subCard,
                });
              }
            }
            this.trackBackgroundTask(ctx, e.id, e.name, e.input);
            const bg = ctx.bgTasks.get(e.id);
            if (bg) {
              const m = toolMeta(e.name, e.input);
              this.liveUpsert(c, {
                id: e.id,
                kind: "bash",
                label: m.target || "background task",
                status: "running",
                startedAt: Date.now(),
                cardEl: bg.cardEl,
              });
            }
            // A flat, note-touching card is streaming-only feedback — dropped at
            // turn end once the touched-notes footer carries the same fact.
            if (uniquePaths.length) ctx.noteTouchIds.add(e.id);
            // Update the per-chat agent count when a subagent or a background shell
            // just launched (trackBackgroundTask records bg shells in ctx.bgTasks).
            if (isSubagentTool(e.name) || ctx.bgTasks.has(e.id)) this.refreshAgentIndicators();
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
            // A subagent finished → transition its live-task row to terminal
            // (delete returns true only when it was a tracked Task, so plain
            // tools don't refresh). liveStatus refreshes the chip and schedules
            // the fade-out eviction.
            if (ctx.runningTasks.delete(e.id)) {
              this.liveStatus(c, e.id, e.ok ? "done" : "error");
            }
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
          // The badge/popover are single view-level controls, so only the active
          // convo's native quota snapshot drives them. Late reads (tab switch)
          // come from session.rateLimit.
          this.plugin.lastRateLimit = {
            status: e.status,
            utilization: e.utilization,
            resetsAt: e.resetsAt,
            windowType: e.windowType,
            ...(e.windows?.length ? { windows: e.windows } : {}),
            ...(e.planType ? { planType: e.planType } : {}),
          };
          if (c === this.active) {
            this.composer.setLastRateLimit({
              status: e.status,
              utilization: e.utilization,
              resetsAt: e.resetsAt,
              windowType: e.windowType,
              ...(e.windows?.length ? { windows: e.windows } : {}),
              ...(e.planType ? { planType: e.planType } : {}),
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
        case "workflow-progress": {
          let run = workflowRuns.get(e.toolUseId);
          if (!run) {
            run = createWorkflowRun(e.taskId, e.toolUseId, e.name);
            workflowRuns.set(e.toolUseId, run);
            this.diag.push("tool", `workflow ${e.name ?? e.taskId} started`);
          }
          if (e.status) run.status = e.status;
          applyWorkflowProgress(run, e.entries);
          const refs = ctx.cards.get(e.toolUseId);
          if (refs) {
            if (!refs.wfEl) {
              refs.wfEl = createSpan({ cls: "mva-tool-wf" });
              refs.statusEl.parentElement?.insertBefore(refs.wfEl, refs.elapsedEl);
            }
            refs.wfEl.setText(summarizeWorkflowRun(run).label);
            const wfStatus: LiveTaskStatus =
              run.status === "completed" ? "done" : run.status === "failed" ? "error" : "running";
            this.liveUpsert(c, {
              id: e.toolUseId,
              kind: "workflow",
              label: `${run.name ?? "workflow"} · ${summarizeWorkflowRun(run).label}`,
              status: wfStatus,
              startedAt: c.liveTasks.get(e.toolUseId)?.startedAt ?? Date.now(),
              cardEl: refs.card,
            });
          }
          break;
        }
        case "turn-end":
          this.diag.push("turn", `result session=${e.sessionId ? e.sessionId.slice(0, 8) : "?"}`);
          if (e.sessionId) c.sessionId = e.sessionId;
          break;
        case "notice":
          // Non-fatal in-band notice (e.g. Codex skills-budget). Render it as a
          // quiet faint line and persist it, but DON'T touch the text stream,
          // working row, or `poisoned` — the turn continues and its real answer
          // must survive. (This is the fix for Codex "not responding" when many
          // skills are installed: the benign notice used to poison the turn.)
          this.diag.push("notice", e.message);
          ctx.bodyEl.createDiv({ cls: "mva-faint mva-notice", text: e.message });
          ctx.segments.push({ t: "notice", message: e.message });
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
      // sendPrefix (recovery recap) and the proactive-recall block are prepended to
      // the OUTBOUND provider message only — never to the rendered/persisted user
      // text, so they can't leak into the transcript, c.messages, or serialize().
      // Order: recap (if any) -> recalled memory -> research contract -> the
      // user's message.
      const recallBlock = recalled.length ? this.formatRecallBlock(recalled) : "";
      // Cold-spawn rehydration: a session spawned with no resumable session starts
      // on an EMPTY CLI transcript, so a "continua/riprendi" has nothing to continue
      // — the model forages the vault (session-log, open-items) to reconstruct
      // "which conversation" instead of reading THIS thread. Whenever we spawn cold but the
      // convo already carries real history, reseed it with the same recap the
      // stage-2 recovery uses. This generalizes that narrow path to close every
      // cold-start hole (poisoned-and-stopped, nuclear reset, fresh process after a
      // crash) with one invariant — including the quiet one: the convo still holds
      // a sessionId but the CLI already expired the session file behind it, so the
      // resume lands on nothing. Skipped when a stage-2 recap prefix is already
      // present (never double) and on a convo's first turn (no prior message).
      const coldRecap = shouldColdReseed({
        hasResumableSession: this.isSessionResumable(c),
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
      // The agent binding wraps LAST so its instruction sits closest to the
      // user's text — and, like Research Mode, it never touches the visible or
      // persisted bubble.
      const agentMessage = boundAgent ? buildAgentBindingOutbound(boundAgent, researchMessage, c.provider) : researchMessage;
      const outbound = [opts?.sendPrefix, coldRecap, compactPrefix, recallBlock, agentMessage].filter(Boolean).join("\n\n");
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
          // Workflow Foundry records privacy-safe deterministic metadata and,
          // once a workflow recurs to threshold, distills an editable playbook
          // proposal through the Proposal Kernel. It never delays this turn.
          this.maybeRecordWorkflowSignal(ctx, c, !!opts?.isRecoveryRetry);
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
      this.setPendingCard(c, "perm", null);
      c.pendingAsk?.();
      this.setPendingCard(c, "ask", null);
      c.currentCtx = null; // this turn is over — late ask_user calls reject cleanly
      // Confirm a user-initiated stop — ALWAYS, even mid-work. A turn that had
      // already streamed text/tool cards used to end with zero feedback when
      // stopped (guarded on "nothing rendered"), which read as "Exo è bloccato":
      // the user couldn't tell an aborted turn from one still thinking.
      if (c.stopped && !ctx.el.querySelector(".mva-faint, .mva-inline-error, .mva-onboard")) {
        ctx.el.addClass("mva-aborted");
        ctx.bodyEl.createSpan({ cls: "mva-faint", text: "Stopped." });
      }
      if (ctx.segments.length) {
        c.messages.push({
          role: "assistant",
          segments: ctx.segments,
          ...(checkpoint.size ? { checkpoint } : {}),
        });
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
      // A turn that finished somewhere you were not looking is the one fact the
      // strip cannot recover later: the transcript keeps the answer, but not
      // that you never saw it arrive. Cleared the moment the tab is focused.
      if (c !== this.active) c.unread = true;
      this.refreshTabs();
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
      // An assistant turn just landed → refine the auto-derived tab title with a
      // Haiku-generated one (fire-and-forget). Placed AFTER the recovery ladder
      // so a recoverable-but-poisoned turn (which triggers dropSession → aborts
      // titleAbort) still gets titled — the exchange is valid.
      // Up to `isAiTitleDue`'s max (2): the first attempt fires after the first
      // assistant turn; if it timed out/errored and the title is still not
      // `aiTitleApplied`, one more attempt is allowed after a later turn. Once a
      // real title lands, `aiTitleApplied` blocks any further attempt — a title
      // that IS AI-authored is never overwritten.
      if (
        this.plugin.settings.aiTitles &&
        isAiTitleDue({ attempts: c.aiTitleAttempts ?? 0, applied: !!c.aiTitleApplied }) &&
        c.messages.length >= 2 &&
        c.messages[c.messages.length - 2]?.role === "user" &&
        c.messages[c.messages.length - 1]?.role === "assistant" &&
        ctx.fullText.trim()
      ) {
        c.aiTitleAttempts = (c.aiTitleAttempts ?? 0) + 1; // counts fires, not successes
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
      // Goal loop: decide continue/pause/met before draining. On "continue" this
      // pushes the next re-prompt onto c.queue, which the drain below runs.
      if (!poisoned && !c.stopped) this.advanceGoal(c, ctx.fullText);
      // Drain the queue: run the next message in this conversation. A recovery
      // retry item carries sendPrefix/isRecoveryRetry — forward them so the recap
      // reaches the provider and no duplicate user bubble is rendered.
      if (c.queue.length) {
        const next = c.queue.shift()!;
        this.renderQueue(c);
        const retryOpts =
          next.isRecoveryRetry || next.sendPrefix || next.researchMode || next.agent
            ? {
                sendPrefix: next.sendPrefix,
                isRecoveryRetry: next.isRecoveryRetry,
                researchMode: next.researchMode,
                agent: next.agent,
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

  /* ----------------------- workflow foundry ----------------------- */

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
    void (async () => {
      // Dedup at the source: a signature already carried by a pending or accepted
      // playbook proposal never reaches threshold again (Task C).
      const blockedSignatures = await this.plugin.proposalStore
        .blockedWorkflowSignatures()
        .catch(() => new Set<string>());
      const result = await this.plugin.workflowSignalStore.record(signal, now, { threshold, blockedSignatures });
      if (!result.candidate) {
        this.diag.push("foundry", "signal recorded");
        return;
      }
      this.diag.push("foundry", `threshold reached: ${result.candidate.occurrences}`);
      // On-demand distillation through the Proposal Kernel (Task D). The current
      // turn text is passed as transient evidence only — never persisted in the
      // signal ledger. A quiet, typed outcome; failures never touch the turn.
      const outcome = await this.plugin.distillWorkflowPlaybook({
        intent: signal.intent,
        tools: signal.tools,
        outputType,
        occurrences: result.candidate.occurrences,
        workflowSignature: result.candidate.signature,
        userText: ctx.userText,
        responseText: ctx.fullText,
        source: { convoId: c.id, turnId: ctx.turnId, createdAt: now },
      });
      this.diag.push(
        "foundry",
        `distillation: ${outcome.status}${outcome.status === "appended" ? ` (${outcome.proposalId})` : ""}`
      );
    })().catch((error) => {
      console.warn("[Exo] workflow foundry failed (no-op):", error);
    });
  }

  /** Live attention snapshot for the Cockpit: conversations blocked on a
   *  permission/ask card, or currently streaming. Plain data — no DOM refs. */
  convoAttention(): { id: string; title: string; blocked: boolean; streaming: boolean }[] {
    return this.allConvos()
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
    this.switchTo(c);
    return true;
  }

  private vaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    return "";
  }
}
