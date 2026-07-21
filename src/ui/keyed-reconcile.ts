/**
 * Keyed DOM list reconciliation — the tabx lesson (never recreate-all). Given a
 * container and a desired, ordered list of `CardModel`s (a stable key, a
 * signature of the rendered state, and a builder), it removes gone nodes,
 * rebuilds only nodes whose signature changed, adds new ones, and reorders to
 * match — leaving untouched nodes (and scroll/focus/in-flight interaction)
 * intact. UI-agnostic: any view with keyed children can reuse it.
 *
 * A full `container.empty()` + rebuild resets scroll, reflashes every child, and
 * destroys drag/menu state on each tick; this touches only what actually changed.
 */

/** One reconcilable child element. */
export interface CardModel {
  /** Stable identity across renders (e.g. `t:<taskId>` / `s:<convoId>`). */
  key: string;
  /** Signature of the rendered state; when unchanged the node is left untouched. */
  sig: string;
  /** Build a fresh, detached element for this model (called only on add/change). */
  build: () => HTMLElement;
}

/**
 * Reconcile `list`'s children to match `desired` (order-significant). Nodes are
 * keyed via `data-cardKey`/`data-cardSig`, which this function owns and stamps.
 */
export function reconcileList(list: HTMLElement, desired: CardModel[]): void {
  const existing = new Map<string, HTMLElement>();
  for (const el of Array.from(list.children) as HTMLElement[]) {
    if (el.dataset.cardKey) existing.set(el.dataset.cardKey, el);
  }
  const wanted = new Set(desired.map((d) => d.key));
  for (const [key, el] of existing) {
    if (!wanted.has(key)) {
      el.remove();
      existing.delete(key);
    }
  }
  desired.forEach((model, i) => {
    let el = existing.get(model.key);
    if (!el || el.dataset.cardSig !== model.sig) {
      const fresh = model.build();
      fresh.dataset.cardKey = model.key;
      fresh.dataset.cardSig = model.sig;
      if (el) el.replaceWith(fresh);
      el = fresh;
      existing.set(model.key, el);
    }
    const at = list.children[i] ?? null;
    if (at !== el) list.insertBefore(el, at);
  });
}
