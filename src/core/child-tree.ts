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
}

export function groupByParent<T extends { id: string; parentConvoId?: string }>(
  convos: T[]
): GroupedConvo<T>[] {
  const present = new Set(convos.map((c) => c.id));
  const parentOf = new Map<string, string>();
  for (const c of convos) {
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
  // no parentConvoId, the named parent isn't in this list (orphan — parent
  // archived/deleted/out of view), or the link is part of a cycle.
  const effectiveParent = (id: string): string | undefined => {
    const parent = parentOf.get(id);
    if (!parent || !present.has(parent) || hasCycle(id)) return undefined;
    return parent;
  };

  // Children bucketed by effective parent, preserving input order within each bucket.
  const byParent = new Map<string, T[]>();
  for (const c of convos) {
    const parent = effectiveParent(c.id);
    if (!parent) continue;
    const bucket = byParent.get(parent);
    if (bucket) bucket.push(c);
    else byParent.set(parent, [c]);
  }

  const emitted = new Set<string>();
  const out: GroupedConvo<T>[] = [];
  const emitChildren = (parentId: string): void => {
    for (const child of byParent.get(parentId) ?? []) {
      if (emitted.has(child.id)) continue;
      emitted.add(child.id);
      out.push({ item: child, depth: 1 });
      // Grandchildren follow their parent, still at depth 1 (see header).
      emitChildren(child.id);
    }
  };
  for (const c of convos) {
    if (emitted.has(c.id)) continue;
    // Anything with a real (present, non-cyclic) parent is emitted by that
    // parent's pass, not here — never twice.
    if (effectiveParent(c.id)) continue;
    emitted.add(c.id);
    out.push({ item: c, depth: 0 });
    emitChildren(c.id);
  }
  return out;
}
