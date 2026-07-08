/**
 * Orchestrator driver (B5) — the impure controller that owns the orchestration
 * runtime. It is the ONLY piece that ties the three pure/queued layers together:
 *
 *   - the pure reducer (`src/core/orchestrator.ts`) decides transitions + effects,
 *   - the queued store (`src/obsidian/task-store.ts`) persists every mutation
 *     through the shared `WriteQueue`,
 *   - the plugin-level convo-state emitter (`src/core/convo-state.ts`, B4) feeds
 *     conversation-lifecycle events in,
 *   - `startTaskConversation` (B4) spawns chats and hands back a convo id.
 *
 * The driver holds an in-memory task list as the board's live source of truth,
 * derived at `start()` from `store.load()` + boot `reconcile()`, then evolved by
 * feeding events into `reduce()`. Every transition it applies is also persisted
 * through the store, and every `spawn-chat` effect is executed by spawning a
 * conversation and recording the returned convo id back onto the task (both in
 * memory and on disk).
 *
 * Nothing here imports `obsidian` — it depends only on injected callbacks
 * (`DriverDeps`), so the whole controller is unit-testable with fakes. The
 * BoardView (which DOES import `obsidian`) constructs the real deps.
 */

import {
  reconcile,
  reduce,
  type ConvoSnapshot,
  type OrchestratorConfig,
  type OrchestratorEffect,
  type OrchestratorEvent,
  type OrchestratorResult,
} from "../core/orchestrator";
import type { ConvoStateEvent, ConvoStateListener, Unsubscribe } from "../core/convo-state";
import type { TaskEntry, TaskPatch, TaskStatus } from "../core/tasks";

/** The driver-facing slice of the B3 `TaskStore` (kept structural so tests can
 *  inject a fake without the real store / WriteQueue). */
export interface DriverStore {
  load(): Promise<{ tasks: TaskEntry[]; warnings: string[] }>;
  update(id: string, patch: TaskPatch): Promise<TaskEntry>;
  move(id: string, status: TaskStatus, order: number): Promise<TaskEntry>;
  archive(id: string): Promise<TaskEntry>;
}

/** Everything the driver needs from the outside world. All injected so the
 *  controller stays pure of `obsidian` and fully unit-testable. */
export interface DriverDeps {
  /** The task ledger (B3). */
  store: DriverStore;
  /** Subscribe to the plugin convo-state emitter (B4). Returns an unsubscribe. */
  subscribe(listener: ConvoStateListener): Unsubscribe;
  /** Spawn a chat for a task and return its new convo id (B4
   *  `startTaskConversation`). Rejects on failure. */
  spawn(prompt: string, opts?: { model?: string }): Promise<string>;
  /** Boot-time convo liveness read for a recorded convo id (B4
   *  `readConvoState`, adapted to the reducer's `ConvoSnapshot` shape). */
  liveness(convoId: string): ConvoSnapshot;
  /** Current scheduler config (reads `orchestrationMaxConcurrent` live). */
  config(): OrchestratorConfig;
  /** Surface a user-visible error (Obsidian `Notice`). */
  notify(message: string): void;
  /** Called after every state change so the board can re-render. */
  onChange(tasks: TaskEntry[]): void;
}

/**
 * Maps a chat-side convo-state event onto the reducer's `ConvoEvent` vocabulary.
 * `turn-start`/`turn-end` map 1:1; `needs-input`/`stopped`/`error` map to the
 * same-named reducer events (the reducer parks all three in `needs-input` with
 * a reason badge, distinguished by `inputReason`).
 */
function toOrchestratorEvent(e: ConvoStateEvent): OrchestratorEvent {
  switch (e.state) {
    case "turn-start":
      return { type: "turn-start", convoId: e.convoId };
    case "turn-end":
      return { type: "turn-end", convoId: e.convoId };
    case "needs-input":
      return { type: "needs-input", convoId: e.convoId };
    case "stopped":
      return { type: "stopped", convoId: e.convoId };
    case "error":
      return { type: "error", convoId: e.convoId };
  }
}

