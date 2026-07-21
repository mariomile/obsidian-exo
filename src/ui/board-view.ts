/**
 * Orchestration Board view (workstream B5) — the visible surface for the task
 * ledger. A full-pane `ItemView` (opens in the MAIN workspace area, not the
 * sidebar) that renders tasks as cards across six columns and drives them via
 * the `OrchestratorDriver`.
 *
 * One-way dependency (hard contract): this module MAY import `./view` (ChatView)
 * but `./view` MUST NOT import this module. The board observes chat; chat never
 * depends on the board. Verified by grep in the brief's acceptance criteria.
 *
 * The board is the ONLY consumer that turns the plugin's injected primitives
 * (`taskStore`, `convoState`, `startTaskConversation`, `readConvoState`) into a
 * running orchestration loop, via the `OrchestratorDriver`.
 */
import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type ExoPlugin from "../main";
import { ADAPTERS } from "../providers/registry";
import type { ProviderId } from "../providers/types";
import { modelOptions } from "../core/model-options";
import type { TaskEntry, TaskStatus } from "../core/tasks";
import {
  projectSessionCards,
  canArchive,
  type SessionCardVM,
  type SessionLane,
  type SessionSnapshot,
} from "../core/session-cards";
import type { InputReason } from "../core/orchestrator";
import { OrchestratorDriver, type DriverDeps } from "../obsidian/orchestrator-driver";
import { clickable } from "./dom";
import { TaskModal } from "./task-modal";

/** The board view type — registered in main.ts, opens in the main pane. */
export const BOARD_VIEW_TYPE = "exo-board";
/** Ribbon/tab icon for the board. */
export const BOARD_ICON = "layout-dashboard";

/** The six visible columns, in order. `archived` is intentionally excluded —
 *  archived tasks keep their block in tasks.md but are hidden from the board. */
