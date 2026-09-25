/**
 * Which vault paths memory must not read from or write to, pure.
 *
 * Mirrors Obsidian's "Excluded files" setting (`userIgnoreFilters`): an entry
 * wrapped in slashes (`/regex/`) is a regular expression tested against the
 * path, anything else is a path prefix. On top of that, any path with a
 * dot-segment (`.obsidian/`, `.archive/`, `.trash/`) is excluded, plus the
 * caller's own extra prefixes (e.g. Exo's reports folder). No Obsidian import.
 */

export type PathFilter = (path: string) => boolean;

export function makeExclusion(userFilters: readonly unknown[], extraPrefixes: readonly string[] = []): PathFilter {
  const regexes: RegExp[] = [];
  const prefixes: string[] = [...extraPrefixes];
  for (const f of userFilters) {
    if (typeof f !== "string" || !f.trim()) continue;
    const m = /^\/(.+)\/$/.exec(f.trim());
    if (m) {
      try {
        regexes.push(new RegExp(m[1]));
      } catch {
        /* an invalid pattern excludes nothing, as in Obsidian */
      }
    } else {
      prefixes.push(f.trim());
    }
  }
  return (path) => {
    const p = path.replace(/^\.?\//, "");
    if (p.split("/").some((part) => part.startsWith("."))) return true;
    if (prefixes.some((pre) => p.startsWith(pre))) return true;
    return regexes.some((re) => re.test(p));
  };
}
