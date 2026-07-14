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
 *  - `user`      — the user's verbatim words / explicit statements (the `remember` tool).
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
  /**
   * Id(s) of the entry/entries this one supersedes (omitted when not
   * superseding). Usually a single `mem-<id>`; a dream-pass merge may set a
   * comma-separated LIST (`mem-1, mem-2`) so one consolidated entry retires a
   * whole group at once. Use {@link supersededIds} to enumerate.
   */
  supersedes?: string;
  /** External provenance line, e.g. `claude-mem:123` for an imported observation. */
  origin?: string;
  /** The memory itself, stored verbatim. */
  text: string;
}

/** Split a `supersedes` value (single id or `mem-1, mem-2` list) into ids. */
export function supersededIds(supersedes: string | undefined): string[] {
  if (!supersedes) return [];
  return supersedes.split(",").map((s) => s.trim()).filter(Boolean);
}

export interface ScoredEntry {
  entry: MemoryEntry;
  score: number;
  /** Distinct content query terms this entry matched (stopwords never count). */
  hits: number;
}

/** Block header, e.g. `## mem-1720000000000 preference`. No `g` flag: safe for `.test`. */
const HEADER = /^##\s+(mem-\d+)\s+(preference|fact|decision|lesson)\s*$/;
/** A metadata line inside a block, e.g. `- at: 2024-07-03T12:00:00.000Z`. */
const META = /^-\s+(at|session|tags|source|supersedes|origin):\s*(.*)$/;

