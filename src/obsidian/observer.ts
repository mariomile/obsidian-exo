import { App, TFile } from "obsidian";
import type { WriteQueue } from "../core/write-queue";
import {
  formatEntry,
  monthFileName,
  parseStoreFile,
  removeEntriesById,
  resolveSupersedence,
  type MemoryEntry,
} from "../core/memory-store";
import {
  buildObserverPrompt,
  parseObserverOutput,
  shouldSkipTurn,
  dedupeCandidates,
  type TurnDigest,
} from "../core/observer";

/** Folder holding the append-only Memory Union Store (monthly markdown files). */
const MEMORY_STORE_DIR = "_system/memory/store";
/** Cap on how many existing active entries we compare against for dedupe. */
const MAX_DEDUPE_ENTRIES = 400;

/**
 * Snapshot of the monthly store file taken immediately before the observer
 * appended its blocks — the before-image is the exact-tail undo target
 * (following the dream-pass `DreamSnapshot` pattern). `before === null` means
 * the append CREATED the file, so undo deletes it.
 */
export interface ObserverSnapshot {
  path: string;
  before: string | null;
}

/** Result of a successful observer write. */
export interface ObserverWrite {
  entries: MemoryEntry[];
  snapshot: ObserverSnapshot;
}

export interface ObserverAttempt {
  /** True only when this call reached the observer runner. */
  attempted: boolean;
  /** Another observer pass was already active; callers may retry after whenIdle(). */
  busy: boolean;
  write: ObserverWrite | null;
}

/** Runs a transient, tool-less CLI prompt and resolves the raw text (never throws). */
export type RunObserverSession = (prompt: string, signal: AbortSignal) => Promise<string>;

/**
 * Self-Writing Memory — Obsidian-side observer.
 *
 * After a HEALTHY chat turn, `observe()` fans a capped digest off the critical
 * path to a cheap background model, parses the candidates, drops near-duplicates
 * of what recall already knows, and appends the survivors to the Union Store as
 * `source='generated'` entries — through the SHARED w1-1 {@link WriteQueue}
 * injected by the plugin (the same instance the `remember` tool uses, so store
 * writers never interleave a read-modify-write), and NEVER with a `supersedes`
 * field (truth firewall: a generated entry may never supersede a user entry).
 *
 * Concurrency: at most ONE run in flight. Detailed callers can distinguish a
 * busy skip and retry after `whenIdle()`. `dispose()` aborts on view unload.
 */
