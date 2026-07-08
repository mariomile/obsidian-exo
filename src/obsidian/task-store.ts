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
import {
  addBacklogTask,
  applyTaskArchive,
  applyTaskMove,
  applyTaskPatch,
  parseTasksFile,
  parseTasksFileWithWarnings,
  serializeTasks,
  TASKS_PATH,
  type NewBacklogTask,
  type TaskEntry,
  type TaskPatch,
  type TaskStatus,
} from "../core/tasks";
import { WriteQueue } from "../core/write-queue";

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

/** Result of `TaskStore.load()` — the board's error/notice state is driven by `warnings`. */
export interface LoadedTasks {
  tasks: TaskEntry[];
  /** Non-fatal, human-readable notes about malformed blocks (missing title,
   *  bad timestamps, unrecognized status, or a file that couldn't be read at
   *  all). Never populated by throwing — `load()` always resolves. */
  warnings: string[];
}

/**
 * The ONLY module allowed to touch `_system/orchestration/tasks.md`. Owns
 * every read and, more importantly, serializes every write through ONE shared
 * `WriteQueue` instance (constructor-injected — same contract as
 * `createBacklogTask` above and the Memory Union Store / Open-Loops Ledger in
 * `src/obsidian/tools.ts`) so the board's own writes and the chat-driven
 * `add_task` tool can never interleave a read-modify-write cycle and clobber
 * each other.
 *
 * Every mutation (`create`/`update`/`move`/`archive`) is a queued
 * read-modify-write: re-read the file fresh inside the queue turn, apply the
 * pure mutation from `src/core/tasks.ts`, serialize, write. `load()` is a
 * plain read and does not need the queue (nothing to serialize against
 * itself), but never throws — a missing file yields an empty list, and
 * unreadable/corrupt content is handled tolerantly.
 */
export class TaskStore {
  constructor(
    private readonly vault: TaskVaultAdapter,
    private readonly queue: WriteQueue
  ) {}

  /** Missing file -> `{ tasks: [], warnings: [] }`, never an error. Malformed
   *  blocks are parsed tolerantly (never thrown on) and surfaced as warnings. */
  async load(): Promise<LoadedTasks> {
    const existing = this.vault.getFile(TASKS_PATH);
    if (!existing) return { tasks: [], warnings: [] };
    let content: string;
    try {
      content = await this.vault.read(TASKS_PATH);
    } catch (e) {
      // Unreadable/corrupt file (I/O error, permissions, etc.) — never throw,
      // surface it as a warning so the board can render its notice state.
      const msg = e instanceof Error ? e.message : String(e);
      return { tasks: [], warnings: [`Could not read ${TASKS_PATH}: ${msg}`] };
    }
    return parseTasksFileWithWarnings(content);
  }

  /** Create a new `backlog` task. Thin wrapper over `createBacklogTask` so
   *  there is exactly one implementation of the create read-modify-write. */
  create(task: NewBacklogTask): Promise<TaskEntry> {
    return createBacklogTask(this.vault, this.queue, task);
  }

  /** Patch arbitrary fields on an existing task (title/prompt/model/convo/status/order). */
  update(id: string, patch: TaskPatch): Promise<TaskEntry> {
    return this.mutate(id, (tasks, now) => applyTaskPatch(tasks, id, patch, now));
  }

  /** Move a task to a new column/position (status + order), board drag-and-drop. */
  move(id: string, status: TaskStatus, order: number): Promise<TaskEntry> {
    return this.mutate(id, (tasks, now) => applyTaskMove(tasks, id, status, order, now));
  }

  /** Archive a task: sets `status: archived`, keeps the block. Nothing is ever
   *  deleted from tasks.md — there is no delete method on this store. */
  archive(id: string): Promise<TaskEntry> {
    return this.mutate(id, (tasks, now) => applyTaskArchive(tasks, id, now));
  }

  /** Shared queued read-modify-write for update/move/archive: re-read the file
   *  fresh inside the queue turn (so concurrent mutations never race on a
   *  stale in-memory copy), apply the pure mutation, serialize, write. Throws
   *  (rejecting the returned promise) if `id` doesn't exist — same
   *  no-silent-no-op contract as the pure `applyTask*` helpers. */
  private mutate(id: string, apply: (tasks: TaskEntry[], now: number) => TaskEntry[]): Promise<TaskEntry> {
    return this.queue.enqueue(async () => {
      const existing = this.vault.getFile(TASKS_PATH);
      const current = existing ? await this.vault.read(TASKS_PATH) : "";
      const tasks = current ? parseTasksFile(current) : [];
      const now = Date.now();
      const next = apply(tasks, now);
      const content = serializeTasks(next);
      if (existing) {
        await this.vault.modify(TASKS_PATH, content);
      } else {
        await this.vault.ensureFolder(TASKS_PATH);
        await this.vault.create(TASKS_PATH, content);
      }
      const updatedEntry = next.find((t) => t.id === id);
      if (!updatedEntry) throw new Error(`Task not found: ${id}`);
      return updatedEntry;
    });
  }
}
