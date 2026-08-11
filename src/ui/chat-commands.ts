/**
 * The chats sidebar's palette commands, in one place — the same arrangement
 * `ui/view-registry.ts` gives the panes, and for the same reason: `main.ts` is
 * at its size ceiling and its next declared extraction is exactly this block,
 * so a new command lands here rather than growing the lifecycle file.
 *
 * The two ids that moved (`open-chat-list`, `retitle-chats`) are unchanged:
 * Obsidian stores hotkeys BY ID, so renaming one would silently drop whatever
 * the user had bound to it.
 */
import { Notice } from "obsidian";
import type ExoPlugin from "../main";
import { buildChatList, nextNeedsInput } from "../core/chat-rows";

export function registerChatCommands(plugin: ExoPlugin): void {
  plugin.addCommand({
    id: "open-chat-list",
    name: "Open Exo chats",
    callback: () => void plugin.activateChats(),
  });
  plugin.addCommand({
    id: "retitle-chats",
    name: "Retitle auto-named chats",
    callback: () => void plugin.backfillTitles(),
  });
  // The idle-worker key: one press moves to the next conversation that cannot
  // continue without you. No default hotkey, like every other command this
  // plugin registers — it binds what the user chooses, never what we assumed.
  plugin.addCommand({
    id: "next-needs-you",
    name: "Go to the next chat that needs you",
    callback: () => goToNextNeedsYou(plugin),
  });
}

/**
 * Cycle to the next blocked conversation, wrapping. The queue is the sidebar's
 * own needs-you strip — `buildChatList().blocked`, unfiltered and unsectioned —
 * so the key and the strip can never disagree about what is waiting.
 *
 * Says so out loud when nothing is waiting: a command that silently does
 * nothing is indistinguishable from one that is broken.
 */
function goToNextNeedsYou(plugin: ExoPlugin): void {
  const sources = plugin.listChatRows();
  // No ChatView mounted — there is no conversation to go to yet, so open Exo
  // rather than reporting an empty queue that only looks empty.
  if (!sources) {
    void plugin.activateView();
    return;
  }
  const { blocked } = buildChatList(sources, { query: "", now: Date.now() });
  const next = nextNeedsInput(blocked, plugin.activeConvoId());
  if (!next) {
    new Notice("Exo — nothing is waiting on you.");
    return;
  }
  void plugin.revealConversation(next);
}
