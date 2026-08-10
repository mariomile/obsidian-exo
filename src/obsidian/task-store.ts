/**
 * B3 task-store — the single write path for creating Orchestration Board
 * tasks (the `paths.tasks` ledger). Both the `add_task` SDK tool
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
  formatTask,
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
  task: NewBacklogTask,
  tasksPath: string = TASKS_PATH
): Promise<TaskEntry> {
  return queue.enqueue(async () => {
    const existing = vault.getFile(tasksPath);
    const current = existing ? await vault.read(tasksPath) : "";
    const { content, entry } = addBacklogTask(current, task);
    if (existing) {
      await vault.modify(tasksPath, content);
    } else {
      await vault.ensureFolder(tasksPath);
      await vault.create(tasksPath, content);
    }
    return entry;
  });
}

/** `task-<epoch>` id pattern, matched against `TaskEntry.id` — mirrors the id
 *  shape `addBacklogTask` generates (`task-${Date.now()}`). */
const ID_EPOCH = /^task-(\d+)$/;

/** An epoch strictly greater than every existing `task-<epoch>` id already in
 *  `content`, so ids stay unique even when several fan-out writes land within
 *  the same millisecond — `Date.now()` has 1ms resolution and the `WriteQueue`
 *  only guarantees ORDER, not that time has visibly advanced between turns.
 *  Falls back to the wall clock when it is already ahead of every existing id. */
function nextUniqueEpoch(content: string): number {
  const now = Date.now();
  let maxExisting = 0;
  for (const { id } of parseTasksFile(content)) {
    const m = ID_EPOCH.exec(id);
    if (!m) continue;
    const epoch = Number(m[1]);
    if (epoch > maxExisting) maxExisting = epoch;
  }
  return Math.max(now, maxExisting + 1);
}

/** Thrown by `createChildTask` when its `gate` callback refuses the spawn.
 *  Evaluated against a FRESH read taken INSIDE the same queued turn as the
 *  write, so concurrent callers each judge the ledger as of their own turn —
 *  not a snapshot read before they were enqueued (see `createChildTask` doc).
 *  Carries the gate's own refusal text so a caller (the `spawn_task` tool)
 *  can surface it to the agent verbatim without a second gate evaluation. */
export class ChildTaskRefused extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

/**
 * Create a task spawned BY a conversation (fan-out). Same queued write path as
 * `createBacklogTask` — one shared `WriteQueue`, so chat-driven and board-driven
 * creation never interleave a read-modify-write — with three differences: the
 * entry carries its `parent` convo id, it starts `queued` rather than
 * `backlog` (a delegated task is meant to run as soon as the orchestrator has
 * a free slot), and its id's epoch is bumped past any id already in the file
 * so same-millisecond fan-out never collides (see `nextUniqueEpoch`).
 *
 * `gate`, if given, runs INSIDE the queued turn against the ledger this same
 * turn just read — never against a snapshot taken before `enqueue` — so N
 * concurrent `createChildTask` calls (the canonical fan-out gesture: one
 * assistant turn issuing several `spawn_task` calls in parallel) each judge
 * an up-to-date count instead of racing on a stale read that would let all N
 * pass a cap simultaneously. A refusal throws `ChildTaskRefused` and writes
 * NOTHING — the queue's error isolation (see `WriteQueue`) means this
 * rejection affects only this call's own promise, not later queued turns.
 *
 * The `backlog`→`queued` patch is applied by slicing the freshly-appended
 * block out of `content` by its byte offset (`lastIndexOf`), never via
 * `String.prototype.replace(searchBlock, replacementBlock)` — the replacement
 * form treats `$$`/`$&`/`` $` ``/`$'` in the REPLACEMENT string as
 * substitution patterns, and the replacement here is `formatTask(queued)`,
 * which embeds the caller-supplied prompt/title verbatim. A prompt containing
 * e.g. `$&` would silently splice a copy of the whole matched block into
 * itself, corrupting the ledger.
 */
