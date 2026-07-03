/**
 * Per-turn idle/tool watchdog state machine — extracted verbatim from `view.ts`
 * `runTurn`. Re-arms on activity and fires `onTimeout` when a turn stalls with no
 * output. Two windows: a short idle window and a longer tool window used while ≥1
 * tool is in flight (a legit multi-minute Bash emits no events until its result and
 * must not be mistaken for a dead session). The window is decided at ARM time.
 *
 * Timer functions are injectable so tests can drive it with fake timers; they
 * default to `window.setTimeout` / `window.clearTimeout`.
 */
export class TurnWatchdog {
  private readonly idleMs: number;
  private readonly toolMs: number;
  private readonly onTimeout: (byTool: boolean) => void;
  private readonly setTimer: (fn: () => void, ms: number) => number;
  private readonly clearTimer: (id: number) => void;

  private timer: number | null = null;
  /** Pending interactive cards (permission/ask). While > 0 the idle window is
   *  suspended — the user may take arbitrarily long to answer. */
  private pendingInteractive = 0;
  /** Tool-call ids currently in flight. Non-empty ⇒ next arm uses the tool window. */
  private readonly inFlight = new Set<string>();
  private _fired = false;
  private _firedByTool = false;

  constructor(opts: {
    idleMs: number;
    toolMs: number;
    onTimeout: (byTool: boolean) => void;
    setTimer?: (fn: () => void, ms: number) => number;
    clearTimer?: (id: number) => void;
  }) {
    this.idleMs = opts.idleMs;
    this.toolMs = opts.toolMs;
    this.onTimeout = opts.onTimeout;
    this.setTimer = opts.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((id) => window.clearTimeout(id));
  }

  /** Re-arm the timer. NO-OP while an interactive card is pending. The window
   *  (tool vs idle) is captured NOW, at arm time, so the fired callback reports
   *  what it actually waited on. */
  bump(): void {
    if (this.pendingInteractive > 0) return; // don't arm while awaiting a user card
    if (this.timer !== null) this.clearTimer(this.timer);
    const toolBusy = this.inFlight.size > 0;
    this.timer = this.setTimer(() => {
      this._fired = true;
      this._firedByTool = toolBusy;
      this.onTimeout(toolBusy);
    }, toolBusy ? this.toolMs : this.idleMs);
  }

  /** An interactive card (permission/ask) opened — suspend the timer until answered. */
  suspendCard(): void {
    this.pendingInteractive++;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** An interactive card resolved — re-arm once the last one drains. */
  resumeCard(): void {
    if (this.pendingInteractive > 0) this.pendingInteractive--;
    if (this.pendingInteractive === 0) this.bump();
  }

  /** A real (non-interactive) tool started — track it and re-arm on the tool window. */
  toolStart(id: string): void {
    this.inFlight.add(id);
    this.bump();
  }

  /** A tool resolved. No-op for unknown/duplicate ids; if it WAS in flight,
   *  re-arm (drops back to the idle window once the last tool drains). */
  toolEnd(id: string): void {
    if (this.inFlight.delete(id)) this.bump();
  }

  /** Turn is over — cancel the timer and drop any unresolved tool ids. */
  clear(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.inFlight.clear();
  }

  /** Whether the timeout that fired was the tool window (drives the error copy). */
  get firedByTool(): boolean {
    return this._firedByTool;
  }

  /** Whether the watchdog fired at all. */
  get fired(): boolean {
    return this._fired;
  }
}
