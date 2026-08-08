/**
 * Who owns a conversation's title. Pure so the rule is testable — `view.ts` has
 * no test harness, and this rule has two call sites with different shapes
 * (a synchronous derivation and an async AI result), which is exactly how a
 * duplicated guard drifts.
 *
 * `titleLocked` is deliberately NOT `aiTitleApplied`: that one is retry policy
 * ("did we already generate one"), this one is ownership ("may we write at
 * all"). Collapsing them would make a failed generation reopen a user's title.
 */
export type TitleSource = "first-message" | "ai";

export interface TitleOwnership {
  title: string;
  titleLocked?: boolean;
}

export function canAutoTitle(c: TitleOwnership, source: TitleSource): boolean {
  if (c.titleLocked) return false;
  // The AI title supersedes the crude first-message slice, so it may overwrite.
  // The derivation may only fill an empty slot.
  if (source === "ai") return true;
  return !c.title || c.title === "New chat";
}

/**
 * Validate and apply a manual rename: trims the title, looks up the
 * conversation (falling back to `active`, since a fresh conversation isn't
 * always in `convos` yet), and locks it. Returns null — leaving the
 * conversation untouched — on a blank title or an unknown id. Kept out of
 * `view.ts` (under a size ratchet, see `tests/size-contract.test.ts`) so the
 * lookup-and-lock rule lands next to `canAutoTitle` instead of growing the
 * file it's meant to protect from growing.
 */
export function applyRename<C extends TitleOwnership & { id: string }>(
  convos: C[],
  active: C,
  id: string,
  title: string,
): C | null {
  const next = title.trim();
  if (!next) return null;
  const c = convos.find((x) => x.id === id) ?? (active.id === id ? active : undefined);
  if (!c) return null;
  c.title = next;
  c.titleLocked = true;
  return c;
}