export async function createChildTask(
  vault: TaskVaultAdapter,
  queue: WriteQueue,
  task: NewBacklogTask & { parent: string },
  tasksPath: string = TASKS_PATH,
  gate?: (tasks: TaskEntry[]) => { ok: true } | { ok: false; reason: string }
): Promise<TaskEntry> {
  return queue.enqueue(async () => {
    const existing = vault.getFile(tasksPath);
    const current = existing ? await vault.read(tasksPath) : "";
    if (gate) {
      const verdict = gate(parseTasksFile(current));
      if (!verdict.ok) throw new ChildTaskRefused(verdict.reason);
    }
    const now = nextUniqueEpoch(current);
    const { content, entry } = addBacklogTask(current, task, now);
    const queued: TaskEntry = { ...entry, status: "queued" };
    const backlogBlock = formatTask(entry);
    const idx = content.lastIndexOf(backlogBlock);
    const next =
      idx === -1
        ? content
        : content.slice(0, idx) + formatTask(queued) + content.slice(idx + backlogBlock.length);
    if (existing) {
      await vault.modify(tasksPath, next);
    } else {
      await vault.ensureFolder(tasksPath);
      await vault.create(tasksPath, next);
    }
    return queued;
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
 * The ONLY module allowed to touch the tasks ledger. Owns
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
    private readonly queue: WriteQueue,
    /** Vault-relative tasks-ledger path. Defaults to the legacy location
     *  (tests + fallback); production passes the configured `plugin.paths.tasks`. */
    private readonly tasksPath: string = TASKS_PATH
  ) {}

  /** Missing file -> `{ tasks: [], warnings: [] }`, never an error. Malformed
   *  blocks are parsed tolerantly (never thrown on) and surfaced as warnings. */
  async load(): Promise<LoadedTasks> {
    const existing = this.vault.getFile(this.tasksPath);
    if (!existing) return { tasks: [], warnings: [] };
    let content: string;
    try {
      content = await this.vault.read(this.tasksPath);
    } catch (e) {
      // Unreadable/corrupt file (I/O error, permissions, etc.) — never throw,
      // surface it as a warning so the board can render its notice state.
      const msg = e instanceof Error ? e.message : String(e);
      return { tasks: [], warnings: [`Could not read ${this.tasksPath}: ${msg}`] };
    }
    return parseTasksFileWithWarnings(content);
  }

  /** Create a new `backlog` task. Thin wrapper over `createBacklogTask` so
   *  there is exactly one implementation of the create read-modify-write. */
  create(task: NewBacklogTask): Promise<TaskEntry> {
    return createBacklogTask(this.vault, this.queue, task, this.tasksPath);
  }

  /**
   * Create a backlog task once for a durable caller marker. The lookup and
   * append share the normal task queue, so concurrent retries cannot both
   * create the same marked task.
   */
  createOnce(task: NewBacklogTask, marker: string): Promise<TaskEntry> {
    return this.queue.enqueue(async () => {
      const existing = this.vault.getFile(this.tasksPath);
      const current = existing ? await this.vault.read(this.tasksPath) : "";
      const prior = parseTasksFile(current).find(({ prompt }) => prompt.includes(marker));
      if (prior) return prior;

      const { content, entry } = addBacklogTask(current, task);
      if (existing) {
        await this.vault.modify(this.tasksPath, content);
      } else {
        await this.vault.ensureFolder(this.tasksPath);
        await this.vault.create(this.tasksPath, content);
      }
      return entry;
    });
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
      const existing = this.vault.getFile(this.tasksPath);
      const current = existing ? await this.vault.read(this.tasksPath) : "";
      const tasks = current ? parseTasksFile(current) : [];
      const now = Date.now();
      const next = apply(tasks, now);
      const content = serializeTasks(next);
      if (existing) {
        await this.vault.modify(this.tasksPath, content);
      } else {
        await this.vault.ensureFolder(this.tasksPath);
        await this.vault.create(this.tasksPath, content);
      }
      const updatedEntry = next.find((t) => t.id === id);
      if (!updatedEntry) throw new Error(`Task not found: ${id}`);
      return updatedEntry;
    });
  }
}
