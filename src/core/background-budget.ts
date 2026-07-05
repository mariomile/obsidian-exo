/**
 * Background AI budget — pure daily-ledger logic (no Obsidian imports).
 *
 * W0 cost governance: one shared daily token budget + master kill-switch for
 * every background LLM pass (observer, dream-LLM, heartbeat, skill foundry).
 * The ledger is a single `{ dateUTC, tokensUsed }` record persisted in plugin
 * data; the impure shell reads/writes it and supplies `now`. Everything here is
 * a pure function returning a NEW ledger — inputs are never mutated — so it is
 * trivially unit-testable with injected timestamps.
 */

export interface BudgetLedger {
  /** The UTC calendar day this counter belongs to, `YYYY-MM-DD`. */
  dateUTC: string;
  /** Tokens spent by background passes so far on `dateUTC`. */
  tokensUsed: number;
}

/** Options every gate/record call needs from the settings layer. */
export interface BudgetOpts {
  /** The `backgroundPassesEnabled` master toggle. */
  enabled: boolean;
  /** The `backgroundDailyTokenBudget`. `<= 0` means unlimited. */
  dailyBudget: number;
  /** Wall-clock now (ms) — injected so day-rollover is testable. */
  now: number;
}

/** UTC `YYYY-MM-DD` for a timestamp (TZ-independent, matches monthFileName's UTC basis). */
export function dateUTC(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

/** A fresh, empty ledger for the day containing `now`. */
export function initialBudgetLedger(now: number): BudgetLedger {
  return { dateUTC: dateUTC(now), tokensUsed: 0 };
}

/**
 * Roll the ledger to the current UTC day, zeroing the counter when the day has
 * changed. Same-day calls return the input unchanged (referentially, a copy is
 * not made when nothing changed — callers must not rely on identity).
 */
export function resetIfNewDay(ledger: BudgetLedger, now: number): BudgetLedger {
  const today = dateUTC(now);
  if (ledger.dateUTC === today) return ledger;
  return { dateUTC: today, tokensUsed: 0 };
}

/**
 * Can a background pass spend `estimate` tokens right now? False when the master
 * toggle is off; otherwise true iff the post-rollover counter plus the estimate
 * stays within the daily budget. A non-positive `dailyBudget` is treated as
 * unlimited (only the master toggle can then block a pass).
 */
export function canSpend(ledger: BudgetLedger, estimate: number, opts: BudgetOpts): boolean {
  if (!opts.enabled) return false;
  if (!(opts.dailyBudget > 0)) return true; // unlimited (0/negative/NaN)
  const rolled = resetIfNewDay(ledger, opts.now);
  const est = Number.isFinite(estimate) && estimate > 0 ? estimate : 0;
  return rolled.tokensUsed + est <= opts.dailyBudget;
}

/**
 * Record `tokens` spent, rolling the day over first. A negative/NaN token count
 * is clamped to zero (a background pass never *reduces* the day's usage).
 */
export function recordSpend(ledger: BudgetLedger, tokens: number, now: number): BudgetLedger {
  const rolled = resetIfNewDay(ledger, now);
  const add = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
  return { dateUTC: rolled.dateUTC, tokensUsed: rolled.tokensUsed + add };
}
