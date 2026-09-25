import { App, prepareSimpleSearch } from "obsidian";
import { pluginInstance } from "./tool-kit";
import { makeExclusion, type PathFilter } from "../core/vault-exclusions";

/**
 * One vault search for everything that ranks notes: the `search_vault` tool,
 * memory harvest (finding the note a fact belongs in) and per-turn recall.
 *
 * Sonar first, through its declared cross-plugin API
 * (`app.plugins.plugins['sonar'].search(query, { limit })`, obsidian-sonar
 * README "Cross-plugin API"): it waits a bounded time for its index and ranks
 * with BM25F. Without Sonar, or when its call throws, the built-in scorer below
 * runs over the most recently edited notes.
 */

export interface NoteHit {
  path: string;
  title: string;
  score: number;
  excerpt: string;
}

export interface VaultSearchResult {
  hits: NoteHit[];
  /** Set when the built-in scorer ran on a capped subset: total notes vs scanned. */
  capped?: { scanned: number; total: number };
}

/** Sonar's public search surface. */
interface SonarPublicSearch {
  search(query: string, opts?: { limit?: number }): Promise<NoteHit[]>;
}

const SKIP_LARGER_THAN = 200_000;
/** Cap on the built-in fallback scan (Sonar has no such limit). */
const MAX_SCAN_FILES = 2000;

/** The user's "Excluded files" (Obsidian `userIgnoreFilters`, prefixes and
 *  `/regex/`), dot-folders, and `extraPrefixes`, as one path filter. */
export function vaultExclusion(app: App, extraPrefixes: readonly string[] = []): PathFilter {
  const filters = (app.vault as unknown as { getConfig?(key: string): unknown }).getConfig?.("userIgnoreFilters");
  return makeExclusion(Array.isArray(filters) ? filters : [], extraPrefixes);
}

function sonarSearch(app: App): SonarPublicSearch | null {
  const p = pluginInstance(app, "sonar") as Partial<SonarPublicSearch> | undefined;
  return p && typeof p.search === "function" ? (p as SonarPublicSearch) : null;
}

/** `exclude` drops paths from both engines (Sonar is asked for extra hits so
 *  the filtered list still fills `limit`). */
export async function searchVaultNotes(
  app: App,
  query: string,
  limit: number,
  exclude?: PathFilter,
): Promise<VaultSearchResult> {
  if (!query.trim()) return { hits: [] };
  const sonar = sonarSearch(app);
  if (sonar) {
    try {
      const hits = await sonar.search(query, { limit: exclude ? Math.min(limit * 3, 100) : limit });
      return {
        hits: hits
          .filter((h) => !exclude?.(h.path))
          .slice(0, limit)
          .map((h) => ({ path: h.path, title: h.title, score: h.score, excerpt: h.excerpt ?? "" })),
      };
    } catch {
      /* Sonar failed: the built-in scorer answers instead. */
    }
  }
  return builtinSearch(app, query, limit, exclude);
}

async function builtinSearch(app: App, query: string, limit: number, exclude?: PathFilter): Promise<VaultSearchResult> {
  const search = prepareSimpleSearch(query);
  const hits: NoteHit[] = [];
  const files = app.vault
    .getMarkdownFiles()
    .filter((f) => f.stat.size <= SKIP_LARGER_THAN && !exclude?.(f.path))
    .sort((a, b) => b.stat.mtime - a.stat.mtime);
  for (const file of files.slice(0, MAX_SCAN_FILES)) {
    let text = file.basename;
    try {
      text += "\n" + (await app.vault.cachedRead(file));
    } catch {
      continue; // skip unreadable
    }
    const r = search(text);
    if (r) {
      const at = r.matches[0]?.[0] ?? 0;
      const excerpt = text.slice(Math.max(0, at - 40), at + 80).replace(/\s+/g, " ").trim();
      hits.push({ path: file.path, title: file.basename, score: r.score, excerpt });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return {
    hits: hits.slice(0, limit),
    ...(files.length > MAX_SCAN_FILES ? { capped: { scanned: MAX_SCAN_FILES, total: files.length } } : {}),
  };
}
