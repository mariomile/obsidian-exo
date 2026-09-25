import type { AppliedWrite, FileSnapshot } from "../core/memory-apply";
import { WriteQueue } from "../core/write-queue";

/** One memory harvest that wrote something: the digest's row and undo's handle. */
export interface HarvestRecord {
  id: string;
  at: number;
  convoId: string;
  title: string;
  /** The harvest commit, when the vault is a git repo. */
  sha?: string;
  writes: AppliedWrite[];
  /** Pre/post snapshots, for undo without git. Empty when a file was too big to keep. */
  files: FileSnapshot[];
  undoneAt?: number;
}

/** Records kept: the digest shows recent harvests, older ones live in git. */
const MAX_RECORDS = 30;
/** Per-file snapshot cap, same bloat guard as automation run records. */
const MAX_SNAPSHOT = 64_000;

export interface LogFile {
  read(): Promise<string | null>;
  write(content: string): Promise<void>;
}

/**
 * Recent harvests, in the plugin folder (`memory-harvests.json`): Exo's
 * bookkeeping, not memory, so it never lands in the vault's notes. Serialized
 * through one queue so concurrent harvests can't lose a record.
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

  append(rec: HarvestRecord): Promise<void> {
    const big = rec.files.some((f) => (f.before?.length ?? 0) > MAX_SNAPSHOT || f.after.length > MAX_SNAPSHOT);
    const stored = big ? { ...rec, files: [] } : rec;
    return this.queue.enqueue(async () => {
      const all = await this.list();
      await this.file.write(JSON.stringify([stored, ...all].slice(0, MAX_RECORDS)));
    });
  }

  markUndone(id: string, at: number): Promise<void> {
    return this.queue.enqueue(async () => {
      const all = await this.list();
      await this.file.write(JSON.stringify(all.map((r) => (r.id === id ? { ...r, undoneAt: at } : r))));
    });
  }
}
