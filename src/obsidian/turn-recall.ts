import type { App } from "obsidian";
import type { ChatRecord } from "../core/recent-chats";
import {
  formatRecallBlock,
  matchPastChats,
  recallKeywords,
  shouldRecall,
  RECALL_MAX_NOTES,
  type ChatRecall,
  type NoteRecall,
} from "../core/turn-recall";
import { searchVaultNotes, vaultExclusion } from "./vault-search";
import type { PathFilter } from "../core/vault-exclusions";

/** What recall found for one outbound message. */
export interface TurnRecall {
  block: string;
  notes: NoteRecall[];
  chats: ChatRecall[];
}

/**
 * Per-turn recall, impure half: search the vault (Sonar, else the built-in
 * scorer) and the conversation store with the message's keywords, and build
 * the budgeted `[vault-recall]` block. Null when the message is too short, a
 * slash command, or nothing matched. Never throws: recall must not cost a turn.
 */
export async function recallForTurn(
  app: App,
  input: { message: string; convoId: string; chats: readonly ChatRecord[]; now: number; exclude?: PathFilter },
): Promise<TurnRecall | null> {
  if (!shouldRecall(input.message)) return null;
  const keywords = recallKeywords(input.message);
  if (!keywords.length) return null;
  let notes: NoteRecall[] = [];
  try {
    const exclude = input.exclude ?? vaultExclusion(app);
    const { hits } = await searchVaultNotes(app, keywords.join(" "), RECALL_MAX_NOTES, exclude);
    notes = hits
      .slice(0, RECALL_MAX_NOTES)
      .map((h) => ({ path: h.path, excerpt: h.excerpt }));
  } catch {
    /* search failed: chats alone may still recall something */
  }
  const chats = matchPastChats(input.chats, keywords, { excludeId: input.convoId, now: input.now });
  const block = formatRecallBlock(notes, chats);
  return block ? { block, notes, chats } : null;
}
