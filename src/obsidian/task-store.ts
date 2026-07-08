/**
 * B3 task-store — the single write path for creating Orchestration Board
 * tasks (`_system/orchestration/tasks.md`). Both the `add_task` SDK tool
 * (chat-driven) and the board's own quick-add UI must create tasks through
 * `createBacklogTask` so every write is serialized on the SAME `WriteQueue`
 * instance — never a direct `vault.modify`/`adapter.write` from a caller —
 * exactly the contract already used for the Memory Union Store
 * (`memoryWriteQueue`) and the Open-Loops Ledger (`loopsWriteQueue`) in
 * `src/obsidian/tools.ts`.
 *
 * `TaskVaultAdapter` is a small structural slice of the real Obsidian
 * `App`/`Vault` API — just enough to read/create/modify the single ledger
 * file — so this module stays unit-testable with an in-memory fake instead of
 * requiring a real Obsidian `App`.
 */
import type { App, TFile } from "obsidian";
import { addBacklogTask, TASKS_PATH, type NewBacklogTask, type TaskEntry } from "../core/tasks";
import type { WriteQueue } from "../core/write-queue";

/** Structural slice of the vault API this module needs. Real Obsidian's
 *  `App`/`Vault` satisfies this shape via `adaptAppToTaskVault` below; tests
 *  can supply a plain in-memory fake instead. */
export interface TaskVaultAdapter {
  /** Return a lightweight file handle if `path` exists, else null. */
  getFile(path: string): { path: string } | null;
  read(path: string): Promise<string>;
  create(path: string, content: string): Promise<void>;
  modify(path: string, content: string): Promise<void>;
  /** Create any missing parent folders for `path` (no-op if they exist). */
  ensureFolder(dir: string): Promise<void>;
}

/** Adapt a real Obsidian `App` to `TaskVaultAdapter`. Kept tiny and isolated
 *  so the read-modify-write logic in `createBacklogTask` never touches
 *  `app.vault` directly — that logic is exercised by unit tests against a
 *  fake adapter instead. */
export function adaptAppToTaskVault(app: App): TaskVaultAdapter {
  return {
    getFile(path: string) {
      const f = app.vault.getAbstractFileByPath(path);
      return f ? { path: (f as TFile).path } : null;
    },
    read: (path: string) => app.vault.read(app.vault.getAbstractFileByPath(path) as TFile),
    create: async (path: string, content: string) => {
      await app.vault.create(path, content);
    },
    modify: async (path: string, content: string) => {
      await app.vault.modify(app.vault.getAbstractFileByPath(path) as TFile, content);
    },
    ensureFolder: async (path: string) => {
      const slash = path.lastIndexOf("/");
      if (slash <= 0) return;
      const dir = path.slice(0, slash);
      if (app.vault.getAbstractFileByPath(dir)) return;
      try {
        await app.vault.createFolder(dir);
      } catch {
        /* already exists (race) — fine */
      }
    },
  };
}

/**
 * Create a new `backlog` task and persist it to the tasks ledger, through
 * `queue` (the caller's shared `WriteQueue` — same one the board uses for its
 * own writes). Returns the created entry. Never writes outside the queue.
 */
export async function createBacklogTask(
  vault: TaskVaultAdapter,
  queue: WriteQueue,
  task: NewBacklogTask
): Promise<TaskEntry> {
  return queue.enqueue(async () => {
    const existing = vault.getFile(TASKS_PATH);
    const current = existing ? await vault.read(TASKS_PATH) : "";
    const { content, entry } = addBacklogTask(current, task);
    if (existing) {
      await vault.modify(TASKS_PATH, content);
    } else {
      await vault.ensureFolder(TASKS_PATH);
      await vault.create(TASKS_PATH, content);
    }
    return entry;
  });
}
