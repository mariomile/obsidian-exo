/**
 * Persistence trim planner — extracted verbatim from `view.ts`'s `serialize()`.
 *
 * The production behaviour this pins: eviction is recency-based, not
 * array/creation order. A conversation with an OLD position but a recent
 * `updatedAt` must survive while a newer-but-empty husk is dropped. Pinned
 * conversations (active + open tabs) are always kept, even with 0 messages, so
 * their tabs don't vanish on reload. Output preserves ORIGINAL array order
 * because `restore()` falls back to the LAST element as active.
 */
export function planPersistedConvos<
  T extends { id: string; messages: unknown[]; updatedAt?: number },
>(all: T[], activeId: string, openTabIds: string[], max: number): T[] {
  // A conversation must survive restore if it's active or an open (possibly empty)
  // placeholder tab — otherwise those tabs vanish on reload.
  const pinned = new Set<string>([activeId, ...openTabIds]);
  // Drop empty "New chat" husks that aren't pinned so they don't waste slots.
  const filtered = all.filter((c) => c.messages.length > 0 || pinned.has(c.id));
  // Evict by recency (not array/creation order): always keep pinned, then fill the
  // remaining slots by updatedAt desc. Emit in ORIGINAL array order (restore() falls
  // back to the LAST element as active, so stable order matters).
  if (filtered.length <= max) return filtered;
  const keptIds = new Set<string>(filtered.filter((c) => pinned.has(c.id)).map((c) => c.id));
  const rest = filtered
    .filter((c) => !pinned.has(c.id))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  for (const c of rest) {
    if (keptIds.size >= max) break;
    keptIds.add(c.id);
  }
  return filtered.filter((c) => keptIds.has(c.id));
}
