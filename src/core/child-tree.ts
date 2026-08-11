/**
 * Child-tree grouping — the pure projection behind the chats sidebar's indented
 * children (no Obsidian imports, no DOM).
 *
 * The sidebar shows a flat list; this decides the ORDER and the indent level so
 * the view only renders. Indentation is capped at one level on purpose: a
 * grandchild renders beside its parent rather than marching rightwards, since
 * the sidebar is narrow and the fan-out depth cap is 2 anyway.
 */

/** One rendered row: the original item plus how far to indent it. */
export interface GroupedConvo<T> {
  item: T;
  depth: 0 | 1;
  /**
   * Does anything render NESTED UNDER this row in the output? Decided here,
   * where the parent→children map already exists — a caller re-deriving it from
   * the flat result would be answering the same question with worse
   * information, and would drift the day the anchoring rules change.
   *
   * Always `false` at depth 1, and that is the definition rather than an
   * omission: the indent is capped at one level, so a grandchild renders BESIDE
   * its parent, not under it. A row that is itself indented has nothing beneath
   * it to hide, which is exactly what a collapse control on it would promise.
   *
   * Also `false` for a parent whose only child was anchored away (see
   * `opts.isAnchored`): that child stayed in its own home, so nothing is
   * nested here either.
   */
  hasChildren: boolean;
}

/**
 * Pull every child — and every further descendant, still capped at depth 1 —
 * OUT of whatever home it would otherwise occupy and place it directly after
 * its parent, in the home the PARENT landed in. `homes` is an ordered map of
 * named collections (e.g. `"active"`, `"day:Today"`); a row's parent is looked
 * up across ALL of them, not just its own, which is what lets a parent in one
 * collection and a child in another end up nested together instead of stuck
 * in the tiers they individually earned.
 *
 * `opts.isAnchored`, when supplied, marks rows that must never be relocated:
 * an anchored row stays in whatever home it was already given, at depth 0,
 * regardless of where its parent lives. It can still BE a parent — its own
 * children keep nesting under it, in its home, same as any other root; only
 * its OWN position is pinned. This is for a row whose liveness outranks
 * nesting (a conversation running or blocked on the user), which must not be
 * able to vanish into a parent's day bucket just because that parent happens
 * to be an old closed chat.
 *
 * A root — no parent, an absent parent (archived, filtered out, never in this
 * call at all), anchored, or part of a cycle — stays in its own home, in the
 * order that home already supplied. Every id in the input appears in the
 * output exactly once: `groupByParent` below is the single-home, unanchored
 * case of this same pass, so the two never drift into two different sets of
 * rules.
 */
export function groupAcrossHomes<T extends { id: string; parentConvoId?: string }>(
  homes: ReadonlyMap<string, readonly T[]>,
  opts?: { isAnchored?: (item: T) => boolean }
): Map<string, GroupedConvo<T>[]> {
  const allRows: T[] = [];
  for (const rows of homes.values()) allRows.push(...rows);

  const present = new Set(allRows.map((c) => c.id));
  const byId = new Map(allRows.map((c) => [c.id, c]));
  const parentOf = new Map<string, string>();
  for (const c of allRows) {
    if (c.parentConvoId) parentOf.set(c.id, c.parentConvoId);
  }

  // parentConvoId comes from a hand-editable ledger, so a chain can cycle
  // (a -> b -> a). Walking such a chain must terminate, and every item in a
  // cycle must still render — so a cyclic link is treated as absent: each
  // item in the cycle becomes its own root rather than being dropped.
  const hasCycle = (startId: string): boolean => {
    const seen = new Set<string>([startId]);
    let cur = parentOf.get(startId);
    while (cur !== undefined && present.has(cur)) {
      if (seen.has(cur)) return true;
      seen.add(cur);
      cur = parentOf.get(cur);
    }
    return false;
  };

  // The parent to group under, or undefined if this item should be a root:
  // it is anchored, has no parentConvoId, the named parent isn't present
  // ANYWHERE across the supplied homes (orphan — parent archived/deleted/
  // filtered out), or the link is part of a cycle. Anchoring is checked
  // first and short-circuits the rest — an anchored row is a root by
  // definition, whatever its parent chain says.
  const effectiveParent = (id: string): string | undefined => {
    if (opts?.isAnchored?.(byId.get(id) as T)) return undefined;
    const parent = parentOf.get(id);
    if (!parent || !present.has(parent) || hasCycle(id)) return undefined;
    return parent;
  };

  // Children bucketed by effective parent, preserving input order within each
  // bucket — the order rows are visited in below, which is home-by-home in
  // the order `homes` supplies them, then row order within each home.
  const byParent = new Map<string, T[]>();
  for (const c of allRows) {
    const parent = effectiveParent(c.id);
    if (!parent) continue;
    const bucket = byParent.get(parent);
    if (bucket) bucket.push(c);
    else byParent.set(parent, [c]);
  }

  const out = new Map<string, GroupedConvo<T>[]>();
  for (const home of homes.keys()) out.set(home, []);

  const emitted = new Set<string>();
  const emitChildren = (parentId: string, home: string): void => {
    for (const child of byParent.get(parentId) ?? []) {
      if (emitted.has(child.id)) continue;
      emitted.add(child.id);
      out.get(home)!.push({ item: child, depth: 1, hasChildren: false });
      // Grandchildren follow their parent into the SAME home, still at
      // depth 1 (see header) — never their own natural home.
      emitChildren(child.id, home);
    }
  };
  for (const [home, rows] of homes) {
    for (const c of rows) {
      if (emitted.has(c.id)) continue;
      // Anything with a real (present, non-cyclic) parent is emitted by that
      // parent's pass, into the parent's home — never twice, never here.
      if (effectiveParent(c.id)) continue;
      emitted.add(c.id);
      // A bucket only ever exists because something was pushed into it, so a
      // present key means at least one row is about to be emitted under this
      // one — no separate emptiness check to keep in sync.
      out.get(home)!.push({ item: c, depth: 0, hasChildren: byParent.has(c.id) });
      emitChildren(c.id, home);
    }
  }
  return out;
}

/** Single-home case of `groupAcrossHomes`: nothing ever moves collections,
 *  so this is what a plain flat list looks like once children are indented
 *  under their parents. Kept as its own export because most callers — and
 *  every existing test — only ever have the one list. */
export function groupByParent<T extends { id: string; parentConvoId?: string }>(
  convos: T[]
): GroupedConvo<T>[] {
  return groupAcrossHomes(new Map([["_", convos]])).get("_") ?? [];
}
