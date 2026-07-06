/**
 * claude-mem reader — pure parsing + watermark logic (no Obsidian imports).
 *
 * Read the user's claude-mem observations so the dream LLM stage can propose
 * importing durable ones into the Union Store. The impure shell (see
 * `src/obsidian/claudemem.ts`) shells out to the system `sqlite3` binary with
 * `-json` output, READ-ONLY; this module only parses that JSON and maintains the
 * import watermark (last imported row `id`). Nothing here ever writes the DB.
 *
 * Storage format (inspected 2026-07-05): SQLite at `~/.claude-mem/claude-mem.db`,
 * table `observations` — columns id, memory_session_id, project, text, type,
 * title, subtitle, facts, narrative, concepts, files_read, files_modified,
 * prompt_number, discovery_tokens, created_at, created_at_epoch.
 */

export interface ClaudeMemObservation {
  id: number;
  project: string;
  type: string;
  title: string;
  subtitle: string;
  facts: string;
  narrative: string;
  createdAtEpoch: number;
}

/** Import watermark, persisted at `_system/memory/claudemem-sync-state.json`. */
export interface SyncState {
  /** Highest observation `id` already imported into the store. */
  lastImportedId: number;
  /** ISO timestamp of the last sync run. */
  lastRunISO: string;
}

export function initialSyncState(): SyncState {
  return { lastImportedId: 0, lastRunISO: "" };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse `sqlite3 -json` output into observations. Tolerant: bad JSON, a non-array
 * top level, or rows without a numeric `id` are dropped (the row's `id` is the
 * only hard requirement — it's the watermark key). Never throws; returns [] on
 * any failure so the caller can no-op silently.
 */
export function parseObservations(json: string): ClaudeMemObservation[] {
  if (!json || typeof json !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ClaudeMemObservation[] = [];
  for (const row of parsed) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "number" || !Number.isFinite(r.id)) continue;
    out.push({
      id: r.id,
      project: str(r.project),
      type: str(r.type),
      title: str(r.title),
      subtitle: str(r.subtitle),
      facts: str(r.facts),
      narrative: str(r.narrative),
      createdAtEpoch: num(r.created_at_epoch),
    });
  }
  return out;
}

/** Parse the watermark file; any missing/garbage content resets to a zero watermark. */
export function parseSyncState(content: string | null | undefined): SyncState {
  if (!content) return initialSyncState();
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed?.lastImportedId !== "number" || !Number.isFinite(parsed.lastImportedId)) {
      return initialSyncState();
    }
    return {
      lastImportedId: parsed.lastImportedId,
      lastRunISO: typeof parsed.lastRunISO === "string" ? parsed.lastRunISO : "",
    };
  } catch {
    return initialSyncState();
  }
}

/**
 * Advance the watermark to the max of the currently-imported ids (never
 * backwards), always restamping `lastRunISO`. Called ONLY on apply — proposing/
 * previewing an import must not move the watermark.
 */
export function advanceWatermark(state: SyncState, importedIds: readonly number[], runISO: string): SyncState {
  const maxImported = importedIds.reduce((m, id) => (Number.isFinite(id) && id > m ? id : m), state.lastImportedId);
  return { lastImportedId: maxImported, lastRunISO: runISO };
}