/** Render one entry to its canonical on-disk block (no trailing newline). */
export function formatEntry(e: MemoryEntry): string {
  const lines = [
    `## ${e.id} ${e.kind}`,
    `- at: ${new Date(e.at).toISOString()}`,
    `- session: ${e.session}`,
  ];
  // Emit the sentinel ONLY for generated entries — user files stay byte-identical to the legacy format.
  if (e.source === "generated") lines.push(`- source: @generated`);
  if (e.origin) lines.push(`- origin: ${e.origin}`);
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
    let origin: string | undefined;
    for (let m: RegExpExecArray | null; i < lines.length && (m = META.exec(lines[i])); i++) {
      const key = m[1];
      const val = m[2].trim();
      if (key === "at") at = Date.parse(val);
      else if (key === "session") session = val || "unknown";
      else if (key === "tags") tags = val.split(",").map((t) => t.trim()).filter(Boolean);
      // Only `@generated`/`generated` is generated; anything else (incl. junk) stays `user`.
      else if (key === "source") source = val.replace(/^@/, "") === "generated" ? "generated" : "user";
      else if (key === "supersedes" && val) supersedes = val;
      else if (key === "origin" && val) origin = val;
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

    entries.push({
      id,
      kind,
      at,
      session,
      tags,
      source,
      ...(supersedes ? { supersedes } : {}),
      ...(origin ? { origin } : {}),
      text,
    });
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

/** Unicode-aware: accented letters are word characters, so `più` stays one token
 *  (the old ascii split produced shrapnel like `pi`/`perch` that dodged the
 *  stopword list and matched shrapnel from unrelated entries). */
function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Function words carrying no topical signal (IT + EN, incl. accented forms and
 * high-frequency light verbs). Filtered from the QUERY side of scoring only:
 * in Mario's mixed-language store the *minority*-language stopwords look rare
 * to idf and score deceptively high, so a long Italian prompt pulled Italian
 * memories regardless of topic (2026-07-14 recall bug).
 */
const STOPWORDS = new Set(
  (
    "a ad al allo alla ai agli alle anche ancora avanti bene c che chi ci cioè come con cosa cose cui " +
    "da dal dallo dalla dai dagli dalle degli dei del dell dello della delle dentro di dove dopo e ed " +
    "ecco fra gli già ho hai ha abbiamo avete hanno il in io invece l la le lei li lo loro lui ma me mi " +
    "mia mie miei mio ne nei negli nelle nel nello nella no noi non nostra nostre nostri nostro o ogni " +
    "oppure per perché però più poi pure qua quale quali qualcosa quando quanta quante quanti quanto " +
    "quella quelle quelli quello questa queste questi questo qui quindi se sei senza si sia siamo siete " +
    "solo sono sopra sotto sta sto stai su sua sue suoi suo sul sullo sulla sui sugli sulle te ti tra tu " +
    "tua tue tuoi tuo tutta tutte tutti tutto un una uno vi via voi vostra vostre vostri vostro è così " +
    "essere era ero eri eravamo erano sarà sarò sarebbe stato stata stati state avere aveva avevo avevi " +
    "avevano avrebbe avuto fare faccio fai fa facciamo fate fanno fatto fatta fatti fatte deve devo devi " +
    "dobbiamo dovete devono dovrebbe può puoi possiamo potete possono potrebbe vuole voglio vuoi " +
    "vogliamo volete vogliono vorrebbe " +
    "about above after again against all am an and any are as at be because been before being below " +
    "between both but by can cannot could did do does doing done down during each few for from further " +
    "had has have having he her here hers herself him himself his how i if into is it its itself just " +
    "let may me might more most much must my myself no nor not now of off on once only or other our " +
    "ours ourselves out over own same shall she should so some such than that the their theirs them " +
    "themselves then there these they this those through to too under until up upon very was we were " +
    "what when where which while who whom why will with within without would you your yours yourself " +
    "yourselves"
  )
    .split(/\s+/)
    .filter(Boolean)
);

/** Distinct query terms that carry topical signal: stopwords and single-letter
 *  tokens (apostrophe shrapnel like the `d` in `d'uso`) are dropped. */
function contentTerms(query: string): string[] {
  return [...new Set(tokenize(query))].filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function docTokens(e: MemoryEntry): string[] {
  return tokenize(`${e.text} ${e.tags.join(" ")} ${e.kind}`);
}

/**
 * BM25-lite over lowercase word tokens (fields: text + tags + kind). idf is
 * derived from the entry corpus itself; k1=1.2, b=0.75 with per-entry length
 * normalization. Deterministic order: score desc, then newest first.
 *
 * Only CONTENT query terms score (see {@link contentTerms}): a query overlapping
 * an entry purely on stopwords scores 0, so the `recall` tool's `score > 0`
 * filter and proactive recall's floor both see silence instead of noise.
 */
export function scoreEntries(query: string, entries: MemoryEntry[]): ScoredEntry[] {
  const qTerms = contentTerms(query);
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
    let hits = 0;
    for (const term of qTerms) {
      const dfi = df.get(term) ?? 0;
      if (dfi === 0) continue;
      let tf = 0;
      for (const t of d) if (t === term) tf++;
      if (tf === 0) continue;
      hits++;
      const idf = Math.log(1 + (N - dfi + 0.5) / (dfi + 0.5));
      score += (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * dl) / avgdl));
    }
    return { entry, score, hits };
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
  for (const e of entries) for (const id of supersededIds(e.supersedes)) superseded.add(id);
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
  for (const id of supersededIds(candidate.supersedes)) {
    const target = existing.find((e) => e.id === id);
    if (target && target.source === "user") {
      return {
        ok: false,
        reason: `Truth firewall: a @generated entry may not supersede @user entry ${target.id}.`,
      };
    }
  }
  return { ok: true };
}

/** True for a string that is one of the known memory kinds. */
export function isMemoryKind(s: string): s is MemoryKind {
  return (KINDS as readonly string[]).includes(s);
}

/* ---------------------- proactive recall selection ---------------------- */

/**
 * Tuning knobs for {@link selectRecall}. Every value is a token-discipline lever:
 * loosening any of them costs the user context budget on turns that don't need it.
 */
export interface RecallOpts {
  /** Max entries injected per turn (cap). */
  k: number;
  /**
   * BM25-lite relevance floor — an entry must score AT LEAST this to be injected.
   * Deliberately STRICTER than the `recall` tool's `score > 0`: the tool is
   * model-initiated (the model already judged the query relevant), whereas
   * proactive recall fires on *every* message, so it must reject the long tail of
   * spurious single-common-word matches on its own. Calibration below.
   */
  minScore: number;
  /** Cumulative char budget across the whole injected LIST (never truncates an entry). */
  maxChars: number;
  /** Below this word count the message is too thin to recall against → inject nothing. */
  minQueryWords: number;
}

/**
 * Spec defaults (design `2026-07-09-proactive-recall`).
 *
 * `minScore = 3.0` was calibrated against Mario's real Union Store (~59 active
 * entries) by sweeping the floor over a set of genuinely-relevant queries and a
 * set of generic chatter. Findings that fixed the value:
 *  - At `3.0` every relevant probe still fired (100% recall of the wanted
 *    memories) while it is comfortably stricter than the tool's `> 0`. Raising it
 *    to `4.0` began dropping real hits without eliminating the residual spurious
 *    ones — so `3.0` is the knee.
 *  - Residual generic firing is bounded-cost by the OTHER guards (per-convo dedup
 *    pays each entry once, `k`/`maxChars` cap the turn) and is always visible via
 *    the transparency affordance — never silent.
 *
 * Recalibrated 2026-07-14 (recall bug: long dictated prompts): `scoreEntries` now
 * drops stopwords (IT+EN) from the query, so generic chatter scores 0 instead of
 * "deceptively high", and long queries additionally require ≥2 distinct
 * content-term matches (see {@link LONG_QUERY_CONTENT_TERMS}). The 3.0 floor was
 * re-validated against the real store (96 entries): relevant probes still fire,
 * the stopword-driven false recalls do not.
 */
export const DEFAULT_RECALL_OPTS: RecallOpts = {
  k: 3,
  minScore: 3.0,
  maxChars: 800,
  minQueryWords: 3,
};

/** Count word-shaped tokens (same tokenizer the scorer uses) — punctuation is not a word. */
function countWords(s: string): number {
  return tokenize(s).length;
}

/**
 * Pure per-turn memory selector for proactive recall (no Obsidian imports,
 * deterministic, fully unit-testable). Given the full parsed store and the
 * user's outbound message, return the entries worth injecting into THIS turn.
 *
 * Pipeline (each stage strictly narrows):
 *  1. Guard: a message under `minQueryWords` words recalls nothing (a bare
 *     "ok" / "thanks" must cost zero).
 *  2. `resolveSupersedence` → drop retired entries (never resurface stale truth).
 *  3. `scoreEntries` (the SAME BM25-lite the `recall` tool uses — no new search
 *     infra) → rank by relevance to the message.
 *  4. Floor: drop anything below `minScore` (stricter than the tool's `> 0`).
 *  5. Dedup: drop ids already injected earlier in this conversation, so each
 *     memory is paid for once and then lives in cached history.
 *  6. Top-`k`.
 *  7. Cumulative `maxChars`: keep whole entries in rank order until the next one
 *     would overflow the budget, then stop — the LIST is truncated, an entry's
 *     verbatim text is NEVER sliced.
 *
 * Ordering is inherited from `scoreEntries` (score desc, then newest first), so
 * the result is stable across identical calls.
 */
/** Continuation / back-reference cues (IT + EN). A message carrying one of these
 *  ("continua", "le altre cose", "as above") points at THIS conversation's own
 *  thread, not at other sessions' memory. Claude Code resolves such deixis from
 *  the transcript and injects nothing — proactive recall must do the same, or it
 *  competes with (and can hijack) the intended in-thread referent. */
const BACK_REFERENCE_CUES: RegExp[] = [
  // Italian — continuation verbs
  /\bcontinu(?:a|iamo|ate|iare|o)\b/i,
  /\bprosegu(?:i|iamo|ite|ire|o)\b/i,
  /\bproced(?:i|iamo|ete|ere|o)\b/i,
  /\briprend(?:i|iamo|ete|ere|o)\b/i,
  /\b(?:vai|andiamo|andate)\s+avanti\b/i,
  // Italian — back-deixis
  /\bcome\s+(?:sopra|detto|dicevamo)\b/i,
  /\b(?:di|quanto)\s+sopra\b/i,
  /\b(?:le\s+altre|l['’]altra)\s+cos[ae]\b/i,
  /\bcose\s+propost[ae]\b/i,
  // English — continuation
  /\bcontinue\b/i,
  /\b(?:go|carry)\s+on\b/i,
  /\bgo\s+ahead\b/i,
  /\bproceed\b/i,
  /\bkeep\s+going\b/i,
  /\bresume\b/i,
  // English — back-deixis
  /\bas\s+(?:above|discussed|mentioned|said)\b/i,
  /\bthe\s+(?:above|rest|remaining)\b/i,
];

/** True when the message is a continuation / back-reference to the current
 *  conversation (see {@link BACK_REFERENCE_CUES}). */
export function isBackReference(message: string): boolean {
  return BACK_REFERENCE_CUES.some((re) => re.test(message));
}

/** A message with at least this many content terms is a "long" query: BM25 sums
 *  over matched terms, so on long dictated prompts even a single shared common
 *  word can clear the scalar floor. Long queries therefore also require
 *  {@link MIN_HITS_LONG_QUERY} distinct content-term matches per entry. */
const LONG_QUERY_CONTENT_TERMS = 8;
const MIN_HITS_LONG_QUERY = 2;

export function selectRecall(
  entries: MemoryEntry[],
  message: string,
  alreadyInjected: Set<string>,
  opts: RecallOpts
): MemoryEntry[] {
  if (countWords(message) < opts.minQueryWords) return [];
  if (opts.k <= 0) return [];
  // A back-reference resolves from the current thread, not other sessions'
  // memory — skip recall so it can't compete with the intended referent.
  if (isBackReference(message)) return [];

  const minHits = contentTerms(message).length >= LONG_QUERY_CONTENT_TERMS ? MIN_HITS_LONG_QUERY : 1;
  const pool = resolveSupersedence(entries);
  const ranked = scoreEntries(message, pool)
    .filter((s) => s.score >= opts.minScore && s.hits >= minHits && !alreadyInjected.has(s.entry.id))
    .slice(0, opts.k);

  const out: MemoryEntry[] = [];
  let used = 0;
  for (const { entry } of ranked) {
    const next = used + entry.text.length;
    if (out.length > 0 && next > opts.maxChars) break; // list truncation, never entry truncation
    out.push(entry);
    used = next;
    if (used >= opts.maxChars) break; // budget exhausted after this whole entry
  }
  return out;
}
