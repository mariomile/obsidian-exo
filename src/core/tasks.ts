/**
 * Orchestration Board — task ledger, pure logic (no Obsidian imports).
 *
 * A "task" is a unit of work that can spawn an Exo chat conversation. Tasks
 * persist in a single markdown file (`_system/orchestration/tasks.md`), one
 * block per entry, mirroring the Open-Loops Ledger's block format
 * (`src/core/open-loops.ts`):
 *
 *   ## task-<epochMs>
 *   - title: <title>
 *   - status: backlog|queued|running|needs-input|review|done|archived
 *   - created: <ISO-8601>
 *   - updated: <ISO-8601>
 *   - model: <provider model id>      (omitted → default from settings)
 *   - convo: <convo-id>               (omitted until the task first runs)
 *   - order: <number>                 (position within its column)
 *
 *   <task prompt — verbatim, multi-line markdown>
 *
 * Same rules as the ledger: tolerant parsing (garbage lines between/around
 * blocks are skipped, never thrown on — the file is hand-editable),
 * `formatTask` ∘ `parseTasksFile` round-trips, archived-not-deleted.
 *
 * This module only shapes and mutates in-memory strings/content; ALL actual
 * disk writes go through `src/obsidian/task-store.ts`, which enqueues onto the
 * shared `WriteQueue` (same contract as the Memory Union Store and the
 * Open-Loops Ledger) so board-driven and chat-driven task creation never
 * interleave a read-modify-write cycle.
 */

/** Canonical on-disk path for the tasks ledger. */
export const TASKS_PATH = "_system/orchestration/tasks.md";

export type TaskStatus =
  | "backlog"
  | "queued"
  | "running"
  | "needs-input"
  | "review"
  | "done"
  | "archived";

const VALID_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "backlog",
  "queued",
  "running",
  "needs-input",
  "review",
  "done",
  "archived",
]);

export interface TaskEntry {
  /** Stable id, shaped `task-<epochMs>`. */
  id: string;
  title: string;
  status: TaskStatus;
  /** ISO-8601 creation timestamp. */
  created: string;
  /** ISO-8601 last-updated timestamp. */
  updated: string;
  /** Provider model id this task runs with — omitted → default from settings. */
  model?: string;
  /** Convo id once the task has first run — omitted until then. */
  convo?: string;
  /** Position within its column — omitted when unset. */
  order?: number;
  /** The task prompt, stored verbatim (multi-line markdown). */
  prompt: string;
}

/** Block header, e.g. `## task-1720000000000`. No `g` flag: safe for `.test`. */
const HEADER = /^##\s+(task-\d+)\s*$/;
/** A metadata line inside a block, e.g. `- title: Write the launch post`. */
const META = /^-\s+(title|status|created|updated|model|convo|order):\s*(.*)$/;

/** Render one entry to its canonical on-disk block (no trailing newline). */
export function formatTask(e: TaskEntry): string {
  const lines = [
    `## ${e.id}`,
    `- title: ${e.title}`,
    `- status: ${e.status}`,
    `- created: ${e.created}`,
    `- updated: ${e.updated}`,
  ];
  if (e.model) lines.push(`- model: ${e.model}`);
  if (e.convo) lines.push(`- convo: ${e.convo}`);
  if (e.order !== undefined) lines.push(`- order: ${e.order}`);
  lines.push("", e.prompt);
  return lines.join("\n");
}

/** Parse a whole tasks ledger file into entries. Junk between/around blocks is
 *  ignored, never thrown on — the file is hand-editable. */
