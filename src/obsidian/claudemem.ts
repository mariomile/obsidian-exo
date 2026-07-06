import { App } from "obsidian";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as os from "node:os";
import * as path from "node:path";
import type { WriteQueue } from "../core/write-queue";
import {
  parseObservations,
  parseSyncState,
  advanceWatermark,
  initialSyncState,
  type ClaudeMemObservation,
  type SyncState,
} from "../core/claudemem-reader";

const execFileAsync = promisify(execFile);

/** Watermark file (last imported observation id), inside the AI memory layer. */
const SYNC_STATE_PATH = "_system/memory/claudemem-sync-state.json";
/** Verified location of the claude-mem SQLite DB (inspected 2026-07-05). */
const DB_PATH = path.join(os.homedir(), ".claude-mem", "claude-mem.db");

/** Log the first read failure per plugin session only — the dream pass may call
 *  this repeatedly (every run), and a persistently-missing db/binary must not
 *  spam the console on every attempt. */
let hasWarnedOnce = false;

/** Read + parse the import watermark (zero watermark on missing/garbage). */
export async function readSyncState(app: App): Promise<SyncState> {
  try {
    const adapter = app.vault.adapter;
    if (!(await adapter.exists(SYNC_STATE_PATH))) return initialSyncState();
    return parseSyncState(await adapter.read(SYNC_STATE_PATH));
  } catch {
    return initialSyncState();
  }
}

/** Persist the watermark through the shared write-queue (serializes with store writes). */
export async function writeSyncState(app: App, queue: WriteQueue, state: SyncState): Promise<void> {
  await queue.enqueue(async () => {
    try {
      await app.vault.adapter.write(SYNC_STATE_PATH, JSON.stringify(state, null, 2));
    } catch {
      /* non-fatal — the watermark just won't advance this run */
    }
  });
}

/** Advance the watermark to the max of `importedIds` and persist (ONLY call on apply). */
export async function advanceAndPersistWatermark(
  app: App,
  queue: WriteQueue,
  importedIds: readonly number[],
  runISO: string
): Promise<void> {
  const current = await readSyncState(app);
  await writeSyncState(app, queue, advanceWatermark(current, importedIds, runISO));
}

/** SQL-escape a single-quoted string literal (double the quotes). */
function sqlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export interface ReadObservationsOpts {
  /** Project filter — claude-mem's `project` column value(s), e.g. "my-vault"
   *  (verified 2026-07-05: it's the vault/repo directory basename, not a path-slug). */
  projects: string[];
  /** Max rows to read (N=100 for the dream stage). */
  limit: number;
}

/**
 * Read UNIMPORTED claude-mem observations (id > watermark) for the configured
 * projects, ordered oldest-first, capped at `limit`. READ-ONLY: shells out to the
 * system `sqlite3` binary with `-readonly -json`, explicit argv (no shell), and
 * NEVER issues INSERT/UPDATE/DELETE. All failure modes (db file missing, sqlite3
 * binary missing, query error) return `[]` and log once — a graceful no-op.
 *
 * The watermark and project list are sanitized into the query (id → integer,
 * projects → escaped literals); the values are user-configured, not model/external
 * input, and the query only ever reads.
 */
export async function readUnimportedObservations(
  app: App,
  opts: ReadObservationsOpts
): Promise<ClaudeMemObservation[]> {
  try {
    const { lastImportedId } = await readSyncState(app);
    const afterId = Math.max(0, Math.floor(Number.isFinite(lastImportedId) ? lastImportedId : 0));
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit) || 100));
    const projects = opts.projects.filter((p) => typeof p === "string" && p.length);
    if (projects.length === 0) return [];
    const projList = projects.map(sqlQuote).join(", ");
    const sql =
      "SELECT id, project, type, title, subtitle, facts, narrative, created_at_epoch " +
      `FROM observations WHERE id > ${afterId} AND project IN (${projList}) ORDER BY id LIMIT ${limit}`;
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", DB_PATH, sql], {
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseObservations(stdout);
  } catch (err) {
    if (!hasWarnedOnce) {
      hasWarnedOnce = true;
      console.warn("[Exo] claude-mem read skipped (db/sqlite3 unavailable or query error):", err);
    }
    return [];
  }
}
