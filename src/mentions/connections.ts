/**
 * Obsidian-facing adapter for the Connections engine. Bridges the live
 * metadataCache/vault to the pure `mentions-core`: gathers backlinks and
 * frontmatter-related notes via `graph.ts`, scans candidate note bodies for
 * unlinked mentions, drops ignored pairs, and ranks the union. Kept thin — all
 * matching/scoring/mutation logic is pure and unit-tested in `mentions-core`.
 */

import { App, TFile } from "obsidian";
import { backlinks, relatedFromFrontmatter } from "../obsidian/graph";
import {
  unlinkedMentions,
  outgoingMentions,
  flattenOutgoing,
  rankConnections,
  applyLinks,
  type MentionTarget,
  type CandidateDoc,
  type UnlinkedMatch,
  type ConnectionItem,
  type RankInput,
  type FlatOutgoing,
} from "./mentions-core";
import { fold } from "./tokenizer";
import { isIgnored, filterIgnored, type IgnoreStore, EMPTY_IGNORE_STORE } from "./store-core";
import { exoPaths, LEGACY_MEMORY_ROOT } from "../core/paths";

/** Path prefixes never scanned for mentions (mirrors `rule-auto-link` exclusions).
 *  The memory layer is tool data, not notes, so the configured root is excluded. */
export function defaultExcludePrefixes(memoryRoot: string): string[] {
  return [
    "Journal/Daily/",
    "Resources/Readwise/",
    "Resources/Templates/",
    `${exoPaths(memoryRoot).root}/`,
    ".archive/",
  ];
}

/** Legacy-root default for tests/fallback; live callers pass the configured root. */
export const DEFAULT_EXCLUDE_PREFIXES = defaultExcludePrefixes(LEGACY_MEMORY_ROOT);

const MAX_SCAN_FILES = 4000;
const SKIP_LARGER_THAN = 200_000;

export interface Connections {
  target: TFile;
  linked: string[];
  related: string[];
  unlinked: UnlinkedMatch[];
  /** The union of all three, deduped (strongest kind wins) and ranked. */
  ranked: ConnectionItem[];
}

/** Blank a leading YAML frontmatter block with spaces so its text isn't scanned,
 *  while every body offset stays aligned to the original file. */
export function blankFrontmatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  if (!m || m.index !== 0) return text;
  return " ".repeat(m[0].length) + text.slice(m[0].length);
}

function targetOf(app: App, file: TFile): MentionTarget {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  const rawAliases = fm?.aliases;
  const aliases = Array.isArray(rawAliases)
    ? rawAliases.map(String)
    : rawAliases
      ? [String(rawAliases)]
      : [];
  return { path: file.path, basename: file.basename, aliases };
}

/**
 * Gather the four connection buckets for `file`. Async — reads candidate bodies
 * via `cachedRead`. `unlinked` scanning is prefiltered by a cheap folded
 * substring test so only notes that plausibly contain the name are tokenized.
 */
