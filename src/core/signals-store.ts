/**
 * LEGACY (retired 2026-07-20, P4-T03): the topic-recurrence playbook loop was
 * superseded by the Workflow Foundry, which distills playbooks through the
 * Proposal Kernel (`foundry-distill.ts` + `proposal-store.ts`). This module is
 * no longer wired into the active turn path. It is retained — not deleted — so
 * `_system/memory/playbook-signals.json` remains readable for a future
 * migration; the data file itself is never auto-deleted.
 *
 * Sidecar persistence for the playbook-recurrence ledger. The ledger logic is
 * pure (`learning-loop.ts`); this is the thin Obsidian I/O layer that reads and
 * writes `_system/memory/playbook-signals.json`. It lives in `_system/` (not
 * plugin data) so it fits the vault's memory protocol and stays grep-inspectable.
 * Tolerant of an absent/corrupt file (→ empty ledger).
 */

import { App } from "obsidian";
import { EMPTY_LEDGER, type SignalLedger, type PlaybookSignal } from "./learning-loop";
import { exoPaths, LEGACY_MEMORY_ROOT } from "./paths";

/** Default memory dir — legacy `_system/memory` for the retired ledger's
 *  fallback; callers on a configured vault pass `paths.memory`. */
const LEGACY_DIR = exoPaths(LEGACY_MEMORY_ROOT).memory;
const signalsPath = (dir: string) => `${dir}/playbook-signals.json`;

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

export async function loadSignalLedger(app: App, dir: string = LEGACY_DIR): Promise<SignalLedger> {
  const path = signalsPath(dir);
  try {
    if (!(await app.vault.adapter.exists(path))) return EMPTY_LEDGER;
    const parsed = JSON.parse(await app.vault.adapter.read(path)) as Partial<SignalLedger>;
    if (!parsed || !Array.isArray(parsed.signals)) return EMPTY_LEDGER;
    return { signals: parsed.signals.filter(isSignal) };
  } catch {
    return EMPTY_LEDGER;
  }
}

export async function saveSignalLedger(app: App, ledger: SignalLedger, dir: string = LEGACY_DIR): Promise<void> {
  if (!(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
  await app.vault.adapter.write(signalsPath(dir), JSON.stringify(ledger, null, 2));
}
