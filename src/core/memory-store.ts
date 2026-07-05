/**
 * Memory Union Store — pure logic (no Obsidian imports).
 *
 * Research-backed design: memories are stored VERBATIM (never model-summarized —
 * verbatim beats extracted retrieval by a wide margin) and the store is
 * APPEND-ONLY / union (never replace; a contradiction becomes a NEW entry that
 * points at the memory it supersedes). Superseded entries stay in the file
 * forever but drop out of recall results.
 *
 * On-disk shape — monthly markdown files, one block per entry:
 *
 *   ## mem-<epochMs> <kind>
 *   - at: <ISO-8601>
 *   - session: <session id or "unknown">
 *   - tags: tag1, tag2          (line omitted when no tags)
 *   - supersedes: mem-<id>      (line omitted when not superseding)
 *
 *   <verbatim text — may be multi-line markdown>
 *
 * `parseStoreFile` tolerates arbitrary junk between blocks (a human may hand-edit
 * the file). `formatEntry` ∘ `parseStoreFile` round-trips for entries whose text
 * carries no leading/trailing blank lines (internal newlines are preserved).
 */

export type MemoryKind = "preference" | "fact" | "decision" | "lesson";

/**
 * Provenance of a stored memory:
 *  - `user`      — Mario's verbatim words / explicit statements (the `remember` tool).
 *  - `generated` — written autonomously by a background pass (observer / dream).
 * On disk the sentinel is `@user` / `@generated`; the line is emitted ONLY for
 * `generated`, so legacy `@user` files round-trip byte-identical (missing → user).
 */
export type MemorySource = "user" | "generated";

const KINDS: readonly MemoryKind[] = ["preference", "fact", "decision", "lesson"];

export interface MemoryEntry {
  /** Stable id, shaped `mem-<epochMs>`. */
  id: string;
  kind: MemoryKind;
  /** Creation time, epoch milliseconds. */
  at: number;
  /** Originating session id, or "unknown". */
  session: string;
  tags: string[];
  /** Provenance sentinel. A missing on-disk line parses as `user`. */
  source: MemorySource;
  /** Id of the entry this one supersedes (omitted when not superseding). */
  supersedes?: string;
  /** The memory itself, stored verbatim. */
  text: string;
}

export interface ScoredEntry {
  entry: MemoryEntry;
  score: number;
}

/** Block header, e.g. `## mem-1720000000000 preference`. No `g` flag: safe for `.test`. */
const HEADER = /^##\s+(mem-\d+)\s+(preference|fact|decision|lesson)\s*$/;
/** A metadata line inside a block, e.g. `- at: 2024-07-03T12:00:00.000Z`. */
const META = /^-\s+(at|session|tags|source|supersedes):\s*(.*)$/;

/** Render one entry to its canonical on-disk block (no trailing newline). */
export function formatEntry(e: MemoryEntry): string {
  const lines = [
    `## ${e.id} ${e.kind}`,
    `- at: ${new Date(e.at).toISOString()}`,
    `- session: ${e.session}`,
  ];
  // Emit the sentinel ONLY for generated entries — user files stay byte-identical to the legacy format.
  if (e.source === "generated") lines.push(`- source: @generated`);
  if (e.tags.length) lines.push(`- tags: ${e.tags.join(", ")}`);
  if (e.supersedes) lines.push(`- supersedes: ${e.supersedes}`);
  lines.push("", e.text);
  return lines.join("\n");
}

/** Parse a whole store file into entries. Junk between blocks is ignored. */
export function parseStoreFile(content: string): MemoryEntry[] {
  const lines = content.split(/\r?\n/);
  const entries: MemoryEntry[] = [];
  let i = 0;
  while (i < lines.length) {
    const head = HEADER.exec(lines[i]);
    if (!head) {
      i++;
      continue;
    }
    const id = head[1];
    const kind = head[2] as MemoryKind;
    i++;

    let at = NaN;
    let session = "unknown";
    let tags: string[] = [];
    let source: MemorySource = "user";
    let supersedes: string | undefined;
    for (let m: RegExpExecArray | null; i < lines.length && (m = META.exec(lines[i])); i++) {
      const key = m[1];
      const val = m[2].trim();
      if (key === "at") at = Date.parse(val);
      else if (key === "session") session = val || "unknown";
      else if (key === "tags") tags = val.split(",").map((t) => t.trim()).filter(Boolean);
      // Only `@generated`/`generated` is generated; anything else (incl. junk) stays `user`.
      else if (key === "source") source = val.replace(/^@/, "") === "generated" ? "generated" : "user";
      else if (key === "supersedes" && val) supersedes = val;
    }

    // Optional single blank line separating metadata from the verbatim text.
    if (i < lines.length && lines[i].trim() === "") i++;

    const textLines: string[] = [];
    while (i < lines.length && !HEADER.test(lines[i])) textLines.push(lines[i++]);
    const text = textLines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");

    // Fall back to the epoch embedded in the id when the `at:` line is missing/garbage.
    if (!Number.isFinite(at)) {
      const idm = /^mem-(\d+)$/.exec(id);
      at = idm ? Number(idm[1]) : 0;
    }

    entries.push({ id, kind, at, session, tags, source, ...(supersedes ? { supersedes } : {}), text });
  }
  return entries;
}

