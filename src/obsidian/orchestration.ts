/**
 * Plugin-level orchestration runtime — who OWNS the `OrchestratorDriver`.
 *
 * Until now the answer was "the Orchestration Board tab", because the driver was
 * constructed in `BoardView.onOpen` and stopped in `onClose`. That made the
 * feature's central promise conditional on a tab: an agent calling `spawn_task`
 * got a `queued` row written into `tasks.md` and a confident "it will start and
 * report back", and with the board closed nothing ever ran. Delegation quietly
 * became note-taking.
 *
 * This module moves ownership to the plugin. The runtime starts when the plugin
 * loads (and `orchestrationEnabled` is on), stops on unload, and follows the
 * settings toggle live. The board attaches to the RUNNING driver, paints its
 * snapshot and routes gestures to it; closing the board stops nothing.
 *
 * It also owns the pieces that must move with the driver:
 *  - the **ledger watch**, with its self-write suppression intact (the driver
 *    persists through the same file it listens to, so without the guard every
 *    write it makes would reload — and a reload rebuilds the driver mid-spawn);
 *  - the **host watch**: a driver that starts with the plugin routinely finds no
 *    ChatView to put a conversation in, so promotions are withheld (see
 *    `DriverDeps.canSpawn`) and retried when a host shows up.
 *
 * No `obsidian` import: everything workspace- or vault-shaped arrives as an
 * injected callback (`OrchestrationDeps`), so the whole lifecycle is unit
 * testable. The real deps are built in `orchestration-wiring.ts`.
 */
import { OrchestratorDriver, type DriverDeps, type DriverStore } from "./orchestrator-driver";
import { LedgerWatch, ledgerChangedExternally } from "../core/ledger-watch";
import type { ConvoStateListener, Unsubscribe } from "../core/convo-state";
import type { ConvoSnapshot, OrchestratorConfig } from "../core/orchestrator";
import type { TaskEntry, TaskStatus } from "../core/tasks";
import type { ChildReport } from "../core/child-reports";

/**
 * How often the runtime re-checks for a conversation host while a promotion is
 * withheld. A backstop, not the mechanism: `onHostSignal` (workspace events) is
 * what normally wakes us. It exists because the case that actually blocks work
 * is a ChatView leaf restored from the saved layout but still DEFERRED — it
 * materialises on `loadIfDeferred()` rather than on a user gesture, so there is
 * no reliable workspace event to hang off. The poll is armed only while
 * something is waiting and cleared the moment a host appears.
 */
export const HOST_RETRY_MS = 1000;

/** Everything the runtime needs from the plugin/Obsidian side. */
export interface OrchestrationDeps {
  /** Live read of `settings.orchestrationEnabled`. */
  enabled(): boolean;
  /** The task ledger, UNGUARDED — the runtime routes writes through its own
   *  `LedgerWatch` so the driver's persistence isn't heard as an outside edit. */
  store: DriverStore;
  subscribe(listener: ConvoStateListener): Unsubscribe;
  spawn(prompt: string, opts?: { model?: string; parent?: string }): Promise<string>;
  liveness(convoId: string): ConvoSnapshot;
  config(): OrchestratorConfig;
  notify(message: string): void;
  lastAssistantText(convoId: string): string;
  onChildReport(report: ChildReport): void;
  /** Can a conversation be hosted right now? See `DriverDeps.canSpawn`. */
  canSpawn(): boolean;
  /** Subscribe to workspace changes that might have produced a host. Returns an
   *  unsubscribe; only ever subscribed while a promotion is waiting. */
  onHostSignal(cb: () => void): Unsubscribe;
  /** Watch the ledger file for create/modify. Returns an unsubscribe. */
  watchLedger(cb: () => void): Unsubscribe;
}

/** A board (or any other renderer) listening for task-list changes. */
export type TasksListener = (tasks: TaskEntry[]) => void;

