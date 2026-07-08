/**
 * Orchestrator — pure task-scheduling state machine (no Obsidian imports).
 *
 * This module is the brain of the Orchestration Board. It is a **pure reducer**:
 * given the current list of tasks, a single event, and a config, it returns the
 * next list of tasks plus a list of side-effects for an impure *driver* (task
 * B5, not in this module) to execute — spawning chats, persisting the ledger,
 * arming timers. Nothing here touches disk, DOM, timers, or the network.
 *
 * ```
 *   reduce(tasks, event, config) -> { tasks, effects }
 * ```
 *
 * The driver owns everything impure: it applies the returned `tasks` to the
 * on-disk ledger (`src/core/tasks.ts` shapes/serializes them), executes each
 * effect (e.g. spawn a chat and record the new convo id back onto the task),
 * and feeds convo/scheduler events back in.
 *
 * ## Status model (from `src/core/tasks.ts`)
 *
 *   backlog → queued → running ⇄ needs-input
 *                         running → review ⇄ running
 *                         review → done → archived
 *
 * Backward/lateral moves (any → backlog, review → queued, …) are always allowed
 * via an explicit user `move` event. `review → done` is **user-action-only** —
 * no convo or scheduler event may ever complete a task.
 *
 * The reducer extends `TaskEntry` with two orchestration-only fields
 * (`inputReason`, `chatMissing`); these are additive and optional, so existing
 * `tasks.ts` consumers (parse/format/round-trip) are unaffected.
 */

import type { TaskEntry, TaskStatus } from "./tasks";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Scheduler configuration. */
export interface OrchestratorConfig {
  /** Maximum number of tasks allowed in `running` at once. */
  maxConcurrent: number;
}

/** Default config: two concurrent running tasks. */
export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  maxConcurrent: 2,
};

// ---------------------------------------------------------------------------
// Orchestration-only task extensions
// ---------------------------------------------------------------------------

/**
 * Why a task left `running` for `needs-input`. Rendered as a badge on the
 * board so the user knows whether the agent asked a question, crashed, or was
 * manually stopped. Cleared when the task resumes running.
 */
export type InputReason = "needs-input" | "error" | "stopped";

declare module "./tasks" {
  interface TaskEntry {
    /**
     * Set when the task is in `needs-input`: which convo event parked it there.
     * Undefined in every other status.
     */
    inputReason?: InputReason;
    /**
     * Set by boot reconciliation when the task's recorded convo no longer
     * exists in the live convo store. The driver renders a "chat missing" badge
     * and a re-run spawns a fresh convo (whose id it records back on the task).
     */
    chatMissing?: boolean;
  }
}

// ---------------------------------------------------------------------------
// Events — the feature's central abstraction
// ---------------------------------------------------------------------------

/** The board column a task is dragged/moved into. */
export type MoveTarget = TaskStatus;

/**
 * User-initiated actions. These are the *only* events allowed to complete
 * (`mark-done`) or archive a task, and the only ones that can move a task
 * backward/laterally (`move`).
 */
export type UserEvent =
  /** Backlog → Queued. The scheduler may then promote it to Running. */
  | { type: "enqueue"; taskId: string }
  /** Review → Done. User-action-only; ignored from any non-review status. */
  | { type: "mark-done"; taskId: string }
  /** Done → Archived. Nothing is ever deleted. */
  | { type: "archive"; taskId: string }
  /**
   * Drag/move to an explicit column at an explicit order. Any status → any
   * status, including backward moves. This is how a `chat-missing` task gets
   * re-queued for a fresh run.
   */
  | { type: "move"; taskId: string; target: MoveTarget; order: number }
  /**
   * User follow-up typed into the task's chat. Resumes `needs-input` → Running
   * (input answered) or `review` → Running (new turn requested).
   */
  | { type: "follow-up"; taskId: string };

