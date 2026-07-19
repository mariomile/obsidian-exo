/**
 * Sidecar persistence for the unlinked-mention ignore-list. The store itself is
 * pure (`store-core.ts`); this module is the thin Obsidian I/O layer that reads
 * and writes `_system/mentions/ignore.json`. Tolerant of an absent/corrupt file
 * (→ empty store) so a first run never errors.
 */

import { App } from "obsidian";
import {
  EMPTY_IGNORE_STORE,
  addIgnore,
  removeIgnore,
  parseIgnoreStore,
  serializeIgnoreStore,
  type IgnoreStore,
} from "./store-core";

const IGNORE_DIR = "_system/mentions";
const IGNORE_PATH = `${IGNORE_DIR}/ignore.json`;

export async function loadIgnoreStore(app: App): Promise<IgnoreStore> {
  try {
    if (!(await app.vault.adapter.exists(IGNORE_PATH))) return EMPTY_IGNORE_STORE;
    return parseIgnoreStore(await app.vault.adapter.read(IGNORE_PATH));
  } catch {
    return EMPTY_IGNORE_STORE;
  }
}

async function saveIgnoreStore(app: App, store: IgnoreStore): Promise<void> {
  if (!(await app.vault.adapter.exists(IGNORE_DIR))) await app.vault.adapter.mkdir(IGNORE_DIR);
  await app.vault.adapter.write(IGNORE_PATH, serializeIgnoreStore(store));
}

/** Persist "on `sourcePath`, stop offering to link to `target`" (folded key). */
export async function ignoreMention(app: App, target: string, sourcePath: string, now: number): Promise<void> {
  await saveIgnoreStore(app, addIgnore(await loadIgnoreStore(app), target, sourcePath, now));
}

/** Undo a prior ignore for the (target, source) pair. */
export async function unignoreMention(app: App, target: string, sourcePath: string): Promise<void> {
  await saveIgnoreStore(app, removeIgnore(await loadIgnoreStore(app), target, sourcePath));
}