export class OrchestrationRuntime {
  private driver: OrchestratorDriver | null = null;
  private ledgerWatch: LedgerWatch | null = null;
  private unwatchLedger: Unsubscribe | null = null;
  private unHostSignal: Unsubscribe | null = null;
  private hostPoll: ReturnType<typeof setInterval> | null = null;
  private loadWarnings: string[] = [];
  private tasks: TaskEntry[] = [];
  private readonly listeners = new Set<TasksListener>();
  /** In-flight `start()`, so concurrent callers (plugin boot + a board opening
   *  in the same tick) await the SAME start instead of racing two drivers. */
  private starting: Promise<void> | null = null;
  /** Bumped by every `stop()`. A boot that was torn down mid-`await` compares
   *  this and abandons the driver it was building — without it, an unload or a
   *  hot-disable landing inside `store.load()` would let the boot resume and
   *  subscribe a driver nobody holds a handle to any more. */
  private generation = 0;

  constructor(private readonly deps: OrchestrationDeps) {}

  // --- Lifecycle ----------------------------------------------------------

  /** Bring the runtime in line with the flag. Safe to call any number of times:
   *  this is both the boot path and the settings-toggle path. */
  sync(): void {
    if (this.deps.enabled()) void this.start();
    else this.stop();
  }

  /** Whether orchestration is live right now. */
  isRunning(): boolean {
    return this.driver !== null;
  }