/**
 * Conversation lifecycle events, keyed by `convoId`. The reducer resolves the
 * convo id to the owning task; events for an **unknown** convo id are no-ops
 * (no state change, no effects).
 */
export type ConvoEvent =
  /** A turn started streaming. Keeps the task Running. */
  | { type: "turn-start"; convoId: string }
  /** A turn ended with no pending requests. Running → Review. */
  | { type: "turn-end"; convoId: string }
  /** The agent is asking for input. Running → Needs Input (reason badge). */
  | { type: "needs-input"; convoId: string }
  /** The turn was stopped. Running → Needs Input (reason badge). */
  | { type: "stopped"; convoId: string }
  /** The turn errored. Running → Needs Input (reason badge). */
  | { type: "error"; convoId: string };

/** Scheduler tick: a slot may have freed up; promote queued tasks if so. */
export type SchedulerEvent = { type: "slot-freed" };

/** The full event union the reducer accepts. */
export type OrchestratorEvent = UserEvent | ConvoEvent | SchedulerEvent;

// ---------------------------------------------------------------------------
// Effects — instructions for the impure driver
// ---------------------------------------------------------------------------

/**
 * Spawn a chat for a task that just entered `running`. The driver creates the
 * conversation, then records the returned convo id back onto the task (via the
 * ledger). Carries enough context (`prompt`, `model`) to start the chat without
 * re-reading the ledger. Emitted both on first run and on a re-run after
 * `chat-missing` — in the latter case a *fresh* convo id is recorded.
 */
export interface SpawnChatEffect {
  type: "spawn-chat";
  taskId: string;
  /** The task prompt, verbatim, to open the conversation with. */
  prompt: string;
  /** Provider model id, if the task pinned one (else driver uses its default). */
  model?: string;
}

/** The effect union the driver must be able to execute. */
export type OrchestratorEffect = SpawnChatEffect;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** What the reducer returns: the next task list plus effects to run. */
export interface OrchestratorResult {
  /** The full task list after applying the event (new array; inputs untouched). */
  tasks: TaskEntry[];
  /** Side-effects for the driver to execute, in order. */
  effects: OrchestratorEffect[];
}

// ---------------------------------------------------------------------------
// Boot reconciliation
// ---------------------------------------------------------------------------