export function parseTasksFile(content: string): TaskEntry[] {
  const lines = content.split(/\r?\n/);
  const entries: TaskEntry[] = [];
  let i = 0;
  while (i < lines.length) {
    const head = HEADER.exec(lines[i]);
    if (!head) {
      i++;
      continue;
    }
    const id = head[1];
    i++;

    let title = "";
    let status: TaskStatus = "backlog";
    let created = "";
    let updated = "";
    let model: string | undefined;
    let convo: string | undefined;
    let order: number | undefined;

    for (let m: RegExpExecArray | null; i < lines.length && (m = META.exec(lines[i])); i++) {
      const key = m[1];
      const val = m[2].trim();
      if (key === "title") title = val;
      // Any value other than a recognized status is tolerated as "backlog" —
      // hand-edited junk in this field must never break the rest of the parse.
      else if (key === "status") status = (VALID_STATUSES.has(val as TaskStatus) ? val : "backlog") as TaskStatus;
      else if (key === "created") created = val;
      else if (key === "updated") updated = val;
      else if (key === "model") model = val || undefined;
      else if (key === "convo") convo = val || undefined;
      else if (key === "order") {
        const n = Number(val);
        if (Number.isFinite(n)) order = n;
      }
    }

    // Optional single blank line separating metadata from the verbatim prompt.
    if (i < lines.length && lines[i].trim() === "") i++;

    const textLines: string[] = [];
    while (i < lines.length && !HEADER.test(lines[i])) textLines.push(lines[i++]);
    const prompt = textLines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");

    entries.push({
      id,
      title,
      status,
      created,
      updated,
      ...(model ? { model } : {}),
      ...(convo ? { convo } : {}),
      ...(order !== undefined ? { order } : {}),
      prompt,
    });
  }
  return entries;
}

/** Render a full list of entries back to on-disk file content — the inverse of
 *  `parseTasksFile`. Blocks are joined by a blank line, matching the shape
 *  `addBacklogTask` already produces; entries are never dropped. */
export function serializeTasks(entries: TaskEntry[]): string {
  if (entries.length === 0) return "";
  return `${entries.map(formatTask).join("\n\n")}\n`;
}

/** Raw `- status: <value>` line for a given block id, read straight from the
 *  file text — used only to detect whether the ORIGINAL on-disk value was a
 *  recognized status, since `parseTasksFile` already tolerantly coerces
 *  anything unrecognized to `backlog` and does not keep the raw value around. */
function rawStatusValues(content: string): Map<string, string> {
  const lines = content.split(/\r?\n/);
  const raw = new Map<string, string>();
  let currentId: string | undefined;
  for (const line of lines) {
    const head = HEADER.exec(line);
    if (head) {
      currentId = head[1];
      continue;
    }
    if (!currentId) continue;
    const m = META.exec(line);
    if (m && m[1] === "status") raw.set(currentId, m[2].trim());
  }
  return raw;
}

/**
 * Same parse as `parseTasksFile`, but also surfaces non-fatal "warnings" for
 * blocks that look malformed — missing title, missing/unparseable timestamps,
 * or a status value that had to be tolerantly coerced to `backlog`. Parsing
 * NEVER throws either way; this exists so a caller (the board UI) can show a
 * notice like "2 tasks had malformed data" without re-implementing detection.
 */
export function parseTasksFileWithWarnings(content: string): { tasks: TaskEntry[]; warnings: string[] } {
  const tasks = parseTasksFile(content);
  const rawStatus = rawStatusValues(content);
  const warnings: string[] = [];
  for (const t of tasks) {
    const problems: string[] = [];
    if (!t.title) problems.push("missing title");
    if (!t.created || !Number.isFinite(Date.parse(t.created))) problems.push("missing/invalid created date");
    if (!t.updated || !Number.isFinite(Date.parse(t.updated))) problems.push("missing/invalid updated date");
    const raw = rawStatus.get(t.id);
    if (raw !== undefined && !VALID_STATUSES.has(raw as TaskStatus)) {
      problems.push(`unrecognized status "${raw}" (defaulted to backlog)`);
    }
    if (problems.length) warnings.push(`${t.id}: ${problems.join(", ")}`);
  }
  return { tasks, warnings };
}

/** Fields the caller supplies to create a new backlog task. */
export interface NewBacklogTask {
  title: string;
  prompt: string;
  model?: string;
}

/**
 * Append a new `backlog` task to `content` (the current file text). Pure —
 * returns the new file content plus the created entry; callers (the
 * `add_task` tool, the "Promote to task" command, the board's quick-add) are
 * responsible for the actual read-modify-write against disk, always through
 * the shared `WriteQueue` (see `src/obsidian/task-store.ts`).
 */