  /**
   * Start the driver and the ledger watch. Idempotent and concurrency-safe: a
   * second call while one is running (or still starting) awaits the first.
   */
  start(): Promise<void> {
    if (!this.deps.enabled()) return Promise.resolve();
    if (this.starting) return this.starting;
    if (this.driver) return Promise.resolve();
    const run = this.boot();
    this.starting = run.finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async boot(): Promise<void> {
    const generation = this.generation;
    // Built BEFORE the driver: the driver writes through a store whose writes
    // route into this watch, so the modify events its own persistence causes
    // aren't mistaken for somebody else's edit.
    this.ledgerWatch = new LedgerWatch({
      schedule: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      cancel: (id) => clearTimeout(id),
      now: () => Date.now(),
      onExternalChange: () => void this.reloadIfLedgerChanged(),
    });
    // `spawn_task` appends a queued child straight into tasks.md, and
    // `createChildTask` takes the `vault.create` branch for the vault's very
    // first task — so both events matter, and the shell reports both here.
    this.unwatchLedger = this.deps.watchLedger(() => this.ledgerWatch?.notify());

    const driver = new OrchestratorDriver(this.buildDriverDeps());
    this.driver = driver;
    const loaded = await this.deps.store.load();
    // A `stop()` landing inside that read already tore everything down. Starting
    // the driver now would subscribe a runtime nobody can stop again.
    if (this.generation !== generation) return;
    this.loadWarnings = loaded.warnings;
    await driver.start();
    if (this.generation !== generation) {
      driver.stop();
      return;
    }
    this.emit(driver.snapshot());
  }

  /**
   * Stop orchestration: drop the driver's runtime state (running conversations
   * stay alive as normal chats), dispose the ledger watch and its debounce
   * timer, drop the vault listener, and disarm the host watch. Touches no
   * markdown. Safe when never started.
   */
  stop(): void {
    this.generation++;
    this.disarmHostWatch();
    this.unwatchLedger?.();
    this.unwatchLedger = null;
    this.ledgerWatch?.dispose();
    this.ledgerWatch = null;
    this.driver?.stop();
    this.driver = null;
    this.tasks = [];
    this.loadWarnings = [];
  }

  /**
   * Rebuild the driver from the ledger on disk. Used after a write that bypassed
   * the reducer (the board's quick-add/edit) and by the ledger watch when
   * somebody else changed the file.
   */
  async reload(): Promise<void> {
    if (!this.driver) {
      await this.start();
      return;
    }
    const generation = this.generation;
    const loaded = await this.deps.store.load();
    if (this.generation !== generation || !this.driver) return;
    this.loadWarnings = loaded.warnings;
    this.driver.stop();
    const driver = new OrchestratorDriver(this.buildDriverDeps());
    this.driver = driver;
    await driver.start();
    if (this.generation !== generation) {
      driver.stop();
      return;
    }
    this.emit(driver.snapshot());
  }

  // --- Renderers ----------------------------------------------------------

  /** Attach a renderer. Returns an unsubscribe; detaching the LAST one does not
   *  stop orchestration — that is the whole point of this module. */
  onTasks(listener: TasksListener): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The live task list (defensive copy). */
  snapshot(): TaskEntry[] {
    return this.driver?.snapshot() ?? this.tasks.map((t) => ({ ...t }));
  }

  /** Malformed-ledger warnings from the last load, for the board's banner. */
  warnings(): string[] {
    return [...this.loadWarnings];
  }

  // --- Gestures (board control surface) -----------------------------------

  run(taskId: string): Promise<void> {
    return this.driver?.run(taskId) ?? Promise.resolve();
  }
  move(taskId: string, target: TaskStatus, order: number): Promise<void> {
    return this.driver?.move(taskId, target, order) ?? Promise.resolve();
  }
  markDone(taskId: string): Promise<void> {
    return this.driver?.markDone(taskId) ?? Promise.resolve();
  }
  archive(taskId: string): Promise<void> {
    return this.driver?.archive(taskId) ?? Promise.resolve();
  }

  // --- Internals ----------------------------------------------------------

  private buildDriverDeps(): DriverDeps {
    return {
      store: this.guardedStore(),
      subscribe: (listener) => this.deps.subscribe(listener),
      spawn: (prompt, opts) => this.deps.spawn(prompt, opts),
      liveness: (convoId) => this.deps.liveness(convoId),
      config: () => this.deps.config(),
      notify: (message) => this.deps.notify(message),
      onChange: (tasks) => this.emit(tasks),
      lastAssistantText: (convoId) => this.deps.lastAssistantText(convoId),
      onChildReport: (report) => this.deps.onChildReport(report),
      canSpawn: () => this.deps.canSpawn(),
      onSpawnHostMissing: () => this.armHostWatch(),
    };
  }

  /** The store with every WRITE routed through the ledger watch, so the modify
   *  events our own persistence causes are told apart from somebody else's. */
  private guardedStore(): DriverStore {
    const store = this.deps.store;
    const guard = <T>(write: Promise<T>): Promise<T> => this.ledgerWatch?.guard(write) ?? write;
    return {
      load: () => store.load(),
      update: (id, patch) => guard(store.update(id, patch)),
      move: (id, status, order) => guard(store.move(id, status, order)),
      archive: (id) => guard(store.archive(id)),
    };
  }

  /** A settled ledger change: reload only if what is on disk actually differs
   *  from what the driver believes. A reload rebuilds the driver, so doing it on
   *  a write we made ourselves would restart orchestration mid-spawn — and the
   *  suppression window is a heuristic, this is the proof. */
  private async reloadIfLedgerChanged(): Promise<void> {
    const driver = this.driver;
    if (!driver) return;
    const loaded = await this.deps.store.load();
    if (this.driver !== driver) return; // stopped/rebuilt while the read was in flight
    if (!ledgerChangedExternally(driver.snapshot(), loaded.tasks)) return;
    await this.reload();
  }

  /**
   * A promotion was withheld for want of a conversation host. Listen for one to
   * appear (workspace events, plus a cheap poll for the deferred-view case that
   * emits none) and re-run the scheduler the moment it does.
   */
  private armHostWatch(): void {
    if (this.unHostSignal || this.hostPoll !== null) return;
    this.unHostSignal = this.deps.onHostSignal(() => this.retryIfHostAvailable());
    this.hostPoll = setInterval(() => this.retryIfHostAvailable(), HOST_RETRY_MS);
  }

  private retryIfHostAvailable(): void {
    if (!this.driver) {
      this.disarmHostWatch();
      return;
    }
    if (!this.deps.canSpawn()) return;
    this.disarmHostWatch();
    void this.driver.pump();
  }

  private disarmHostWatch(): void {
    this.unHostSignal?.();
    this.unHostSignal = null;
    if (this.hostPoll !== null) {
      clearInterval(this.hostPoll);
      this.hostPoll = null;
    }
  }

  private emit(tasks: TaskEntry[]): void {
    this.tasks = tasks;
    for (const listener of this.listeners) {
      try {
        listener(tasks);
      } catch {
        // A renderer that throws must never break orchestration — same
        // isolation contract as the convo-state channel's listeners.
      }
    }
  }
}
