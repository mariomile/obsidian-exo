/**
 * Presentation state for the `exo-chats` sidebar — the two decisions that are
 * NOT derivable from the conversations themselves:
 *
 *  1. which sections the user has collapsed, and
 *  2. which status dot a row earns in the reserved gutter.
 *
 * Pure and Obsidian-free, same discipline as `chat-rows.ts`: that module decides
 * what the list contains, this one decides how much of it is on screen, and the
 * view owns only the DOM. Both are unit-testable without mounting a pane.
 */
import type { ChatSectionKey } from "./chat-rows";

/**
 * The three states the gutter dot can say, and nothing else. Deliberately NOT
 * "has a badge": a stopped or errored turn already renders its own icon on the
 * row, and saying the same thing twice in two visual channels is exactly the
 * conflation the rails were removed for.
 *
 * The names are the user-facing meanings, not the CSS shapes — filled / ring /
 * small is the rendering choice, and it lives in the stylesheet where a redesign
 * can change it without touching this rule.
 */
export type ChatDot = "running" | "needs-you" | "unseen";

/**
 * Which dot, if any. One channel, so the states are ranked rather than stacked:
 *
 *  - `needs-you` first, matching `deriveLane`'s own precedence — a conversation
 *    blocked on a permission prompt is STILL streaming, and showing it as
 *    "working" would hide the one row that cannot progress without the user.
 *  - `running` next: something is happening, nothing is asked of you.
 *  - `unseen` last: nothing is happening, but news arrived while you were
 *    elsewhere. It loses to both live states because they are strictly newer
 *    information about the same conversation.
 *
 * `null` means at rest — the gutter stays reserved and stays empty.
 */
export function chatDot(row: { lane?: "running" | "needs-input"; unseen: boolean }): ChatDot | null {
  if (row.lane === "needs-input") return "needs-you";
  if (row.lane === "running") return "running";
  return row.unseen ? "unseen" : null;
}

/**
 * The one collapse rule, shared by the two things that collapse. Absent means
 * EXPANDED, which is what lets either feature ship without a migration: an
 * install that never toggled anything has an empty list and opens exactly as it
 * did before.
 */
const isCollapsed = (collapsed: readonly string[] | undefined, key: string): boolean =>
  collapsed?.includes(key) === true;

/**
 * Flip one key, returning a NEW list — the caller persists the result, so a
 * mutation in place would make "did anything change" unanswerable and would let
 * a failed save leave the in-memory state ahead of disk.
 *
 * Collapsing appends and expanding FILTERS (rather than removing one match), so
 * a list that somehow accumulated a duplicate is deduped by the next expand
 * instead of needing two clicks. The stored order is the order the user
 * collapsed things in; nothing reads that order, but keeping it stable means a
 * settings file doesn't churn on every unrelated save.
 */
const flipCollapsed = (collapsed: readonly string[] | undefined, key: string): string[] => {
  const current = collapsed ?? [];
  return isCollapsed(current, key) ? current.filter((k) => k !== key) : [...current, key];
};

/**
 * Is this section collapsed?
 *
 * Keyed by `ChatSectionKey` and never by label — a section keyed by its display
 * text loses the user's choice the day "Settled" gets reworded.
 *
 * The list itself lives in `settings.chatsCollapsed`, next to `chatsMode`,
 * because it is the same kind of thing: a small, durable view preference the
 * pane reads on every paint and Obsidian persists in the plugin's own data.json.
 */
export function isSectionCollapsed(
  collapsed: readonly string[] | undefined,
  key: ChatSectionKey,
): boolean {
  return isCollapsed(collapsed, key);
}

/** Flip one section. See `flipCollapsed`. */
export function toggleSectionCollapsed(
  collapsed: readonly string[] | undefined,
  key: ChatSectionKey,
): string[] {
  return flipCollapsed(collapsed, key);
}

/**
 * Has the user folded away the fan-out children of THIS conversation? Same
 * contract as the section pair above, and deliberately a SEPARATE list
 * (`settings.chatsCollapsedParents`): the two are keyed in different
 * namespaces — a section key vs a conversation id — and merging them would let
 * a conversation whose id happened to read `settings` collapse the Settled
 * section, and would make "expand everything" ambiguous.
 *
 * A stale id — a conversation since deleted or archived — is simply never asked
 * about again, so the list needs no pruning pass and no migration.
 */
export function isParentCollapsed(
  collapsed: readonly string[] | undefined,
  convoId: string,
): boolean {
  return isCollapsed(collapsed, convoId);
}

/** Flip one parent's children. See `flipCollapsed`. */
export function toggleParentCollapsed(
  collapsed: readonly string[] | undefined,
  convoId: string,
): string[] {
  return flipCollapsed(collapsed, convoId);
}

/** What per-parent collapse means for one painted list. */
export interface ChildCollapse {
  /** Row ids that must not render: their parent is collapsed. */
  hidden: ReadonlySet<string>;
  /** Per parent id, how many rows are nested under it — the number a collapsed
   *  parent shows, so putting children away can never be the same thing as
   *  forgetting they exist. Present for every parent, collapsed or not. */
  counts: ReadonlyMap<string, number>;
}

/**
 * Resolve per-parent collapse over the painted order.
 *
 * Read POSITIONALLY, not by walking `parentConvoId`, and that is the point: the
 * tree is already flattened to one indent level, so a grandchild's own parent
 * is a depth-1 row while the row it must disappear with is the depth-0 one
 * above them both. The rendered run — a depth-0 row followed by every depth-1
 * row until the next depth-0 row — IS the subtree, by construction in
 * `groupAcrossHomes`, so collapsing that run hides exactly the descendants and
 * nothing of the next parent's.
 *
 * Sections can be concatenated and passed in one call: a child is always
 * emitted into its parent's home, so every section begins at depth 0 and a new
 * section's first row closes the previous section's last run.
 */
export function collapseChildren(
  items: readonly { id: string; depth: 0 | 1 }[],
  collapsed: readonly string[] | undefined,
): ChildCollapse {
  const hidden = new Set<string>();
  const counts = new Map<string, number>();
  let parent: string | null = null;
  for (const row of items) {
    if (row.depth === 0) {
      parent = row.id;
      continue;
    }
    // Unreachable given the invariant above; treated as a root rather than
    // attributed to whatever parent happened to precede it in another section.
    if (parent === null) continue;
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
    if (isCollapsed(collapsed, parent)) hidden.add(row.id);
  }
  return { hidden, counts };
}