export class OrchestratorDriver {
  private tasks: TaskEntry[] = [];
  private unsubscribe: Unsubscribe | null = null;
  /** Serializes reducer dispatches so overlapping async events (convo bursts,
   *  spawn awaits) can never interleave a read-modify-write of `this.tasks`. */
  private chain: Promise<void> = Promise.resolve();
  private started = false;

  constructor(private readonly deps: DriverDeps) {}

  /** The live task list — the board's render source. Defensive copy. */
  snapshot(): TaskEntry[] {
    return this.tasks.map((t) => ({ ...t }));
  }

  /**
   * Load tasks, reconcile against live convo state, subscribe to convo events.
   * Idempotent: a second call while running is a no-op.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const loaded = await this.deps.store.load();
    // Reconcile persisted statuses against the live convo store (per B2's pure
    // matrix). Dead convos get chatMissing; idle→review; streaming→running.
    const convos = new Map<string, ConvoSnapshot>();
    for (const t of loaded.tasks) {
      if (t.convo) convos.set(t.convo, this.deps.liveness(t.convo));
    }
    const reconciled = reconcile(loaded.tasks, convos, this.deps.config());
    this.tasks = reconciled.tasks;

    // Persist any status/flag corrections reconciliation produced so the on-disk
    // ledger matches the reconciled view (best-effort; never throws into boot).
    await this.persistDiff(loaded.tasks, this.tasks);

    this.unsubscribe = this.deps.subscribe((e) => this.onConvoEvent(e));
    this.emitChange();
  }

  /**
   * Stop the driver: unsubscribe from convo events and drop the in-memory
   * runtime state. Touches NO markdown and leaves running conversations alive
   * (they simply become normal chats). Safe to call when never started.
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.tasks = [];
    this.started = false;
  }

  // --- User actions -------------------------------------------------------

  /** Backlog → Queued (scheduler may promote to Running immediately). */
  enqueue(taskId: string): Promise<void> {
    return this.dispatch({ type: "enqueue", taskId });
  }

  /**
   * "Run" a task: for a normal backlog task this is `enqueue`; for a
   * `chat-missing` task (its recorded convo is dead) this re-queues it so the
   * scheduler spawns a FRESH convo and records the new id. Either way it routes
   * through `enqueue` on the reducer — a task that isn't in `backlog` (e.g. a
   * chat-missing task still marked `running`) is first moved back to `queued`.
   */
  async run(taskId: string): Promise<void> {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return;
    if (t.status === "backlog") {
      await this.enqueue(taskId);
      return;
    }
    // Re-run path (chat-missing, needs-input, review, or a stale running):
    // move to queued at the front so the scheduler promotes + spawns fresh.
    await this.move(taskId, "queued", -1);
  }

  /** Review → Done. User-action-only; ignored elsewhere by the reducer. */
  markDone(taskId: string): Promise<void> {
    return this.dispatch({ type: "mark-done", taskId });
  }

