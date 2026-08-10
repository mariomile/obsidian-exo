/**
 * Ledger watch — WHEN a change to `tasks.md` should make the Orchestration
 * Board reload, and WHETHER anything actually changed.
 *
 * The board's `OrchestratorDriver` loads the ledger once at `start()` and then
 * evolves an in-memory list. That was fine while the board was the only writer.
 * It stopped being true the moment `spawn_task` began appending `queued` blocks
 * straight into the file: an already-open board — the expected supervision
 * posture — never saw them, so a delegated task produced no card, no promotion,
 * no spawn and no report, while the tool had already promised the agent that it
 * would start and report back.
 *
 * The hard part is not noticing the file changed, it is noticing it changed
 * because of SOMEBODY ELSE. The driver persists every transition through the
 * same file, so a naive listener reloads on every write it just made — and a
 * reload restarts the driver, mid-spawn, forever. Two independent guards:
 *
 *  1. `guard()` marks the board's own writes, and events landing while one is
 *     in flight (or just after) are DEFERRED, never dropped — a real external
 *     write can land inside that window, and losing it is the bug this module
 *     exists to fix.
 *  2. `ledgerChangedExternally` compares what is on disk against what the driver
 *     believes, so even a deferred false alarm costs one read and stops there.
 *
 * No `obsidian` import: timers and the clock are injected, so the whole policy
 * is unit-testable one millisecond at a time. The impure shell (BoardView) owns
 * the vault listener and the reload itself.
 */
import type { TaskEntry } from "./tasks";

/** How long a burst of ledger writes is allowed to settle before reloading. */
export const LEDGER_RELOAD_DEBOUNCE_MS = 400;
/**
 * How long after our own write an event is still assumed to be its echo.
 * Obsidian emits `modify` after `vault.modify` resolves, so the in-flight
 * counter alone would miss it by a few milliseconds.
 */
export const LEDGER_SELF_WRITE_GRACE_MS = 1000;

/**
 * The identity of a task list for change detection.
 *
 * `updated` and `created` are deliberately EXCLUDED. The store stamps `updated`
 * on every write while the driver's in-memory copy keeps the old value, so
 * including it would make every write the board makes itself look like an
 * outside edit — an endless reload loop. Everything else is in: a hand edit to a
 * title or a prompt is a real change the board should repaint for.
 */
export function ledgerSignature(tasks: readonly TaskEntry[]): string {
  // JSON per row rather than a joined string: `title` and `prompt` are stored
  // verbatim and fully user-controlled, so any separator character could be
  // typed into one and made to spell out another task's fields.
  return tasks
    .map((t) =>
      JSON.stringify([t.id, t.status, t.order ?? null, t.convo ?? null, t.parent ?? null, t.model ?? null, t.title, t.prompt])
    )
    .sort()
    .join("\n");
}

/** Whether what is on disk differs from what the board believes it has. */
export function ledgerChangedExternally(
  inMemory: readonly TaskEntry[],
  onDisk: readonly TaskEntry[]
): boolean {
  return ledgerSignature(inMemory) !== ledgerSignature(onDisk);
}

export interface LedgerWatchDeps {
  /** Fired (debounced, and never during our own writes) when the ledger moved. */
  onExternalChange(): void;
  schedule(fn: () => void, ms: number): number;
  cancel(id: number): void;
  now(): number;
}

export class LedgerWatch {
  private timer: number | null = null;
  /** Our own writes currently running. A counter, not a flag: overlapping
   *  writes must not be un-suppressed by whichever finishes first. */
  private inFlight = 0;
  private lastWriteEndedAt = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(private readonly deps: LedgerWatchDeps) {}

  /**
   * Run one of the board's own ledger writes under suppression. Pass-through:
   * resolves and rejects exactly as `write` does, and a rejection still releases
   * the suppression — a failed write is not a reason to go deaf.
   */
  async guard<T>(write: Promise<T>): Promise<T> {
    this.inFlight++;
    try {
      return await write;
    } finally {
      this.inFlight--;
      this.lastWriteEndedAt = this.deps.now();
    }
  }

  /** A `modify` event landed on the ledger path. */
  notify(): void {
    if (this.disposed) return;
    this.arm();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.deps.cancel(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer !== null) this.deps.cancel(this.timer);
    this.timer = this.deps.schedule(() => this.fire(), LEDGER_RELOAD_DEBOUNCE_MS);
  }

  private fire(): void {
    this.timer = null;
    if (this.disposed) return;
    // Our own writes are still echoing. Re-arm rather than drop: the grace
    // window expires on a fixed deadline, so this converges, and an external
    // write that happened to land inside it is only delayed, not lost.
    if (this.inFlight > 0 || this.deps.now() - this.lastWriteEndedAt < LEDGER_SELF_WRITE_GRACE_MS) {
      this.arm();
      return;
    }
    this.deps.onExternalChange();
  }
}
