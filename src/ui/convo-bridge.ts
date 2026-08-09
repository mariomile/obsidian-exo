import { Notice, type App } from "obsidian";
import { ChatView, VIEW_TYPE } from "../view";
import type ExoPlugin from "../main";
import type { ChatRowSource } from "../core/chat-rows";
import * as actions from "./chat-actions";

/** The mounted ChatView, or null when none is — including when the leaf exists
 *  but is still a deferred placeholder, on which `instanceof` is false. */
export function chatView(app: App): ChatView | null {
  const leaf = app.workspace.getLeavesOfType(VIEW_TYPE)[0];
  if (!leaf) return null;
  if (leaf.view instanceof ChatView) return leaf.view;
  // The leaf exists but Obsidian has not materialised it yet (a restored tab
  // that was never activated, or any tab right after a plugin reload). Ask for
  // it and report null for now: the caller's next tick finds it. Without this
  // the chats sidebar sits on "Open Exo to see your chats" while a fully
  // populated conversation store is one deferred view away.
  (leaf as unknown as { loadIfDeferred?: () => Promise<void> }).loadIfDeferred?.();
  return null;
}

/**
 * Every conversation, for the chats sidebar. Returns `null` — not `[]` — when
 * no ChatView is mounted. An empty array would render "no conversations", which
 * is a lie about data that exists; `null` lets the sidebar say "open Exo".
 */
export function listChatRows(app: App): ChatRowSource[] | null {
  return chatView(app)?.listChatRows() ?? null;
}

export function renameConversation(app: App, convoId: string, title: string): boolean {
  return chatView(app)?.renameConversation(convoId, title) ?? false;
}

export function deleteConversation(app: App, convoId: string): boolean {
  return chatView(app)?.deleteConversation(convoId) ?? false;
}

export function setConvoPinned(app: App, convoId: string, pinned: boolean): boolean {
  const view = chatView(app);
  return view ? actions.setConvoPinned(view, convoId, pinned) : false;
}

export async function retitleConversation(plugin: ExoPlugin, convoId: string): Promise<boolean> {
  const view = chatView(plugin.app);
  return view ? actions.retitleConversation(view, plugin, convoId) : false;
}

/** Sweep every still-auto-titled conversation. Surfaces its own progress and
 *  outcome through Notices, so callers do not need a result. */
export async function backfillTitles(plugin: ExoPlugin): Promise<void> {
  const view = chatView(plugin.app);
  if (!view) {
    new Notice("Open Exo first — retitling reads the conversation store.");
    return;
  }
  await actions.backfillTitles(view, plugin);
}