/** A snapshot of one live conversation, taken at boot. */
export interface ConvoSnapshot {
  /** Whether the convo still exists in the live store. */
  exists: boolean;
  /** Whether a turn is currently streaming. */
  streaming: boolean;
  /** Whether the convo is blocked awaiting user input. */
  pendingRequest: boolean;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Shallow clone with field overrides — keeps the reducer pure (no mutation). */
function patch(t: TaskEntry, over: Partial<TaskEntry>): TaskEntry {
  return { ...t, ...over };
}

/** Count how many tasks are currently `running`. */
function runningCount(tasks: TaskEntry[]): number {
  return tasks.reduce((n, t) => n + (t.status === "running" ? 1 : 0), 0);
}

/**
 * Promote as many `queued` tasks to `running` as free slots allow, in queue
 * order (`order` ascending, then id for stability). Returns the mutated task
 * list plus one `spawn-chat` effect per promoted task. Never exceeds the cap.
 * Pure: does not mutate its input.
 */
function fillSlots(
  tasks: TaskEntry[],
  config: OrchestratorConfig
): { tasks: TaskEntry[]; effects: OrchestratorEffect[] } {
  let free = Math.max(0, config.maxConcurrent - runningCount(tasks));
  if (free === 0) return { tasks, effects: [] };

  const queuedOrder = tasks
    .filter((t) => t.status === "queued")
    .sort((a, b) => {
      const ao = a.order ?? Number.MAX_SAFE_INTEGER;
      const bo = b.order ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const promote = new Set<string>();
  for (const t of queuedOrder) {
    if (free === 0) break;
    promote.add(t.id);
    free--;
  }
  if (promote.size === 0) return { tasks, effects: [] };

  const effects: OrchestratorEffect[] = [];
  const next = tasks.map((t) => {
    if (!promote.has(t.id)) return t;
    effects.push({
      type: "spawn-chat",
      taskId: t.id,
      prompt: t.prompt,
      ...(t.model ? { model: t.model } : {}),
    });
    // Promoting clears any stale chat-missing flag; the driver records the
    // fresh convo id when it executes the spawn effect.
    return patch(t, { status: "running", chatMissing: undefined });
  });
  return { tasks: next, effects };
}

/** Replace one task by id; no-op if not found. Pure. */
function mapTask(
  tasks: TaskEntry[],
  id: string,
  fn: (t: TaskEntry) => TaskEntry
): TaskEntry[] {
  return tasks.map((t) => (t.id === id ? fn(t) : t));
}

/** Find the task owning a convo id, or undefined. */
function taskByConvo(tasks: TaskEntry[], convoId: string): TaskEntry | undefined {
  return tasks.find((t) => t.convo === convoId);
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * The pure orchestration reducer. Applies a single event and returns the next
 * task list plus effects. Never mutates its inputs.
 *
 * Unknown ids (task id for user events, convo id for convo events) are no-ops:
 * the original task list is returned with no effects.
 */
export function reduce(
  tasks: TaskEntry[],
  event: OrchestratorEvent,
  config: OrchestratorConfig = DEFAULT_ORCHESTRATOR_CONFIG
): OrchestratorResult {
  switch (event.type) {
    // --- User actions ----------------------------------------------------
    case "enqueue": {
      const t = tasks.find((x) => x.id === event.taskId);
      if (!t) return { tasks, effects: [] };
      // Only backlog tasks enqueue; anything else is a no-op.
      if (t.status !== "backlog") return { tasks, effects: [] };
      const queued = mapTask(tasks, event.taskId, (x) => patch(x, { status: "queued" }));
      // The scheduler immediately promotes if a slot is free.
      return fillSlots(queued, config);
    }

    case "mark-done": {
      const t = tasks.find((x) => x.id === event.taskId);
      if (!t) return { tasks, effects: [] };
      // USER-ACTION-ONLY completion, and only from review.
      if (t.status !== "review") return { tasks, effects: [] };
      const next = mapTask(tasks, event.taskId, (x) => patch(x, { status: "done" }));
      return { tasks: next, effects: [] };
    }

    case "archive": {
      const t = tasks.find((x) => x.id === event.taskId);
      if (!t) return { tasks, effects: [] };
      if (t.status !== "done") return { tasks, effects: [] };
      const next = mapTask(tasks, event.taskId, (x) => patch(x, { status: "archived" }));
      return { tasks: next, effects: [] };
    }

    case "move": {
      const t = tasks.find((x) => x.id === event.taskId);
      if (!t) return { tasks, effects: [] };
      // Any → any, backward or lateral. Clears the input badge when leaving
      // needs-input; the driver reconciles convo state separately.
      const moved = mapTask(tasks, event.taskId, (x) =>
        patch(x, {
          status: event.target,
          order: event.order,
          inputReason: undefined,
        })
      );
      // Moving out of running may free a slot; moving into queued may want a
      // slot. Either way, let the scheduler fill any free slots.
      return fillSlots(moved, config);
    }

    case "follow-up": {
      const t = tasks.find((x) => x.id === event.taskId);
      if (!t) return { tasks, effects: [] };
      // Resume from review or needs-input back to running. Clears the badge.
      if (t.status !== "review" && t.status !== "needs-input") {
        return { tasks, effects: [] };
      }
      const next = mapTask(tasks, event.taskId, (x) =>
        patch(x, { status: "running", inputReason: undefined })
      );
      return { tasks: next, effects: [] };
    }

    // --- Convo events ----------------------------------------------------
    case "turn-start": {
      const owner = taskByConvo(tasks, event.convoId);
      if (!owner) return { tasks, effects: [] }; // unknown convo → no-op
      // Streaming resumed: keep/return to running. No effects.
      if (owner.status === "running") return { tasks, effects: [] };
      const next = mapTask(tasks, owner.id, (x) =>
        patch(x, { status: "running", inputReason: undefined })
      );
      return { tasks: next, effects: [] };
    }

    case "turn-end": {
      const owner = taskByConvo(tasks, event.convoId);
      if (!owner) return { tasks, effects: [] }; // unknown convo → no-op
      // Only a running task moves to review on turn-end. A review/needs-input
      // task staying put is fine — turn-end can NEVER complete a task.
      if (owner.status !== "running") return { tasks, effects: [] };
      const reviewed = mapTask(tasks, owner.id, (x) => patch(x, { status: "review" }));
      // The freed slot lets the next queued task start.
      return fillSlots(reviewed, config);
    }

    case "needs-input":
    case "stopped":
    case "error": {
      const owner = taskByConvo(tasks, event.convoId);
      if (!owner) return { tasks, effects: [] }; // unknown convo → no-op
      if (owner.status !== "running") return { tasks, effects: [] };
      const parked = mapTask(tasks, owner.id, (x) =>
        patch(x, { status: "needs-input", inputReason: event.type })
      );
      // A parked task frees its slot for the next queued task.
      return fillSlots(parked, config);
    }

    // --- Scheduler -------------------------------------------------------
    case "slot-freed":
      return fillSlots(tasks, config);
  }
}

// ---------------------------------------------------------------------------
// Boot reconciliation (also pure)
// ---------------------------------------------------------------------------

/**
 * Reconcile persisted task statuses against a snapshot of live conversations at
 * boot. Pure — returns a corrected task list (new array), never mutates input,
 * never touches I/O.
 *
 * Rules, per task that has an *active* recorded convo (running / needs-input /
 * review — the statuses that imply a live chat):
 *
 * - **convo missing** → keep the status, set `chatMissing: true`. A later
 *   re-run (user re-queues → `slot-freed`) spawns a fresh convo; the reducer's
 *   `spawn-chat` effect lets the driver record the new id.
 * - **convo streaming** → correct to `running` (clear any badge).
 * - **convo pending input** → correct to `needs-input`.
 * - **convo idle** (exists, not streaming, no pending) → the turn is over →
 *   `review`.
 *
 * Terminal / pre-run statuses (`backlog`, `queued`, `done`, `archived`) are
 * never disturbed and never flagged, even if a stray live convo matches.
 */
export function reconcile(
  tasks: TaskEntry[],
  convos: Map<string, ConvoSnapshot>,
  _config: OrchestratorConfig = DEFAULT_ORCHESTRATOR_CONFIG
): OrchestratorResult {
  const ACTIVE: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
    "running",
    "needs-input",
    "review",
  ]);

  const next = tasks.map((t) => {
    // Only tasks whose status implies a live chat get reconciled.
    if (!ACTIVE.has(t.status)) {
      // Ensure no stale chatMissing lingers on a pre-run/terminal task.
      return t.chatMissing ? patch(t, { chatMissing: undefined }) : t;
    }

    const snap = t.convo ? convos.get(t.convo) : undefined;

    // Convo gone (no recorded id, or id not in the live store): flag it.
    if (!snap || !snap.exists) {
      return patch(t, { chatMissing: true });
    }

    // Convo alive: derive the true status from its runtime state.
    let corrected: TaskStatus;
    if (snap.streaming) corrected = "running";
    else if (snap.pendingRequest) corrected = "needs-input";
    else corrected = "review";

    return patch(t, {
      status: corrected,
      chatMissing: undefined,
      inputReason: corrected === "needs-input" ? "needs-input" : undefined,
    });
  });

  return { tasks: next, effects: [] };
}
