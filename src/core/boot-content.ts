/**
 * Boot-injected file heads, pure (no Obsidian imports).
 *
 * WHY (2026-08-11 calibration): `readBootContext` head-slices raw files, but the
 * head of a vault note is its YAML frontmatter, which carries no signal for the
 * model. Every boot char must carry signal.
 */
import { stripFrontmatter } from "./agents";

/** Same marker `readBootContext`'s cap has always used: truncation stays explicit. */
const TRUNCATION_MARKER = "\n…(truncated)";

export function bootFileHead(raw: string, max: number): string {
  const body = stripFrontmatter(raw).trim();
  return body.length > max ? body.slice(0, max) + TRUNCATION_MARKER : body;
}
