/**
 * Automations — pure scheduling core (no Obsidian imports).
 *
 * An automation runs a named playbook (custom prompt) unattended on a cadence.
 * Slot-based due logic: each cadence defines discrete local-time slots (top of
 * hour / daily at HH / weekly at day+HH); an automation is due when its last
 * run predates the current slot's start. The 30-min scheduler poll then fires
 * it once per slot — no drift, no double-fires, deterministic in tests.
 *
 * The executor (main.ts) owns timers and vault IO; this module owns decisions.
 */

export type Cadence =
  | { kind: "hourly" }
  | { kind: "daily"; hour: number } // 0–23 local
  | { kind: "weekly"; day: number; hour: number }; // day: 0=Sun … 6=Sat

export interface AutomationConfig {
  /** Custom prompt (playbook) name this automation runs — matched case-insensitively. */
  name: string;
  /** Optional built-in executor. Absent configs continue to run custom playbooks. */
  system?: "daily-pulse";
  cadence: Cadence;
  enabled: boolean;
  /** true → the run may write inside the vault (checkpointed, restorable);
   *  false → legacy read-only report run. */
  write: boolean;
}

/** Stable persistence key; system automations must not collide with playbook names. */
export function automationLastRunKey(automation: AutomationConfig): string {
  return automation.system ? `system:${automation.system}` : automation.name;
}

/** One executed automation run — persisted (pruned) so a bad write run can be
 *  rolled back from the UI. Checkpoint entries mirror the chat model: vault
 *  path → pre-run content, null when the file did not exist before the run. */
export interface AutomationRunRecord {
  id: string;
  name: string;
  startedAt: number;
  ok: boolean;
  reportPath: string;
  writes: string[];
  checkpoint: [string, string | null][];
  restoredAt?: number;
  /** Set when Mario marked the run as reviewed (review-queue flow) — reviewed
   *  and restored runs both leave the "to review" pool. */
  reviewedAt?: number;
}

/** Write runs still waiting for review — the Cockpit attention pool. */
export function unreviewedWriteRuns(records: AutomationRunRecord[]): AutomationRunRecord[] {
  return records.filter((r) => r.writes.length > 0 && !r.reviewedAt && !r.restoredAt);
}

/** Validate loose cadence input (agent tools) into a Cadence. Day accepts 0–6
 *  or an English/Italian day name; hour defaults to 07. Null = invalid. */
export function parseCadenceInput(kind: string, hour?: number, day?: number | string): Cadence | null {
  const h = hour === undefined ? 7 : Math.trunc(hour);
  if (h < 0 || h > 23) return null;
  if (kind === "hourly") return { kind: "hourly" };
  if (kind === "daily") return { kind: "daily", hour: h };
  if (kind !== "weekly") return null;
  let d: number;
  if (typeof day === "string") {
    const names: Record<string, number> = {
      sun: 0, sunday: 0, dom: 0, domenica: 0,
      mon: 1, monday: 1, lun: 1, lunedi: 1, lunedì: 1,
      tue: 2, tuesday: 2, mar: 2, martedi: 2, martedì: 2,
      wed: 3, wednesday: 3, mer: 3, mercoledi: 3, mercoledì: 3,
      thu: 4, thursday: 4, gio: 4, giovedi: 4, giovedì: 4,
      fri: 5, friday: 5, ven: 5, venerdi: 5, venerdì: 5,
      sat: 6, saturday: 6, sab: 6, sabato: 6,
    };
    const hit = names[day.trim().toLowerCase()];
    if (hit === undefined) return null;
    d = hit;
  } else {
    d = day === undefined ? 1 : Math.trunc(day);
  }
  if (d < 0 || d > 6) return null;
  return { kind: "weekly", day: d, hour: h };
}

/* ------------------------------ due logic ------------------------------ */

/** Start (epoch ms, local time) of the cadence slot containing `now`. */
export function currentSlotStart(cadence: Cadence, now: number): number {
  const d = new Date(now);
  if (cadence.kind === "hourly") {
    d.setMinutes(0, 0, 0);
    return d.getTime();
  }
  if (cadence.kind === "daily") {
    d.setHours(cadence.hour, 0, 0, 0);
    if (d.getTime() > now) d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  d.setHours(cadence.hour, 0, 0, 0);
  const back = (d.getDay() - cadence.day + 7) % 7;
  d.setDate(d.getDate() - back);
  if (d.getTime() > now) d.setDate(d.getDate() - 7);
  return d.getTime();
}

/** Due when the last run predates the current slot (0 = never ran → always due). */
export function isDue(cadence: Cadence, lastRun: number, now: number): boolean {
  return lastRun < currentSlotStart(cadence, now);
}

/** Epoch ms when this automation will next fire: now when already due, else
 *  the next slot boundary after the current one. */
export function nextDueAt(cadence: Cadence, lastRun: number, now: number): number {
  if (isDue(cadence, lastRun, now)) return now;
  const cur = currentSlotStart(cadence, now);
  const d = new Date(cur);
  if (cadence.kind === "hourly") d.setHours(d.getHours() + 1);
  else if (cadence.kind === "daily") d.setDate(d.getDate() + 1);
  else d.setDate(d.getDate() + 7);
  return d.getTime();
}

/** The next enabled automation to fire (for the Cockpit's Autonomy tile). */
export function nextAutomation(
  automations: AutomationConfig[],
  lastRun: Record<string, number>,
  now: number
): { name: string; dueAt: number } | null {
  let best: { name: string; dueAt: number } | null = null;
  for (const a of automations) {
    if (!a.enabled) continue;
    const dueAt = nextDueAt(a.cadence, lastRun[automationLastRunKey(a)] ?? 0, now);
    if (!best || dueAt < best.dueAt) best = { name: a.name, dueAt };
  }
  return best;
}

/* ------------------------------ labels ------------------------------ */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function cadenceLabel(c: Cadence): string {
  if (c.kind === "hourly") return "hourly";
  const hh = `${String(c.hour).padStart(2, "0")}:00`;
  return c.kind === "daily" ? `daily ${hh}` : `weekly ${DAYS[c.day] ?? "?"} ${hh}`;
}

/* ----------------------------- migration ----------------------------- */

/** Convert the legacy `scheduledRuns` textarea ("Name | daily" / "Name | weekly",
 *  one per line) into structured configs. Legacy runs were read-only and had no
 *  time-of-day — they land on 07:00 (Monday for weekly), write off. */
export function migrateScheduledRuns(raw: string): AutomationConfig[] {
  const out: AutomationConfig[] = [];
  for (const line of raw.split("\n")) {
    const i = line.lastIndexOf("|");
    if (i < 0) continue;
    const name = line.slice(0, i).trim();
    const cadence = line.slice(i + 1).trim().toLowerCase();
    if (!name) continue;
    if (cadence === "daily") out.push({ name, cadence: { kind: "daily", hour: 7 }, enabled: true, write: false });
    else if (cadence === "weekly")
      out.push({ name, cadence: { kind: "weekly", day: 1, hour: 7 }, enabled: true, write: false });
  }
  return out;
}

/* ---------------------------- run records ---------------------------- */

/** Keep the newest `max` run records (by startedAt), newest first. */
export function pruneRuns(records: AutomationRunRecord[], max: number): AutomationRunRecord[] {
  return [...records].sort((a, b) => b.startedAt - a.startedAt).slice(0, Math.max(0, max));
}
