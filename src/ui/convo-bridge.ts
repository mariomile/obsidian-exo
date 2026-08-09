import { Notice, type App } from "obsidian";
import { ChatView, VIEW_TYPE } from "../view";
import type ExoPlugin from "../main";
import type { ChatRowSource } from "../core/chat-rows";
import * as actions from "./chat-actions";

/** The mounted ChatView, or null when none is — including when the leaf exists
 *  but is still a deferred placeholder, on which `instanceof` is false. */
export function chatView(app: App): ChatView | null {
  const view = app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
  return view instanceof ChatView ? view : null;
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
