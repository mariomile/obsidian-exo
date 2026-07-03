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
const META = /^-\s+(at|session|tags|supersedes):\s*(.*)$/;

/** Render one entry to its canonical on-disk block (no trailing newline). */
export function formatEntry(e: MemoryEntry): string {
  const lines = [
    `## ${e.id} ${e.kind}`,
    `- at: ${new Date(e.at).toISOString()}`,
    `- session: ${e.session}`,
  ];
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
    let supersedes: string | undefined;
    for (let m: RegExpExecArray | null; i < lines.length && (m = META.exec(lines[i])); i++) {
      const key = m[1];
      const val = m[2].trim();
      if (key === "at") at = Date.parse(val);
      else if (key === "session") session = val || "unknown";
      else if (key === "tags") tags = val.split(",").map((t) => t.trim()).filter(Boolean);
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

    entries.push({ id, kind, at, session, tags, ...(supersedes ? { supersedes } : {}), text });
  }
  return entries;
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

/** True for a string that is one of the known memory kinds. */
export function isMemoryKind(s: string): s is MemoryKind {
  return (KINDS as readonly string[]).includes(s);
}
