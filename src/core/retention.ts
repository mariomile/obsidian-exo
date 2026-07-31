/**
 * Retention planner — decides what SURVIVES on disk, and what to PROPOSE for
 * cleanup. Deliberately different from the planner it replaces
 * (`planPersistedConvos`): that one returned a reduced set and the difference
 * was deleted silently. This one never shrinks `keep`.
 *
 * Two responsibilities used to be fused in `openTabIds`: which tabs the strip
 * shows, and which conversations were safe from eviction. They are now split —
 * this planner has no notion of open tabs at all. Protection is explicit:
 * the active conversation, plus whatever the user pinned.
 *
 * Pure (no `obsidian` import, no DOM) so the policy that can destroy user data
 * is unit-testable in isolation. `sizeOf` is injected rather than computed here
 * so the caller picks the cost model (exact serialization vs. estimate).
 */

export interface RetentionOpts<T> {
  /** The focused conversation — never a cleanup candidate. */
  activeId: string;
  /** Explicitly pinned conversations — never cleanup candidates. */
  pinnedIds: readonly string[];
  /** Soft ceiling for the live store. Exceeding it proposes, never deletes. */
  budgetBytes: number;
  /** Serialized weight of one conversation. Injected: see module docstring. */
  sizeOf: (c: T) => number;
}

export interface RetentionPlan<T> {
  /** Everything that stays on disk. Never reduced by the budget. */
  keep: T[];
  /** Over-budget suggestions, oldest first. Advisory: the caller presents
   *  these and the user decides. Empty when within budget. */
  candidates: T[];
  /** Total weight of `keep`, so the caller can show the real number. */
  totalBytes: number;
}

export function planRetention<
  T extends { id: string; messages: unknown[]; updatedAt?: number },
>(all: T[], opts: RetentionOpts<T>): RetentionPlan<T> {
  const protectedIds = new Set<string>([opts.activeId, ...opts.pinnedIds]);

  // Empty "New chat" husks carry no history: drop them unless protected. This
  // is the one removal this planner still performs, and it destroys nothing.
  // Original order is preserved — restore() treats the last element as active.
  const keep = all.filter((c) => c.messages.length > 0 || protectedIds.has(c.id));

  const totalBytes = keep.reduce((n, c) => n + opts.sizeOf(c), 0);
  if (totalBytes <= opts.budgetBytes) return { keep, candidates: [], totalBytes };

  // Over budget: propose the oldest unprotected conversations, oldest first,
  // until removing them WOULD bring the store under budget. Nothing leaves
  // `keep` — this list is a suggestion the user confirms.
  const byAge = keep
    .filter((c) => !protectedIds.has(c.id))
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));

  const candidates: T[] = [];
  let over = totalBytes - opts.budgetBytes;
  for (const c of byAge) {
    if (over <= 0) break;
    candidates.push(c);
    over -= opts.sizeOf(c);
  }
  return { keep, candidates, totalBytes };
}