const COLUMNS: ReadonlyArray<{ status: TaskStatus; label: string }> = [
  { status: "backlog", label: "Backlog" },
  { status: "queued", label: "Queued" },
  { status: "running", label: "Running" },
  { status: "needs-input", label: "Needs Input" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
];

/** Human label for a needs-input reason badge. */
function reasonLabel(r: InputReason | undefined): string {
  switch (r) {
    case "error":
      return "Error";
    case "stopped":
      return "Stopped";
    case "needs-input":
      return "Waiting";
    default:
      return "Needs input";
  }
}

/** Compact "time since" label (e.g. "3m", "2h", "just now"). */
function timeSince(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** First lines of the prompt for the card preview (collapse blank lines). */
function promptPreview(prompt: string, lines = 3): string {
  return prompt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, lines)
    .join(" ");
}

export class BoardView extends ItemView {
  private driver: OrchestratorDriver | null = null;
  private boardEl!: HTMLElement;
  /** The active drag payload — the task id being dragged. */
  private dragTaskId: string | null = null;
  /** Whether the last store load surfaced malformed-file warnings. */
  private loadWarnings: string[] = [];
  /** Last task list from the driver — kept so a session-card-only rerender
   *  (triggered by convo-state, not a task change) can repaint without a driver
   *  round-trip. */
  private lastTasks: TaskEntry[] = [];
  /** Unsubscribe from the convo-state channel (session-card freshness). */
  private convoUnsub: (() => void) | null = null;
  /** Timer backstop: catches convo lifecycle changes the channel doesn't emit
   *  (e.g. a deleted convo → ghost card), so the board self-heals. */
  private backstop: number | null = null;
  /** Coalesce flag so a burst of convo-state events causes ONE repaint. */
  private rerenderQueued = false;
  /** True while a card context menu is open — suppresses repaints that would
   *  detach the menu's anchor mid-interaction. */
  private menuOpen = false;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ExoPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return BOARD_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Orchestration Board";
  }
  getIcon(): string {
    return BOARD_ICON;
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("mva-root");
    root.addClass("mva-board-root");

    // Flag off but the view is somehow open (stale leaf restored from workspace
    // layout while orchestration is disabled): render a placeholder and stop —
    // never start the driver.
    if (!this.plugin.settings.orchestrationEnabled) {
      this.renderDisabledPlaceholder(root);
      return;
    }

    this.boardEl = root.createDiv({ cls: "mva-board" });

    // Build and start the driver, wiring the plugin's primitives into the
    // injected deps. onChange re-renders; a load with warnings paints an error
    // banner (chat is never affected by this).
    this.driver = new OrchestratorDriver(this.buildDeps());
    // Surface store-load warnings on the board (corrupt/malformed tasks.md).
    const loaded = await this.plugin.taskStore.load();
    this.loadWarnings = loaded.warnings;
    await this.driver.start();
    this.render(this.driver.snapshot());

    // Session Cockpit (U3): project the open ChatView's live chats as cards.
    // Subscribe directly to convo-state so session-card freshness doesn't depend
    // on the driver's task-emit cadence (the driver DOES emit on un-owned convos
    // today, but the board shouldn't rely on that internal). Both paths repaint,
    // so scheduleRerender coalesces. A low-frequency timer backstop catches
    // lifecycle changes the channel never emits (e.g. a deleted convo → ghost).
    this.convoUnsub = this.plugin.onConvoState(() => this.scheduleRerender());
    this.backstop = window.setInterval(() => this.scheduleRerender(), 5000);
  }

  async onClose(): Promise<void> {
    this.convoUnsub?.();
    this.convoUnsub = null;
    if (this.backstop != null) {
      window.clearInterval(this.backstop);
      this.backstop = null;
    }
    this.driver?.stop();
    this.driver = null;
  }

  /** Wire the plugin's primitives into the driver's injected deps. */
  private buildDeps(): DriverDeps {
    const plugin = this.plugin;
    return {
      store: plugin.taskStore,
      subscribe: (listener) => plugin.onConvoState(listener),
      spawn: (prompt, opts) => plugin.startTaskConversation(prompt, opts),
      liveness: (convoId) => {
        const s = plugin.readConvoState(convoId);
        return { exists: s.exists, streaming: s.streaming, pendingRequest: s.hasPending };
      },
      config: () => ({ maxConcurrent: Math.max(1, plugin.settings.orchestrationMaxConcurrent) }),
      notify: (message) => new Notice(message),
      onChange: (tasks) => this.render(tasks),
    };
  }

  // --- Rendering ----------------------------------------------------------

  private renderDisabledPlaceholder(root: HTMLElement): void {
    const wrap = root.createDiv({ cls: "mva-board-placeholder" });
    setIcon(wrap.createDiv({ cls: "mva-board-placeholder-icon" }), BOARD_ICON);
    wrap.createEl("h3", { text: "Orchestration is off" });
    wrap.createEl("p", {
      text: "Turn on the Orchestration Board in Exo settings to queue and run tasks as separate conversations.",
    });
  }

  /** Task-driven render entry point (driver onChange / onOpen / reloadTasks):
   *  store the fresh task list, then paint. Session-card-only refreshes call
   *  `paint()` directly through `scheduleRerender`. */
  private render(tasks: TaskEntry[]): void {
    this.lastTasks = tasks;
    this.paint();
  }

  /** Coalesced, gesture-safe repaint for session-card freshness. A burst of
   *  convo-state events collapses to one paint; the paint is dropped while a
   *  drag or a card menu is in flight (it would detach the drop target / menu
   *  anchor) — the timer backstop and the dragend/menu-close handlers catch up. */
  private scheduleRerender(): void {
    if (this.rerenderQueued) return;
    this.rerenderQueued = true;
    queueMicrotask(() => {
      this.rerenderQueued = false;
      if (this.dragTaskId != null || this.menuOpen) return;
      this.paint();
    });
  }

  private paint(): void {
    if (!this.boardEl) return;
    // Preserve scroll across the full repaint — otherwise every convo-state event
    // / backstop tick rebuilds the DOM and snaps the board back to the leftmost
    // (Backlog) column while the user is scrolling.
    const prevCols = this.boardEl.querySelector(".mva-board-cols") as HTMLElement | null;
    const savedLeft = prevCols?.scrollLeft ?? this.boardEl.scrollLeft;
    const savedTop = prevCols?.scrollTop ?? this.boardEl.scrollTop;
    this.boardEl.empty();

    // Corrupt/malformed tasks.md → an error banner on the BOARD only. Chat is
    // untouched (it never reads this file). This is a notice, not a blocker —
    // the parsed-tolerantly tasks still render below.
    if (this.loadWarnings.length) {
      const banner = this.boardEl.createDiv({ cls: "mva-board-error" });
      setIcon(banner.createSpan({ cls: "mva-board-error-icon" }), "alert-triangle");
      banner.createSpan({
        text: `Some tasks in the ledger look malformed (${this.loadWarnings.length}). They're shown as best-effort; check _system/orchestration/tasks.md.`,
      });
    }

    const cols = this.boardEl.createDiv({ cls: "mva-board-cols" });
    const now = Date.now();
    // Session-cards: the open ChatView's live chats, deduped against task-owned
    // convos. Empty when no ChatView leaf is open (the "leaf open" scope).
    const sessions = projectSessionCards(this.plugin.listSessionSnapshots(), this.lastTasks);
    for (const col of COLUMNS) {
      const inCol = this.lastTasks
        .filter((t) => t.status === col.status)
        .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
      const sess = sessions.filter((s) => s.lane === (col.status as SessionLane));
      this.renderColumn(cols, col.status, col.label, inCol, sess, now);
    }
    // Restore the pre-repaint scroll (set on both the cols container and the board
    // root — whichever actually scrolls; the other is a harmless no-op).
    cols.scrollLeft = savedLeft;
    cols.scrollTop = savedTop;
    this.boardEl.scrollLeft = savedLeft;
    this.boardEl.scrollTop = savedTop;
  }

  private renderColumn(
    parent: HTMLElement,
    status: TaskStatus,
    label: string,
    tasks: TaskEntry[],
    sessions: SessionCardVM[],
    now: number
  ): void {
    const colEl = parent.createDiv({ cls: "mva-board-col" });
    colEl.dataset.status = status;
    const head = colEl.createDiv({ cls: "mva-board-col-head" });
    head.createSpan({ cls: "mva-board-col-title", text: label });
    head.createSpan({ cls: "mva-board-col-count", text: String(tasks.length + sessions.length) });

    // Task creation goes through the full TaskModal (replaced the old inline
    // quick-add form) — a "+" button in the Backlog column header opens it.
    if (status === "backlog") {
      const addBtn = head.createEl("button", {
        cls: "mva-board-col-add",
        attr: { "aria-label": "New task" },
      });
      setIcon(addBtn, "plus");
      addBtn.addEventListener("click", () => this.openTaskModal());
    }

    // Retrieve archived chats from the Review column header (they conceptually
    // leave the board from review). Only shown when there are archived chats.
    if (status === "review") {
      const archived = this.plugin.listSessionSnapshots().filter((s) => s.archived);
      if (archived.length) {
        const btn = head.createEl("button", {
          cls: "mva-board-col-add",
          attr: { "aria-label": `Show ${archived.length} archived chat(s)` },
        });
        setIcon(btn, "archive");
        btn.addEventListener("click", (e) => this.showArchivedMenu(e, archived));
      }
    }

    const list = colEl.createDiv({ cls: "mva-board-col-list" });

    // Column is a drop target: dropping over empty space appends to the end.
    this.wireColumnDrop(list, status, tasks);

    for (const t of tasks) this.renderCard(list, t, now);
    // Session-cards render after task-cards in the same lane (running /
    // needs-input / review only). They are a live projection, not reorderable.
    for (const s of sessions) this.renderSessionCard(list, s, now);
  }

  private renderCard(parent: HTMLElement, task: TaskEntry, now: number): void {
    const card = parent.createDiv({ cls: "mva-board-card" });
    card.dataset.taskId = task.id;
    card.draggable = true;
    if (task.status === "running") card.addClass("is-running");
    if (task.chatMissing) card.addClass("is-chat-missing");

    // Drag source.
    card.addEventListener("dragstart", (e) => {
      this.dragTaskId = task.id;
      card.addClass("is-dragging");
      e.dataTransfer?.setData("text/plain", task.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      this.dragTaskId = null;
      card.removeClass("is-dragging");
      // Catch up any session-card repaint that was suppressed during the drag.
      this.scheduleRerender();
    });
    // Drop onto another card = reorder before it (or move into this column).
    this.wireCardDrop(card, task);

    // Header row: title + model chip.
    const header = card.createDiv({ cls: "mva-board-card-head" });
    header.createSpan({ cls: "mva-board-card-title", text: task.title || "(untitled)" });

    const chips = card.createDiv({ cls: "mva-board-card-chips" });
    const model = task.model ?? this.defaultModel();
    chips.createSpan({ cls: "mva-board-chip mva-board-chip-model", text: model });

    // Live status dot (pulses via CSS while running).
    if (task.status === "running") {
      const dot = chips.createSpan({ cls: "mva-board-dot" });
      dot.setAttribute("aria-label", "streaming");
    }
    // Needs-input reason badge.
    if (task.status === "needs-input") {
      chips.createSpan({ cls: "mva-board-chip mva-board-chip-reason", text: reasonLabel(task.inputReason) });
    }
    // Chat-missing badge (reconciliation found the recorded convo gone).
    if (task.chatMissing) {
      chips.createSpan({ cls: "mva-board-chip mva-board-chip-missing", text: "chat missing" });
    }
    // Time since last update.
    const since = timeSince(task.updated, now);
    if (since) chips.createSpan({ cls: "mva-board-card-time", text: since });

    // Prompt preview.
    const preview = promptPreview(task.prompt);
    if (preview) card.createDiv({ cls: "mva-board-card-preview", text: preview });

    // Click reveals/focuses this task's chat (if it has spawned a convo).
    clickable(card, (e) => {
      // Ignore clicks that originate on the quick-add or drag handle interactions.
      if ((e.target as HTMLElement).closest("input, textarea, select, button")) return;
      this.onCardClick(task);
    });

    // Context menu.
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showCardMenu(e, task);
    });
  }

  /** Render a session-card: the live projection of an open ad-hoc chat. Unlike a
   *  task-card it is not draggable (it has no ledger order) and carries no model
   *  chip; its lane already encodes the runtime state, plus an optional
   *  stopped/error badge. Click reveals the chat (U4). Context menu (archive) is
   *  added in U6. */
  private renderSessionCard(parent: HTMLElement, vm: SessionCardVM, now: number): void {
    const card = parent.createDiv({ cls: "mva-board-card is-session" });
    card.dataset.convoId = vm.id;

    const header = card.createDiv({ cls: "mva-board-card-head" });
    header.createSpan({ cls: "mva-board-card-title", text: vm.title || "(untitled chat)" });

    const chips = card.createDiv({ cls: "mva-board-card-chips" });
    if (vm.lane === "running") {
      chips.createSpan({ cls: "mva-board-dot" }).setAttribute("aria-label", "streaming");
    }
    if (vm.lane === "needs-input") {
      chips.createSpan({
        cls: "mva-board-chip mva-board-chip-reason",
        text: vm.reason === "perm" ? "Permission" : "Question",
      });
    }
    if (vm.badge) {
      chips.createSpan({
        cls: `mva-board-chip ${vm.badge === "error" ? "mva-board-chip-missing" : "mva-board-chip-reason"}`,
        text: vm.badge === "error" ? "Error" : "Stopped",
      });
    }
    if (vm.updatedAt) {
      const since = timeSince(new Date(vm.updatedAt).toISOString(), now);
      if (since) chips.createSpan({ cls: "mva-board-card-time", text: since });
    }

    clickable(card, (e) => {
      if ((e.target as HTMLElement).closest("input, textarea, select, button")) return;
      void this.onSessionCardClick(vm);
    });

    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showSessionCardMenu(e, vm);
    });
  }

  /** Reveal a session-card's chat. `plugin.revealConversation` already re-opens
   *  the ChatView leaf if it was closed, so no extra "ensure" step is needed. */
  private async onSessionCardClick(vm: SessionCardVM): Promise<void> {
    const ok = await this.plugin.revealConversation(vm.id);
    if (!ok) new Notice("That chat is no longer open.");
  }

  /** Context menu for a session-card: open the chat, and archive it — but only
   *  from the `review` lane (a running/needs-input chat can't be archived, or its
   *  live turn would vanish from the board). */
  private showSessionCardMenu(e: MouseEvent, vm: SessionCardVM): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle("Open chat")
        .setIcon("message-square")
        .onClick(() => void this.onSessionCardClick(vm))
    );
    if (canArchive(vm.lane)) {
      menu.addItem((i) =>
        i
          .setTitle("Archive")
          .setIcon("archive")
          .onClick(() => {
            if (this.plugin.setConvoArchived(vm.id, true)) this.scheduleRerender();
          })
      );
    }
    this.menuOpen = true;
    menu.onHide(() => {
      this.menuOpen = false;
      this.scheduleRerender();
    });
    menu.showAtMouseEvent(e);
  }

  /** "Show archived" affordance (Review column header): list archived chats.
   *  Clicking one reveals it (resuming a turn there auto-un-archives it); a bulk
   *  "Un-archive" restores them to the board's active lanes. */
  private showArchivedMenu(e: MouseEvent, archived: SessionSnapshot[]): void {
    const menu = new Menu();
    for (const s of archived) {
      menu.addItem((i) =>
        i
          .setTitle(s.title || "(untitled chat)")
          .setIcon("message-square")
          .onClick(() => void this.plugin.revealConversation(s.id))
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle(archived.length === 1 ? "Un-archive" : "Un-archive all")
        .setIcon("archive-restore")
        .onClick(() => {
          let any = false;
          for (const s of archived) any = this.plugin.setConvoArchived(s.id, false) || any;
          if (any) this.scheduleRerender();
        })
    );
    menu.showAtMouseEvent(e);
  }

  /** Open the TaskModal to create a new task; optionally enqueue it right away
   *  ("Run immediately"). The run must happen AFTER `reloadTasks()` so the
   *  rebuilt driver's in-memory list contains the new entry. */
  private openTaskModal(): void {
    new TaskModal(this.app, {
      mode: "create",
      modelChoices: this.modelChoices(),
      defaultModel: this.defaultModel(),
      onSubmit: async (r) => {
        const pinned = r.model ? { model: r.model } : {};
        const entry = await this.plugin.taskStore.create({ title: r.title, prompt: r.prompt, ...pinned });
        await this.reloadTasks();
        if (r.runImmediately) await this.driver?.run(entry.id);
      },
    }).open();
  }

  // --- Interactions -------------------------------------------------------

  private async onCardClick(task: TaskEntry): Promise<void> {
    if (task.convo) {
      const ok = await this.plugin.revealConversation(task.convo);
      if (!ok) new Notice("That task's chat is no longer open.");
    } else {
      new Notice("This task hasn't started a chat yet. Run it to begin.");
    }
  }

  private showCardMenu(e: MouseEvent, task: TaskEntry): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle("Run")
        .setIcon("play")
        .onClick(() => void this.driver?.run(task.id))
    );
    menu.addItem((i) =>
      i
        .setTitle("Open chat")
        .setIcon("message-square")
        .onClick(() => void this.onCardClick(task))
    );
    menu.addItem((i) =>
      i
        .setTitle("Edit task…")
        .setIcon("pencil")
        .onClick(() => this.editTask(task))
    );
    if (task.status === "review") {
      menu.addItem((i) =>
        i
          .setTitle("Mark done")
          .setIcon("check")
          .onClick(() => void this.driver?.markDone(task.id))
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Archive")
        .setIcon("archive")
        .onClick(() => void this.driver?.archive(task.id))
    );
    // Suppress session-card repaints while the menu is open (a repaint would
    // detach its anchor); catch up on close.
    this.menuOpen = true;
    menu.onHide(() => {
      this.menuOpen = false;
      this.scheduleRerender();
    });
    menu.showAtMouseEvent(e);
  }

  /** Edit an existing task through the same TaskModal, prefilled. Selecting the
   *  default model clears a previous pin (`model: undefined` drops the line
   *  from the ledger block via `applyTaskPatch`'s spread). */
  private editTask(task: TaskEntry): void {
    new TaskModal(this.app, {
      mode: "edit",
      initial: { title: task.title, prompt: task.prompt, model: task.model },
      modelChoices: this.modelChoices(),
      defaultModel: this.defaultModel(),
      onSubmit: async (r) => {
        await this.plugin.taskStore.update(task.id, { title: r.title, prompt: r.prompt, model: r.model });
        await this.reloadTasks();
      },
    }).open();
  }

  // --- Drag & drop --------------------------------------------------------

  /** Wire a column list as a drop target (append to end of the column). */
  private wireColumnDrop(list: HTMLElement, status: TaskStatus, tasks: TaskEntry[]): void {
    list.addEventListener("dragover", (e) => {
      if (!this.dragTaskId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      list.addClass("is-drop-target");
    });
    list.addEventListener("dragleave", () => list.removeClass("is-drop-target"));
    list.addEventListener("drop", (e) => {
      list.removeClass("is-drop-target");
      const id = this.dragTaskId ?? e.dataTransfer?.getData("text/plain") ?? null;
      if (!id) return;
      e.preventDefault();
      // Only handle the drop here if it didn't land on a specific card (cards
      // stop propagation for reorder). Append to the end of the column.
      const maxOrder = tasks.reduce((m, t) => Math.max(m, t.order ?? 0), 0);
      void this.driver?.move(id, status, maxOrder + 1);
    });
  }

  /** Wire a card as a reorder drop target: dropping onto it inserts the dragged
   *  card just before it, in the same column. */
  private wireCardDrop(card: HTMLElement, target: TaskEntry): void {
    card.addEventListener("dragover", (e) => {
      if (!this.dragTaskId || this.dragTaskId === target.id) return;
      e.preventDefault();
      e.stopPropagation();
      card.addClass("is-drop-before");
    });
    card.addEventListener("dragleave", () => card.removeClass("is-drop-before"));
    card.addEventListener("drop", (e) => {
      card.removeClass("is-drop-before");
      const id = this.dragTaskId ?? e.dataTransfer?.getData("text/plain") ?? null;
      if (!id || id === target.id) return;
      e.preventDefault();
      e.stopPropagation(); // don't also fire the column's append drop
      // Insert just before the target card: use an order slightly less than the
      // target's. The driver persists status+order; a full render re-sorts.
      const targetOrder = target.order ?? 0;
      void this.driver?.move(id, target.status, targetOrder - 0.5);
    });
  }

  // --- Helpers ------------------------------------------------------------

  /** Reload the driver's task list from the store (after a quick-add/edit that
   *  bypassed the reducer) and re-render. Also refreshes load warnings. */
  private async reloadTasks(): Promise<void> {
    const loaded = await this.plugin.taskStore.load();
    this.loadWarnings = loaded.warnings;
    // Restart the driver so its in-memory list reflects the new backlog task.
    this.driver?.stop();
    this.driver = new OrchestratorDriver(this.buildDeps());
    await this.driver.start();
    this.render(this.driver.snapshot());
  }

  private currentProvider(): ProviderId {
    return this.plugin.settings.provider;
  }

  private defaultModel(): string {
    const s = this.plugin.settings;
    return this.currentProvider() === "claude" ? s.claudeModel : s.codexModel;
  }

  /** Reuse the settings/view model-choices logic: built-ins + custom ids for
   *  the current provider, deduped. */
  private modelChoices(): { id: string; label: string }[] {
    const provider = this.currentProvider();
    const s = this.plugin.settings;
    return modelOptions(
      ADAPTERS[provider].models(),
      provider === "claude" ? s.claudeCustomModels : s.codexCustomModels
    );
  }
}
