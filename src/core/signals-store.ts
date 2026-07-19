/**
 * Sidecar persistence for the playbook-recurrence ledger. The ledger logic is
 * pure (`learning-loop.ts`); this is the thin Obsidian I/O layer that reads and
 * writes `_system/memory/playbook-signals.json`. It lives in `_system/` (not
 * plugin data) so it fits the vault's memory protocol and stays grep-inspectable.
 * Tolerant of an absent/corrupt file (→ empty ledger).
 */

import { App } from "obsidian";
import { EMPTY_LEDGER, type SignalLedger, type PlaybookSignal } from "./learning-loop";

const DIR = "_system/memory";
const PATH = `${DIR}/playbook-signals.json`;

function isSignal(x: unknown): x is PlaybookSignal {
  const s = x as Partial<PlaybookSignal> | null;
  return (
    !!s &&
    Array.isArray(s.keywords) &&
    typeof s.count === "number" &&
    typeof s.lastSeen === "number" &&
    Array.isArray(s.examples) &&
    typeof s.proposed === "boolean"
  );
}

export async function loadSignalLedger(app: App): Promise<SignalLedger> {
  try {
    if (!(await app.vault.adapter.exists(PATH))) return EMPTY_LEDGER;
    const parsed = JSON.parse(await app.vault.adapter.read(PATH)) as Partial<SignalLedger>;
    if (!parsed || !Array.isArray(parsed.signals)) return EMPTY_LEDGER;
    return { signals: parsed.signals.filter(isSignal) };
  } catch {
    return EMPTY_LEDGER;
  }
}

export async function saveSignalLedger(app: App, ledger: SignalLedger): Promise<void> {
  if (!(await app.vault.adapter.exists(DIR))) await app.vault.adapter.mkdir(DIR);
  await app.vault.adapter.write(PATH, JSON.stringify(ledger, null, 2));
}
