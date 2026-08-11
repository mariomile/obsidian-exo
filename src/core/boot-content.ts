/**
 * Boot-injected file heads, pure (no Obsidian imports).
 *
 * WHY (2026-08-11 calibration): `readBootContext` head-slices raw files, but the
 * head of a vault note is its YAML frontmatter, and for GENERATED logs (the
 * session log) also a fixed prose header. Measured on the real vault, the
 * 600-char "Recent sessions" slice carried 0 session entries: pure boilerplate.
 * Every boot char must carry signal; frontmatter and generated-file warnings
 * carry none for the model.
 */
import { stripFrontmatter } from "./agents";

export interface BootHeadOpts {
  /** Skip everything before the first `## ` heading, for generated log files
   *  whose prose header (title, "file is generated" warning) carries no signal.
   *  Falls back to the frontmatter-stripped body when no heading exists. */
  fromFirstHeading?: boolean;
}

/** Same marker `readBootContext`'s cap has always used: truncation stays explicit. */
const TRUNCATION_MARKER = "\n…(truncated)";

export function bootFileHead(raw: string, max: number, opts: BootHeadOpts = {}): string {
  let body = stripFrontmatter(raw);
  if (opts.fromFirstHeading) {
    const m = /^## /m.exec(body);
    if (m) body = body.slice(m.index);
  }
  body = body.trim();
  return body.length > max ? body.slice(0, max) + TRUNCATION_MARKER : body;
}
