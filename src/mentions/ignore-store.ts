/**
 * Sidecar persistence for the unlinked-mention ignore-list. The store itself is
 * pure (`store-core.ts`); this module is the thin Obsidian I/O layer that reads
 * and writes ignore.json in the mentions dir. Tolerant of an absent/corrupt file
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
import { exoPaths, LEGACY_MEMORY_ROOT } from "../core/paths";

/** Default mentions dir — the legacy location for tests/fallback; live
 *  callers pass the configured `paths.mentions`. */
const LEGACY_IGNORE_DIR = exoPaths(LEGACY_MEMORY_ROOT).mentions;
const ignorePath = (dir: string) => `${dir}/ignore.json`;

export async function loadIgnoreStore(app: App, dir: string = LEGACY_IGNORE_DIR): Promise<IgnoreStore> {
  const path = ignorePath(dir);
  try {
    if (!(await app.vault.adapter.exists(path))) return EMPTY_IGNORE_STORE;
    return parseIgnoreStore(await app.vault.adapter.read(path));
  } catch {
    return EMPTY_IGNORE_STORE;
  }
}

async function saveIgnoreStore(app: App, store: IgnoreStore, dir: string): Promise<void> {
  if (!(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
  await app.vault.adapter.write(ignorePath(dir), serializeIgnoreStore(store));
}

/** Persist "on `sourcePath`, stop offering to link to `target`" (folded key). */
export async function ignoreMention(
  app: App,
  target: string,
  sourcePath: string,
  now: number,
  dir: string = LEGACY_IGNORE_DIR
): Promise<void> {
  await saveIgnoreStore(app, addIgnore(await loadIgnoreStore(app, dir), target, sourcePath, now), dir);
}

/** Undo a prior ignore for the (target, source) pair. */
export async function unignoreMention(
  app: App,
  target: string,
  sourcePath: string,
  dir: string = LEGACY_IGNORE_DIR
): Promise<void> {
  await saveIgnoreStore(app, removeIgnore(await loadIgnoreStore(app, dir), target, sourcePath), dir);
}