export function addBacklogTask(
  content: string,
  task: NewBacklogTask,
  now: number = Date.now()
): { content: string; entry: TaskEntry } {
  const iso = new Date(now).toISOString();
  const entry: TaskEntry = {
    id: `task-${now}`,
    // `title` is a metadata line (`- title: …`) — a literal newline would spill
    // into the next line and be misparsed as a bogus `- status:`/etc entry,
    // silently corrupting this block's fields (never throws, but the task
    // would render wrong on the board). Collapse to one line defensively; the
    // caller (add_task tool args, or the "Promote to task" command) may pass
    // arbitrary text here.
    title: task.title.replace(/\r?\n+/g, " ").trim(),
    status: "backlog",
    created: iso,
    updated: iso,
    ...(task.model ? { model: task.model } : {}),
    prompt: task.prompt,
  };
  const block = formatTask(entry);
  const trimmed = content.replace(/\s+$/, "");
  const next = trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  return { content: next, entry };
}

/** Fields patchable via `applyTaskPatch` — anything but `id`/`created` (immutable identity/history). */
export type TaskPatch = Partial<Pick<TaskEntry, "title" | "status" | "prompt" | "model" | "convo" | "order">>;

/**
 * Apply a partial update to one entry in `entries`, bumping `updated` to
 * `now`. Every other entry is returned unchanged (new array either way — pure).
 * Throws if `id` isn't present: a patch that silently no-ops would look like
 * success but lose the caller's change, the same contract as `closeLoop`.
 */
export function applyTaskPatch(
  entries: TaskEntry[],
  id: string,
  patch: TaskPatch,
  now: number = Date.now()
): TaskEntry[] {
  let found = false;
  const next = entries.map((e) => {
    if (e.id !== id) return e;
    found = true;
    return { ...e, ...patch, updated: new Date(now).toISOString() };
  });
  if (!found) throw new Error(`Task not found: ${id}`);
  return next;
}

/**
 * Move a task to a new `status`/`order` (board drag-and-drop, column change),
 * bumping `updated`. Throws if `id` isn't present (same no-silent-no-op contract).
 */
export function applyTaskMove(
  entries: TaskEntry[],
  id: string,
  status: TaskStatus,
  order: number,
  now: number = Date.now()
): TaskEntry[] {
  return applyTaskPatch(entries, id, { status, order }, now);
}

/**
 * Archive a task: sets `status` to `archived`, bumps `updated`. The block
 * itself — title, prompt, history — is NEVER removed from the list; there is
 * no deletion code path for tasks, mirroring the Open-Loops Ledger and Memory
 * Union Store's append-only spirit. Throws if `id` isn't present.
 */
export function applyTaskArchive(entries: TaskEntry[], id: string, now: number = Date.now()): TaskEntry[] {
  return applyTaskPatch(entries, id, { status: "archived" }, now);
}

/**
 * Pure visibility gate for the "Promote to task" command (`src/main.ts`,
 * registered via `checkCallback`): visible only when `orchestrationEnabled`
 * is on, mirroring how `add_task` is only added to the tool list under the
 * same flag. Kept as a standalone predicate (rather than inline in
 * `checkCallback`) so the gating decision is unit-testable without
 * instantiating the Obsidian `Plugin`.
 */
export function promoteToTaskCommandVisible(settings: { orchestrationEnabled: boolean }): boolean {
  return settings.orchestrationEnabled;
}

/**
 * Assemble the final task prompt from the modal's fields: the prompt body plus
 * an optional "Context notes" section of `[[wikilinks]]` (one per attached
 * note). Names are deduped, blanks skipped, and already-wrapped `[[...]]`
 * names are kept as-is rather than double-wrapped. Context notes stay INSIDE
 * the prompt on purpose — the ledger's data model is unchanged, and the agent
 * reads wikilinks natively.
 */
export function buildTaskPrompt(prompt: string, contextNotes: string[]): string {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const raw of contextNotes) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    links.push(/^\[\[.*\]\]$/.test(name) ? name : `[[${name}]]`);
  }
  if (!links.length) return prompt;
  const section = `Context notes:\n${links.map((l) => `- ${l}`).join("\n")}`;
  return prompt.trim() ? `${prompt}\n\n${section}` : section;
}