/**
 * Remove exactly the blocks whose header id is in `ids`, returning the remaining
 * file content. This is the observer-undo primitive: it re-reads the CURRENT file
 * and strips only its own appended entries — so any entry written by another
 * writer (e.g. a `remember` @user entry) that landed after the observer's append
 * survives intact. Never a blind before-image restore, never a whole-file delete.
 *
 * Junk and non-removed blocks are preserved line-for-line; trailing whitespace is
 * normalized to a single newline (empty string when nothing remains). Idempotent
 * for ids not present.
 */
export function removeEntriesById(content: string, ids: readonly string[]): string {
  const remove = new Set(ids);
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const head = HEADER.exec(lines[i]);
    if (!head) {
      out.push(lines[i]);
      i++;
      continue;
    }
    // A block spans its header up to (but not including) the next header / EOF.
    const start = i;
    i++;
    while (i < lines.length && !HEADER.test(lines[i])) i++;
    if (!remove.has(head[1])) {
      for (let j = start; j < i; j++) out.push(lines[j]);
    }
  }
  const text = out.join("\n").replace(/\s+$/, "");
  return text ? `${text}\n` : "";
}

/** Monthly file name for a timestamp, e.g. `2024-07.md` (UTC — TZ-independent). */
export function monthFileName(at: number): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}.md`;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function docTokens(e: MemoryEntry): string[] {
  return tokenize(`${e.text} ${e.tags.join(" ")} ${e.kind}`);
}

/**
 * BM25-lite over lowercase word tokens (fields: text + tags + kind). idf is
 * derived from the entry corpus itself; k1=1.2, b=0.75 with per-entry length
 * normalization. Deterministic order: score desc, then newest first.
 */
export function scoreEntries(query: string, entries: MemoryEntry[]): ScoredEntry[] {
  const qTerms = [...new Set(tokenize(query))];
  const docs = entries.map(docTokens);
  const N = docs.length || 1;
  const avgdl = docs.reduce((sum, d) => sum + d.length, 0) / N || 1;
  const k1 = 1.2;
  const b = 0.75;

  const df = new Map<string, number>();
  for (const term of qTerms) {
    let count = 0;
    for (const d of docs) if (d.includes(term)) count++;
    df.set(term, count);
  }

  const scored = entries.map((entry, idx) => {
    const d = docs[idx];
    const dl = d.length || 1;
    let score = 0;
    for (const term of qTerms) {
      const dfi = df.get(term) ?? 0;
      if (dfi === 0) continue;
      let tf = 0;
      for (const t of d) if (t === term) tf++;
      if (tf === 0) continue;
      const idf = Math.log(1 + (N - dfi + 0.5) / (dfi + 0.5));
      score += (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * dl) / avgdl));
    }
    return { entry, score };
  });

  scored.sort((a, b2) => b2.score - a.score || b2.entry.at - a.entry.at);
  return scored;
}

/**
 * Drop entries that another entry supersedes (they stay in the store, but never
 * surface in recall). Supersedence chains are handled; unknown ids are ignored.
 */
export function resolveSupersedence(entries: MemoryEntry[]): MemoryEntry[] {
  const superseded = new Set<string>();
  for (const e of entries) if (e.supersedes) superseded.add(e.supersedes);
  return entries.filter((e) => !superseded.has(e.id));
}

/**
 * Truth firewall for supersedence. A `generated` entry may NEVER supersede a
 * `user` entry — only the user's own words may overwrite the record of what the
 * user said. Allowed: user→anything, generated→generated, generated→(unknown or
 * no target). Returns `{ ok: false, reason }` only when a `generated` candidate
 * names a `supersedes` target that resolves (by id in `existing`) to a `user` entry.
 */
export function guardSupersede(
  candidate: MemoryEntry,
  existing: readonly MemoryEntry[]
): { ok: true } | { ok: false; reason: string } {
  if (candidate.source !== "generated" || !candidate.supersedes) return { ok: true };
  const target = existing.find((e) => e.id === candidate.supersedes);
  if (target && target.source === "user") {
    return {
      ok: false,
      reason: `Truth firewall: a @generated entry may not supersede @user entry ${target.id}.`,
    };
  }
  return { ok: true };
}

/** True for a string that is one of the known memory kinds. */
export function isMemoryKind(s: string): s is MemoryKind {
  return (KINDS as readonly string[]).includes(s);
}
