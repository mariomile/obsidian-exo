/**
 * Time-Travel Recall — point-in-time belief resolution over the Memory Union
 * Store (pure logic, no Obsidian imports).
 *
 * Zep/Graphiti-style bi-temporal semantics on the EXISTING append-only format —
 * no format change, no vector DB. Given the full entry set and a calendar date D
 * ("what did I believe on D?"), it answers with the entries that were *current as
 * of D*:
 *
 *   (a) only entries created on/before D are considered (later ones don't exist yet);
 *   (b) an entry is current as of D unless some OTHER entry — also created on/before
 *       D — supersedes it. An entry superseded only AFTER D is still current at D.
 *
 * Chains fall out naturally: for A←B←C (B supersedes A, C supersedes B), querying
 * between B and C yields B (A is superseded on/before D, C doesn't exist yet). The
 * resolution is set-based, not a recursive walk, so supersedes CYCLES and
 * self-references terminate by construction (each link's superseders are checked
 * independently; no traversal to loop on).
 *
 * Date basis: an entry's creation day is its UTC calendar date, matching how the
 * `recall` tool renders dates (`toISOString().slice(0,10)`). Comparison is
 * lexicographic on `YYYY-MM-DD`, which equals chronological order and is
 * timezone-independent.
 *
 * Conservative missing-date handling: `parseStoreFile` already normalizes a
 * missing/garbage `at:` to the epoch embedded in the id, or 0 when even that is
 * absent. An `at` of 0 maps to 1970-01-01, i.e. on/before every real D, so a
 * date-less entry surfaces in every as-of query — we'd rather show a possibly-early
 * belief than silently hide a memory.
 */

import type { MemoryEntry } from "./memory-store";

/** The UTC calendar date (`YYYY-MM-DD`) an entry was created on. `at` is finite by
 *  construction (parseStoreFile), but guard NaN → epoch 0 defensively. */
function entryDate(e: MemoryEntry): string {
  return new Date(Number.isFinite(e.at) ? e.at : 0).toISOString().slice(0, 10);
}

/** Strict `YYYY-MM-DD` validation: right shape AND a real calendar day (rejects
 *  2024-13-01, 2024-02-30, non-leap 2023-02-29, …). */
export function isValidAsOfDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

/** Where an entry was later superseded: the superseding entry's id and its date. */
export interface SupersededAfter {
  by: string;
  on: string;
}

export interface AsOfResolution {
  /** Entries current as of D, in input order (created on/before D, not superseded
   *  by any other on/before-D entry). */
  current: MemoryEntry[];
  /** For each current entry that WAS later superseded (by an entry created after D),
   *  the earliest such superseder — so recall can flag that the belief evolved.
   *  Keyed by the superseded entry's id. */
  supersededAfter: Map<string, SupersededAfter>;
}

/**
 * Resolve the belief state current as of `date` (`YYYY-MM-DD`). See the module
 * header for full semantics. Set-based and non-recursive: safe against supersedes
 * cycles and self-references.
 */
export function currentAsOf(entries: MemoryEntry[], date: string): AsOfResolution {
  const onBefore = (e: MemoryEntry): boolean => entryDate(e) <= date;

  // targetId → entries that name it in `supersedes`.
  const supersedersOf = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    if (!e.supersedes) continue;
    const list = supersedersOf.get(e.supersedes);
    if (list) list.push(e);
    else supersedersOf.set(e.supersedes, [e]);
  }

  const current: MemoryEntry[] = [];
  const supersededAfter = new Map<string, SupersededAfter>();

  for (const e of entries) {
    if (!onBefore(e)) continue; // created after D → doesn't exist yet
    // Ignore a self-supersede — an entry can't supersede itself out of existence.
    const supers = (supersedersOf.get(e.id) ?? []).filter((s) => s.id !== e.id);
    if (supers.some(onBefore)) continue; // superseded on/before D → not current
    current.push(e);
    // Superseded LATER? Record the earliest after-D superseder.
    const afterSupers = supers.filter((s) => !onBefore(s)).sort((a, b) => a.at - b.at);
    if (afterSupers.length) {
      supersededAfter.set(e.id, { by: afterSupers[0].id, on: entryDate(afterSupers[0]) });
    }
  }

  return { current, supersededAfter };
}
