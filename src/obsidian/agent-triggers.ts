/**
 * Agent trigger driver — the impure half of event-driven agent runs.
 *
 * Owns debouncing, the tag snapshot and dispatch; all matching lives in
 * `core/agent-triggers.ts`. Every dependency is injected (timers included) so
 * the coalescing behaviour is unit-testable without Obsidian or real time.
 *
 * Two hazards this exists to contain:
 *
 * 1. **Boot storms.** Obsidian replays `create` for every file in the vault
 *    while it builds its initial index. A driver armed at plugin load would
 *    therefore fire an inbox-triage agent once per existing note. The driver
 *    starts disarmed and must be armed explicitly, after layout-ready.
 * 2. **Write storms.** Sync, a git checkout, or a bulk frontmatter rewrite each
 *    produce hundreds of events per second. Events coalesce per path inside a
 *    debounce window, and `create` wins over a following `modify` because
 *    Obsidian emits both for one new file.
 */
import type { App, TFile } from "obsidian";
import {
  anyEventTriggers,
  isIgnoredTriggerPath,
  matchVaultEvent,
  needsBody,
  type VaultEventKind,
} from "../core/agent-triggers";
import type { DueAgentRun } from "../core/agent-runs";
import type { AgentDef } from "../core/agents";

export interface TriggerDriverDeps {
  /** Current registry contents. Read per flush so contract edits take effect. */
  agents: () => AgentDef[];
  /** Vault-relative memory root, excluded from triggering. */
  memoryRoot: () => string;
  /** Tags + body for a note, or null when unreadable. */
  readNote: (path: string) => Promise<{ tags: string[]; body: string } | null>;
  /** Hand a fired trigger to the executor (which applies the shared gates). */
  dispatch: (run: DueAgentRun) => void;
  debounceMs?: number;
  schedule: (fn: () => void, ms: number) => number;
  cancel: (id: number) => void;
}

/** Minimum quiet period before a path's events are considered settled. Five
 *  seconds is long by UI standards and deliberately so: this is the difference
 *  between one run and one run per keystroke. */
export const DEFAULT_TRIGGER_DEBOUNCE_MS = 5_000;

export class AgentTriggerDriver {
  private pending = new Map<string, { kind: VaultEventKind; timer: number }>();
  /** Last known tags per path — the "was this tag just added?" baseline. */
  private tagSnapshot = new Map<string, string[]>();
  private armed = false;
  private disposed = false;

  constructor(private deps: TriggerDriverDeps) {}

  /** Start reacting to events. Call AFTER the workspace is ready, never at
   *  plugin load — see the boot-storm note above. */
  arm(): void {
    this.armed = true;
  }

  isArmed(): boolean {
    return this.armed;
  }

  /**
   * Record a vault event. Cheap and synchronous: the expensive work (reading
   * the note, matching, dispatching) happens once the debounce settles.
   */
  notify(path: string, kind: VaultEventKind): void {
    if (!this.armed || this.disposed) return;
    if (isIgnoredTriggerPath(path, this.deps.memoryRoot())) return;
    if (!anyEventTriggers(this.deps.agents())) return;

    const existing = this.pending.get(path);
    if (existing) {
      this.deps.cancel(existing.timer);
      // Obsidian emits create→modify for one new file; the creation is the
      // event an agent cares about, so it survives coalescing.
      kind = existing.kind === "create" ? "create" : kind;
    }
    const timer = this.deps.schedule(() => void this.flush(path), this.deps.debounceMs ?? DEFAULT_TRIGGER_DEBOUNCE_MS);
    this.pending.set(path, { kind, timer });
  }

  /** Seed the tag baseline for a path without firing anything — used when the
   *  driver first sees a note, so a pre-existing tag never reads as "added". */
  seedTags(path: string, tags: string[]): void {
    this.tagSnapshot.set(path, tags);
  }

  private async flush(path: string): Promise<void> {
    const entry = this.pending.get(path);
    this.pending.delete(path);
    if (!entry || this.disposed) return;

    const agents = this.deps.agents();
    if (!anyEventTriggers(agents)) return;

    const note = await this.deps.readNote(path).catch(() => null);
    // A deleted or unreadable note simply drops out; its tag baseline goes too,
    // so a later re-creation with the same tag counts as an addition again.
    if (!note) {
      this.tagSnapshot.delete(path);
      return;
    }

    const previousTags = this.tagSnapshot.get(path);
    const runs = matchVaultEvent(agents, {
      path,
      kind: entry.kind,
      tags: note.tags,
      previousTags,
      body: needsBody(agents) ? note.body : undefined,
    });
    // Snapshot AFTER matching, so this flush sees the old baseline and the next
    // one sees the new state.
    this.tagSnapshot.set(path, note.tags);

    for (const run of runs) this.deps.dispatch(run);
  }

  dispose(): void {
    this.disposed = true;
    this.armed = false;
    for (const { timer } of this.pending.values()) this.deps.cancel(timer);
    this.pending.clear();
    this.tagSnapshot.clear();
  }
}

/** Read the tags and body a trigger match needs, from Obsidian's own cache
 *  (tags) and the vault (body). Returns null for anything that is not a
 *  readable markdown file. */
export function makeNoteReader(app: App): (path: string) => Promise<{ tags: string[]; body: string } | null> {
  return async (path) => {
    const file = app.vault.getAbstractFileByPath(path) as TFile | null;
    if (!file || !("extension" in file) || file.extension !== "md") return null;
    const cache = app.metadataCache.getFileCache(file);
    const tags = new Set<string>();
    for (const t of cache?.tags ?? []) tags.add(t.tag);
    const fmTags = cache?.frontmatter?.tags;
    for (const t of Array.isArray(fmTags) ? fmTags : fmTags ? [fmTags] : []) {
      if (typeof t === "string") tags.add(t.startsWith("#") ? t : `#${t}`);
    }
    try {
      return { tags: [...tags], body: await app.vault.cachedRead(file) };
    } catch {
      return null;
    }
  };
}