  /**
   * Archive a card: hides it from the board (the `archived` column is not
   * rendered) while KEEPING its markdown block in tasks.md. Available from the
   * card context menu on any column, so it goes straight through the store's
   * dedicated `archive` path (which sets `archived` regardless of the current
   * status) rather than the reducer's `done → archived` transition. Serialized
   * on the dispatch chain so it can't race a convo event.
   */
  archive(taskId: string): Promise<void> {
    const run = this.chain.then(() => this.applyArchive(taskId));
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async applyArchive(taskId: string): Promise<void> {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return;
    this.tasks = this.tasks.map((x) => (x.id === taskId ? { ...x, status: "archived" as TaskStatus } : x));
    await this.deps.store.archive(taskId).catch(() => undefined);
    // Archiving a running task frees a slot — let the scheduler fill it.
    const result = reduce(this.tasks, { type: "slot-freed" }, this.deps.config());
    const before = this.tasks;
    this.tasks = result.tasks;
    await this.persistDiff(before, this.tasks);
    this.emitChange();
    for (const effect of result.effects) await this.runEffect(effect);
  }

  /** Drag/move to an explicit column + order (board drag & drop). */
  move(taskId: string, target: TaskStatus, order: number): Promise<void> {
    return this.dispatch({ type: "move", taskId, target, order });
  }

  // --- Convo events -------------------------------------------------------

  private onConvoEvent(e: ConvoStateEvent): void {
    void this.dispatch(toOrchestratorEvent(e));
  }

  // --- Core dispatch ------------------------------------------------------

  /**
   * Feed one event through the pure reducer, persist the resulting transitions,
   * and execute any spawn effects — all serialized on `this.chain` so async
   * spawns can't interleave. Returns when this event's work has settled.
   */
  private dispatch(event: OrchestratorEvent): Promise<void> {
    const run = this.chain.then(() => this.applyEvent(event));
    // Advance the chain on a branch that swallows rejection, so one failed
    // dispatch never poisons later ones (same discipline as WriteQueue).
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async applyEvent(event: OrchestratorEvent): Promise<void> {
    const before = this.tasks;
    const result: OrchestratorResult = reduce(before, event, this.deps.config());
    this.tasks = result.tasks;

    // Persist non-effect transitions (status/order/badge changes) first so the
    // ledger reflects the move even if a spawn later fails.
    await this.persistDiff(before, this.tasks);
    this.emitChange();

    // Execute effects (spawns). Each records its convo id back onto the task.
    for (const effect of result.effects) {
      await this.runEffect(effect);
    }
  }

  private async runEffect(effect: OrchestratorEffect): Promise<void> {
    if (effect.type !== "spawn-chat") return;
    try {
      const convoId = await this.deps.spawn(effect.prompt, effect.model ? { model: effect.model } : undefined);
      // Record the convo id (and clear any stale chat-missing flag) in memory
      // and on disk. The task is already `running` from the reducer.
      this.tasks = this.tasks.map((t) =>
        t.id === effect.taskId ? { ...t, convo: convoId, chatMissing: undefined } : t
      );
      await this.deps.store.update(effect.taskId, { convo: convoId }).catch(() => undefined);
      this.emitChange();
    } catch (err) {
      // Spawn/write failure → drop the task to needs-input with an error badge,
      // surface a Notice + (implicitly) a badge on the card via the state.
      const msg = err instanceof Error ? err.message : String(err);
      this.tasks = this.tasks.map((t) =>
        t.id === effect.taskId ? { ...t, status: "needs-input", inputReason: "error", chatMissing: undefined } : t
      );
      await this.deps.store.update(effect.taskId, { status: "needs-input" }).catch(() => undefined);
      this.deps.notify(`Couldn't start task: ${msg}`);
      this.emitChange();
    }
  }

  /**
   * Persist the fields that changed between two task lists through the store.
   * A status/order change → `store.move`; other field changes (badges) →
   * `store.update` with the changed metadata. Best-effort: a persist failure is
   * swallowed (the in-memory view stays authoritative; the board still renders).
   */
  private async persistDiff(before: TaskEntry[], after: TaskEntry[]): Promise<void> {
    const beforeById = new Map(before.map((t) => [t.id, t]));
    for (const t of after) {
      const prev = beforeById.get(t.id);
      if (!prev) continue;
      const statusChanged = prev.status !== t.status;
      const orderChanged = (prev.order ?? undefined) !== (t.order ?? undefined);
      if (statusChanged || orderChanged) {
        await this.deps.store.move(t.id, t.status, t.order ?? 0).catch(() => undefined);
      }
    }
  }

  private emitChange(): void {
    this.deps.onChange(this.snapshot());
  }
}
