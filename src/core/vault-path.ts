/**
 * Absolute tool path -> vault-relative path, on any OS.
 *
 * Claude's Write/Edit tools report absolute paths. On macOS/Linux both the
 * vault base (`FileSystemAdapter.getBasePath()`) and the tool path use `/`, so
 * a plain prefix check works. On Windows both come back with `\` separators
 * (and the drive letter case can differ between the two), so the same check
 * never matched and checkpoints, touched-note tracking and "open note" all got
 * an absolute path the vault API can't resolve. Separators are normalized and,
 * for a drive-letter base, the prefix is compared case-insensitively.
 *
 * A path outside the vault (or with no usable base) comes back unchanged.
 */
export function toVaultRelative(p: string, base: string): string {
  if (!base || base === ".") return p;
  const b = base.replace(/\\/g, "/").replace(/\/+$/, "");
  const n = p.replace(/\\/g, "/");
  const winBase = /^[A-Za-z]:\//.test(b);
  const hit = winBase ? n.toLowerCase().startsWith(b.toLowerCase() + "/") : n.startsWith(b + "/");
  return hit ? n.slice(b.length + 1) : p;
}
