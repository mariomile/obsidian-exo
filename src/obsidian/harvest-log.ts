import type { AppliedWrite } from "../core/memory-apply";
import { WriteQueue } from "../core/write-queue";

/** One memory harvest that wrote something: the digest's row and undo's handle. */
export interface HarvestRecord {
  id: string;
  at: number;
  convoId: string;
  /** Already passed through `safeTitle`: never carries a credential. */
  title: string;
  /** The harvest commit (clean notes only), when the vault is a git repo. */
  sha?: string;
  /** Notes written but NOT committed because they held the user's
   *  uncommitted edits: undo reverses their lines instead of `git revert`. */
  uncommitted?: string[];
  /** Exactly what was inserted or replaced. No note bodies: the plugin folder
   *  is git-tracked in some vaults, and a full snapshot would copy every
   *  touched note into its history. The exact lines are enough to undo, and
   *  have no size limit. */
  writes: AppliedWrite[];
  undoneAt?: number;
}

/** Records kept: the digest shows recent harvests, older ones live in git. */
const MAX_RECORDS = 30;

export interface LogFile {
  read(): Promise<string | null>;
  write(content: string): Promise<void>;
  /** Keep an unreadable log aside instead of overwriting it. */
  preserveCorrupt(content: string): Promise<void>;
}

/**
 * Recent harvests, in the plugin folder (`memory-harvests.json`): Exo's
 * bookkeeping, not memory, so it never lands in the vault's notes. Serialized
 * through one queue so concurrent harvests can't lose a record. A log that no
 * longer parses is moved aside before the next append, never silently wiped.
 */
export class HarvestLog {
  private readonly queue = new WriteQueue();

  constructor(private readonly file: LogFile) {}

  async list(): Promise<HarvestRecord[]> {
    try {
      const raw = await this.file.read();
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? (parsed as HarvestRecord[]) : [];
    } catch {
      return [];
    }
  }

  /** Records for a read-modify-write: a corrupt file is preserved first. */
  private async load(): Promise<HarvestRecord[]> {
    const raw = await this.file.read();
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as HarvestRecord[];
    } catch {
      /* fall through */
    }
    await this.file.preserveCorrupt(raw);
    return [];
  }

  append(rec: HarvestRecord): Promise<void> {
    return this.queue.enqueue(async () => {
      const all = await this.load();
      await this.file.write(JSON.stringify([rec, ...all].slice(0, MAX_RECORDS)));
    });
  }

  markUndone(id: string, at: number): Promise<void> {
    return this.queue.enqueue(async () => {
      const all = await this.load();
      await this.file.write(JSON.stringify(all.map((r) => (r.id === id ? { ...r, undoneAt: at } : r))));
    });
  }
}
