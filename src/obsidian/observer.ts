import { App, TFile } from "obsidian";
import { WriteQueue } from "../core/write-queue";
import {
  formatEntry,
  monthFileName,
  parseStoreFile,
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

/** Runs a transient, tool-less CLI prompt and resolves the raw text (never throws). */
export type RunObserverSession = (prompt: string, signal: AbortSignal) => Promise<string>;

/**
 * Self-Writing Memory — Obsidian-side observer.
 *
 * After a HEALTHY chat turn, `observe()` fans a capped digest off the critical
 * path to a cheap background model, parses the candidates, drops near-duplicates
 * of what recall already knows, and appends the survivors to the Union Store as
 * `source='generated'` entries — through the w1-1 {@link WriteQueue}, and NEVER
 * with a `supersedes` field (truth firewall: a generated entry may never
 * supersede a user entry).
 *
 * Concurrency: at most ONE run in flight. If a new turn ends while a run is
 * still going, it is skipped (not queued). `dispose()` aborts on view unload.
 */
export class MemoryObserver {
  /** The w1-1 serialized write path for every store append + undo this observer makes. */
  private readonly queue = new WriteQueue();
  private running = false;
  private controller: AbortController | null = null;

  constructor(
    private readonly app: App,
    private readonly runSession: RunObserverSession
  ) {}

  /**
   * Observe one completed turn. Returns the write (entries + undo snapshot) when
   * memories were appended, or `null` when nothing was written (skipped turn,
   * concurrent run, CLI/parse failure, empty or fully-duplicate candidates).
   * Failures are silent-safe — never throws.
   */
  async observe(digest: TurnDigest, sessionId: string): Promise<ObserverWrite | null> {
    if (shouldSkipTurn(digest)) return null;
    if (this.running) return null; // at most one run in flight — skip, don't queue

    this.running = true;
    const ctrl = new AbortController();
    this.controller = ctrl;
    try {
      const raw = await this.runSession(buildObserverPrompt(digest), ctrl.signal);
      if (ctrl.signal.aborted || !raw) return null;

      const candidates = parseObserverOutput(raw);
      if (candidates.length === 0) return null;

      const existing = await this.readActiveEntryTexts();
      const novel = dedupeCandidates(candidates, existing);
      if (novel.length === 0) return null;

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
      return { entries, snapshot };
    } catch {
      return null; // CLI missing / parse / write error — no user-facing surface
    } finally {
      this.running = false;
      this.controller = null;
    }
  }

  /**
   * Undo exactly the entries a prior {@link observe} appended, by restoring the
   * captured before-image (or deleting the file the append created). Routed
   * through the same write-queue so it can't interleave with a store append.
   */
  async undo(snapshot: ObserverSnapshot): Promise<void> {
    await this.queue.enqueue(async () => {
      const f = this.app.vault.getAbstractFileByPath(snapshot.path);
      if (snapshot.before === null) {
        if (f instanceof TFile) await this.app.vault.delete(f);
      } else if (f instanceof TFile) {
        await this.app.vault.modify(f, snapshot.before);
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
