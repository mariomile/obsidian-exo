import type { App } from "obsidian";
import { ChatView, VIEW_TYPE } from "../view";
import type { ChatRowSource } from "../core/chat-rows";

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