export class MemoryObserver {
  private running = false;
  private controller: AbortController | null = null;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly app: App,
    private readonly runSession: RunObserverSession,
    /** THE shared store write-queue (plugin-scoped). Every append + undo this
     *  observer makes enqueues here so it serializes against the `remember`
     *  tool and future dream passes — one FIFO, no cross-writer clobber (w1-1). */
    private readonly queue: WriteQueue
  ) {}

  /**
   * Observe one completed turn. Returns the write (entries + undo snapshot) when
   * memories were appended, or `null` when nothing was written (skipped turn,
   * concurrent run, CLI/parse failure, empty or fully-duplicate candidates).
   * Failures are silent-safe — never throws.
   */
  async observe(digest: TurnDigest, sessionId: string): Promise<ObserverWrite | null> {
    return (await this.observeDetailed(digest, sessionId)).write;
  }

  /** Detailed variant used by cadence wiring so a busy skip is never mistaken
   *  for content that was actually shown to the observer model. */
  async observeDetailed(digest: TurnDigest, sessionId: string): Promise<ObserverAttempt> {
    if (shouldSkipTurn(digest)) return { attempted: false, busy: false, write: null };
    if (this.running) return { attempted: false, busy: true, write: null };

    this.running = true;
    const ctrl = new AbortController();
    this.controller = ctrl;
    try {
      const raw = await this.runSession(buildObserverPrompt(digest), ctrl.signal);
      if (ctrl.signal.aborted || !raw) return { attempted: true, busy: false, write: null };

      const candidates = parseObserverOutput(raw);
      if (candidates.length === 0) return { attempted: true, busy: false, write: null };

      const existing = await this.readActiveEntryTexts();
      const novel = dedupeCandidates(candidates, existing);
      if (novel.length === 0) return { attempted: true, busy: false, write: null };

      const at0 = Date.now();
      const session = sessionId || "unknown";
      const entries: MemoryEntry[] = novel.map((c, i) => ({
        id: `mem-${at0 + i}`,
        kind: c.kind,
        at: at0 + i,
        session,
        tags: c.tags,
        // Truth firewall: observer entries are ALWAYS @generated and NEVER supersede.
        source: "generated",
        text: c.text,
      }));

      const snapshot = await this.append(entries, at0);
      return { attempted: true, busy: false, write: { entries, snapshot } };
    } catch {
      return { attempted: true, busy: false, write: null }; // CLI missing / parse / write error
    } finally {
      this.running = false;
      this.controller = null;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  /** Resolve when the currently-running observer pass settles. */
  whenIdle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /**
   * Undo EXACTLY the entries a prior {@link observe} appended. Re-reads the
   * CURRENT file and strips only this pass's own entry ids ({@link removeEntriesById}) —
   * it never blind-restores a before-image and never deletes a file that still
   * holds other entries. This is what protects a `remember` @user entry (or any
   * other writer's entry) that landed between the observer's append and the undo
   * click: only the observer's own blocks are removed, everything else survives.
   *
   * The whole file is deleted only when it was CREATED by this observer pass
   * (`before === null`) AND nothing else remains after the strip. Routed through
   * the shared write-queue so it can't interleave with a concurrent append.
   */
  async undo(write: ObserverWrite): Promise<void> {
    const ids = write.entries.map((e) => e.id);
    await this.queue.enqueue(async () => {
      const f = this.app.vault.getAbstractFileByPath(write.snapshot.path);
      if (!(f instanceof TFile)) return;
      const current = await this.app.vault.read(f);
      const stripped = removeEntriesById(current, ids);
      if (stripped.trim() === "" && write.snapshot.before === null) {
        // The observer created this file and no other writer added anything —
        // safe to remove it entirely (leaving no empty store file behind).
        await this.app.vault.delete(f);
      } else {
        await this.app.vault.modify(f, stripped);
      }
    });
  }

  /** Abort any in-flight run (view unload). */
  dispose(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /** Append entries to the monthly store file through the write-queue; capture a before-image. */
  private async append(entries: MemoryEntry[], at0: number): Promise<ObserverSnapshot> {
    const path = `${MEMORY_STORE_DIR}/${monthFileName(at0)}`;
    const block = entries.map(formatEntry).join("\n\n");
    let before: string | null = null;
    await this.queue.enqueue(async () => {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        before = await this.app.vault.read(existing);
        await this.app.vault.modify(existing, `${before.replace(/\s+$/, "")}\n\n${block}\n`);
      } else {
        before = null;
        await this.ensureParentFolder(path);
        await this.app.vault.create(path, `${block}\n`);
      }
    });
    return { path, before };
  }

  /** Read the active (non-superseded) store entries' texts for dedupe (off critical path). */
  private async readActiveEntryTexts(): Promise<string[]> {
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(`${MEMORY_STORE_DIR}/`));
    const all: MemoryEntry[] = [];
    for (const f of files) {
      try {
        all.push(...parseStoreFile(await this.app.vault.cachedRead(f)));
      } catch {
        /* skip unreadable file */
      }
    }
    return resolveSupersedence(all)
      .slice(-MAX_DEDUPE_ENTRIES)
      .map((e) => e.text);
  }

  /** Create any missing parent folders for a vault path. */
  private async ensureParentFolder(path: string): Promise<void> {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) return;
    const dir = path.slice(0, slash);
    if (this.app.vault.getAbstractFileByPath(dir)) return;
    try {
      await this.app.vault.createFolder(dir);
    } catch {
      /* already exists (race) — fine */
    }
  }
}
