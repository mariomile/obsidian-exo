/**
 * Mutations the chats sidebar performs on conversations, as free functions over
 * a `ChatView`. They live here rather than on the class for the same reason
 * `gallery-cards.ts` does: `view.ts` is at its size ceiling, and a sidebar
 * action is not chat-transcript behaviour.
 *
 * Titles are the reason most of this exists. A conversation's title is set once
 * from a 40-character slice of the first user message, and refined by a
 * generated one — but only twice, and only while a turn is landing. A chat that
 * missed both windows has no path back to a good title, which is how a history
 * list ends up two thirds unreadable. These give it one.
 */
import { Notice } from "obsidian";
import type { ChatView } from "../view";
import type ExoPlugin from "../main";
import type { Convo } from "./convo-types";
import { looksAutoTitled } from "../core/title-ownership";

/** Same active fallback the other convo mutations use — the active conversation
 *  is not always in `convos` (several paths push it lazily). */
function find(view: ChatView, id: string): Convo | undefined {
  return view.allConvos().find((c) => c.id === id);
}

/**
 * Pin or unpin. Pinning is what the tab strip already means by `pinned`, so the
 * sidebar deliberately toggles the same flag rather than inventing a parallel
 * one: a chat pinned from either surface is pinned in both.
 */
export function setConvoPinned(view: ChatView, id: string, pinned: boolean): boolean {
  const c = find(view, id);
  if (!c) return false;
  if (c.pinned !== pinned) view.togglePin(c);
  return true;
}

/** The last complete exchange, in the shape `generateTitle` wants. Returns null
 *  when the conversation has no assistant reply yet — there is nothing to title
 *  from, and asking a model to name a monologue produces a paraphrase. */
function lastExchange(c: Convo): { userText: string; assistantText: string } | null {
  const msgs = c.messages;
  let assistantText = "";
  let i = msgs.length - 1;
  for (; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "assistant") continue;
    assistantText = (m.segments ?? [])
      .filter((s) => s.t === "text")
      .map((s) => s.md ?? "")
      .join(" ")
      .trim();
    if (assistantText) break;
  }
  if (!assistantText) return null;
  for (let j = i - 1; j >= 0; j--) {
    const m = msgs[j];
    if (m.role === "user" && (m.text ?? "").trim()) {
      return { userText: (m.text ?? "").trim(), assistantText };
    }
  }
  return null;
}

/**
 * Regenerate one conversation's title from its last exchange. Does NOT set
 * `titleLocked`: the user asked for a better generated title, not to take
 * ownership of it, so a later automatic refinement is still allowed. Sets
 * `aiTitleApplied` so the turn-driven path does not immediately spend an
 * attempt redoing what just happened.
 */
export async function retitleConversation(
  view: ChatView,
  plugin: ExoPlugin,
  id: string,
): Promise<boolean> {
  const c = find(view, id);
  if (!c) return false;
  const ex = lastExchange(c);
  if (!ex) return false;
  const ctrl = new AbortController();
  c.titleAbort?.abort();
  c.titleAbort = ctrl;
  const title = await plugin.generateTitle(ex.userText, ex.assistantText, ctrl.signal);
  if (!title || ctrl.signal.aborted) return false;
  // Re-find: the conversation can be deleted while a 90s cold spawn is in
  // flight, and writing to a detached object would silently lose the title.
  const still = find(view, id);
  if (!still) return false;
  still.title = title;
  still.aiTitleApplied = true;
  view.renderTabs();
  view.persist();
  return true;
}

/** Conversations a sweep should touch: still auto-titled, not user-owned, and
 *  with an exchange to title from. */
export function retitleCandidates(view: ChatView): Convo[] {
  return view
    .allConvos()
    .filter((c) => !c.titleLocked && looksAutoTitled(c.title) && lastExchange(c) !== null);
}

/**
 * Retitle every candidate, one at a time. Sequential on purpose: each call cold
 * spawns a CLI session, which is the dominant cost, and running twenty in
 * parallel would contend for the same machine rather than finish sooner.
 * Reports progress through a single Notice that is rewritten in place.
 */
export async function backfillTitles(view: ChatView, plugin: ExoPlugin): Promise<void> {
  const targets = retitleCandidates(view);
  if (targets.length === 0) {
    new Notice("Every chat already has a real title.");
    return;
  }
  const notice = new Notice(`Retitling 0/${targets.length}…`, 0);
  let done = 0;
  let failed = 0;
  for (const [i, c] of targets.entries()) {
    notice.setMessage(`Retitling ${i + 1}/${targets.length}…`);
    // One failure is a slow cold spawn, not a reason to abandon the rest.
    if (await retitleConversation(view, plugin, c.id)) done++;
    else failed++;
  }
  notice.hide();
  new Notice(
    failed === 0
      ? `Retitled ${done} chat${done === 1 ? "" : "s"}.`
      : `Retitled ${done}, ${failed} failed. Run it again to retry those.`,
  );
}
