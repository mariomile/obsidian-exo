/**
 * Patch selected top-level YAML frontmatter keys without parsing and
 * re-serializing the whole block. Obsidian's `processFrontMatter()` normalizes
 * every value and can corrupt vault-specific YAML such as unquoted wikilinks
 * (`company: [[Acme]]`). Keeping untouched lines byte-for-byte is therefore a
 * correctness requirement for agent-driven edits.
 */

function yamlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function yamlValue(value: unknown): string {
  if (value === undefined) return "null";
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

function topLevelKey(line: string): string | null {
  if (!line || /^[ \t#-]/.test(line)) return null;
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  const raw = line.slice(0, colon).trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

function replaceKeyBlock(block: string, key: string, line: string | null, newline: string): string {
  const lines = block ? block.split(/\r?\n/) : [];
  const start = lines.findIndex((candidate) => topLevelKey(candidate) === key);
  if (start < 0) {
    if (line !== null) lines.push(line);
    return lines.join(newline);
  }
  let end = start + 1;
  while (end < lines.length && topLevelKey(lines[end]) === null) end++;
  lines.splice(start, end - start, ...(line === null ? [] : [line]));
  return lines.join(newline);
}

function frontmatterBounds(content: string): { start: number; end: number } | null {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return null;
  const match = /\r?\n---(?:\r?\n|$)/g;
  match.lastIndex = content.indexOf("\n") + 1;
  const closing = match.exec(content);
  if (!closing) return null;
  return { start: content.indexOf("\n") + 1, end: closing.index };
}

/** Merge/remove top-level keys while preserving every unrelated frontmatter byte. */
export function patchFrontmatter(
  content: string,
  changes: Record<string, unknown>,
  removeKeys: readonly string[] = []
): string {
  const entries = Object.entries(changes);
  if (!entries.length && !removeKeys.length) return content;

  const bounds = frontmatterBounds(content);
  if (!bounds) {
    if (!entries.length) return content;
    const lines = entries.map(([key, value]) => `${yamlKey(key)}: ${yamlValue(value)}`).join("\n");
    return `---\n${lines}\n---\n${content}`;
  }

  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  let block = content.slice(bounds.start, bounds.end);
  for (const key of removeKeys) {
    block = replaceKeyBlock(block, key, null, newline);
  }
  for (const [key, value] of entries) {
    const line = `${yamlKey(key)}: ${yamlValue(value)}`;
    block = replaceKeyBlock(block, key, line, newline);
  }
  return content.slice(0, bounds.start) + block + content.slice(bounds.end);
}
