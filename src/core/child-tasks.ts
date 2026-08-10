/**
 * Fan-out caps — pure predicates over the task ledger (no Obsidian imports).
 *
 * A "child task" is a ledger entry whose `parent` is the convo id of the
 * conversation that spawned it. Two caps keep a delegating agent from running
 * away: how many children one parent may have open at once, and how deep the
 * chain may go. Concurrency itself is NOT decided here — that stays the
 * orchestrator reducer's `maxConcurrent`.
 */
import type { TaskEntry } from "./tasks";

/** Max children per parent that are not yet done/archived. */
export const MAX_OPEN_CHILDREN = 5;
/** Max chain length: parent → child → grandchild, then refuse. */
export const MAX_FANOUT_DEPTH = 2;

/**
 * Statuses that no longer occupy a fan-out slot.
 *
 * Note what is NOT here: `review`, where a finished child parks. Finishing
 * therefore does NOT free a slot — only a human marking the card done or
 * archiving it does. That is deliberate (the cap counts children Mario still
 * has to supervise, and one waiting to be read is one of them), and the refusal
 * text below has to say so, or the agent sits waiting for something that will
 * never happen on its own.
 */
const CLOSED = new Set<TaskEntry["status"]>(["done", "archived"]);

export function childrenOf(tasks: TaskEntry[], parentConvoId: string): TaskEntry[] {
  return tasks.filter((t) => t.parent === parentConvoId);
}

export function openChildCount(tasks: TaskEntry[], parentConvoId: string): number {
  return childrenOf(tasks, parentConvoId).filter((t) => !CLOSED.has(t.status)).length;
}

/**
 * How many spawn hops separate `convoId` from a human-started conversation.
 * Walks up via "the task whose `convo` is this convo" → its `parent`. The
 * visited set makes a hand-edited cyclic ledger terminate instead of hanging.
 */
export function fanoutDepth(tasks: TaskEntry[], convoId: string): number {
  let depth = 0;
  let current = convoId;
  const seen = new Set<string>([current]);
  for (;;) {
    const owning = tasks.find((t) => t.convo === current && t.parent);
    if (!owning || !owning.parent) return depth;
    depth++;
    current = owning.parent;
    if (seen.has(current)) return depth;
    seen.add(current);
  }
}

/** Whether `parentConvoId` may spawn one more child right now. */
export function canSpawnChild(
  tasks: TaskEntry[],
  parentConvoId: string
): { ok: true } | { ok: false; reason: string } {
  const open = openChildCount(tasks, parentConvoId);
  if (open >= MAX_OPEN_CHILDREN) {
    return {
      ok: false,
      reason: `This conversation already has ${open} open child tasks (cap ${MAX_OPEN_CHILDREN}). Ask Mario to mark one done or archive it on the board to free a slot — a finished child parks in Review and keeps its slot until he does.`,
    };
  }
  const depth = fanoutDepth(tasks, parentConvoId);
  if (depth >= MAX_FANOUT_DEPTH) {
    return {
      ok: false,
      reason: `Delegation depth ${depth} is at the cap (${MAX_FANOUT_DEPTH}). Do this work here instead of spawning another level.`,
    };
  }
  return { ok: true };
}