export async function gatherConnections(
  app: App,
  file: TFile,
  ignore: IgnoreStore = EMPTY_IGNORE_STORE,
  opts: { stem?: boolean; now?: number; excludePrefixes?: string[] } = {},
): Promise<Connections> {
  const target = targetOf(app, file);
  const excludePrefixes = opts.excludePrefixes ?? DEFAULT_EXCLUDE_PREFIXES;

  const linked = backlinks(app, file);
  const related = relatedFromFrontmatter(app, file);
  const linkedSet = new Set(linked);

  // Cheap prefilter: only tokenize notes whose folded body contains a folded
  // alias. Accent-insensitive on both sides (one fold pass per candidate).
  const names = [target.basename, ...target.aliases].map(fold).filter((s) => s.length >= 3);
  const candidates: CandidateDoc[] = [];
  const files = app.vault
    .getMarkdownFiles()
    .filter((f) => f.stat.size <= SKIP_LARGER_THAN)
    .sort((a, b) => b.stat.mtime - a.stat.mtime)
    .slice(0, MAX_SCAN_FILES);
  for (const f of files) {
    if (f.path === file.path) continue;
    if (excludePrefixes.some((p) => f.path.startsWith(p))) continue;
    let raw: string;
    try {
      raw = await app.vault.cachedRead(f);
    } catch {
      continue;
    }
    const folded = fold(raw);
    if (!names.some((n) => folded.includes(n))) continue;
    candidates.push({
      path: f.path,
      text: blankFrontmatter(raw),
      mtime: f.stat.mtime,
      alreadyLinks: linkedSet.has(f.path),
    });
  }

  const now = opts.now ?? Date.now();
  const rawUnlinked = unlinkedMentions(target, candidates, {
    stem: opts.stem ?? false,
    now,
    excludePrefixes,
  });
  const unlinked = filterIgnored(rawUnlinked, fold(target.basename), ignore);

  const rankInput: RankInput[] = [
    ...related.map((p) => ({ path: p, kind: "related" as const, mtime: mtimeOf(app, p) })),
    ...linked.map((p) => ({ path: p, kind: "linked" as const, mtime: mtimeOf(app, p) })),
    ...unlinked.map((u) => ({
      path: u.sourcePath,
      kind: "unlinked" as const,
      mtime: mtimeOf(app, u.sourcePath),
      ranges: u.ranges,
      snippet: u.snippet,
    })),
  ];

  return { target: file, linked, related, unlinked, ranked: rankConnections(rankInput, now) };
}

function mtimeOf(app: App, path: string): number {
  const f = app.vault.getAbstractFileByPath(path);
  return f instanceof TFile ? f.stat.mtime : 0;
}

/* ---------------------- outgoing (inline) ---------------------- */

/** Build a mention target for every markdown note, pulling `aliases` from the
 *  cached frontmatter (no body reads — cheap enough to run per keystroke-debounce). */
function allTargets(app: App, excludePrefixes: string[]): MentionTarget[] {
  const out: MentionTarget[] = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (excludePrefixes.some((p) => f.path.startsWith(p))) continue;
    const rawAliases = app.metadataCache.getFileCache(f)?.frontmatter?.aliases;
    const aliases = Array.isArray(rawAliases)
      ? rawAliases.map(String)
      : rawAliases
        ? [String(rawAliases)]
        : [];
    out.push({ path: f.path, basename: f.basename, aliases });
  }
  return out;
}

/**
 * Find the outgoing unlinked mentions in `file`'s body — other notes' titles it
 * cites in plain text — flattened (overlaps resolved) and with ignored pairs
 * dropped. This drives the inline underline. `text` may be passed in to match
 * the live editor buffer; omit to read from disk.
 */
export async function gatherOutgoing(
  app: App,
  file: TFile,
  ignore: IgnoreStore = EMPTY_IGNORE_STORE,
  opts: { stem?: boolean; excludePrefixes?: string[]; text?: string } = {},
): Promise<FlatOutgoing[]> {
  const excludePrefixes = opts.excludePrefixes ?? DEFAULT_EXCLUDE_PREFIXES;
  const raw = opts.text ?? (await app.vault.cachedRead(file));
  const targets = allTargets(app, excludePrefixes);
  const matches = outgoingMentions(blankFrontmatter(raw), targets, {
    stem: opts.stem ?? false,
    selfPath: file.path,
  });
  const flat = flattenOutgoing(matches);
  return flat.filter((f) => !isIgnored(ignore, fold(f.targetBasename), file.path));
}

/**
 * Convert every unlinked occurrence of `target` in `source` into a wikilink,
 * in one link/undo-safe modify. Returns the number of occurrences linked. Reads
 * the live file, blanks frontmatter to locate matches, then applies the mutation
 * to the ORIGINAL text via exact offsets (frontmatter is byte-identical, so the
 * offsets map straight through).
 */
export async function linkMentionsIn(app: App, source: TFile, target: TFile): Promise<number> {
  const raw = await app.vault.read(source);
  const [match] = unlinkedMentions(targetOf(app, target), [
    { path: source.path, text: blankFrontmatter(raw), mtime: source.stat.mtime, alreadyLinks: false },
  ]);
  if (!match || match.ranges.length === 0) return 0;
  const next = applyLinks(raw, match.ranges, target.basename);
  if (next !== raw) await app.vault.modify(source, next);
  return match.ranges.length;
}
