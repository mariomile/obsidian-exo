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
 * Is this section collapsed? Absent means EXPANDED, which is what lets the
 * feature ship without a migration: an install that never toggled anything has
 * an empty list and opens exactly as it did before.
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
  return collapsed?.includes(key) === true;
}

/**
 * Flip one section, returning a NEW list — the caller persists the result, so a
 * mutation in place would make "did anything change" unanswerable and would let
 * a failed save leave the in-memory state ahead of disk.
 *
 * Collapsing appends and expanding filters, so the stored order is the order the
 * user collapsed things in; nothing reads that order, but keeping it stable
 * means a settings file doesn't churn on every unrelated save.
 */
export function toggleSectionCollapsed(
  collapsed: readonly string[] | undefined,
  key: ChatSectionKey,
): string[] {
  const current = collapsed ?? [];
  return isSectionCollapsed(current, key) ? current.filter((k) => k !== key) : [...current, key];
}
