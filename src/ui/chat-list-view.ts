/**
 * The `exo-chats` sidebar — every AI conversation in one left-hand list: a live
 * tier on top (what is running or waiting on you), time-grouped history below.
 *
 * It is a READER, not an owner. The conversations live in `ChatView`; this pane
 * projects them through `plugin.listChatRows()` and mutates only through the
 * plugin wrappers. Clicking a row reveals the conversation in whatever Exo pane
 * is open — a row click never moves the chat and never spawns one. (The header
 * `+` does spawn one; that is an explicit gesture, not a side effect of
 * browsing.)
 *
 * All tiering, filtering and grouping is decided by `core/chat-rows`, which is
 * pure; this file owns the DOM, the clock read, and the gestures.
 */
import { App, ItemView, Menu, Modal, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type ExoPlugin from "../main";
import { buildChatList, relativeTime, type ChatRow } from "../core/chat-rows";
import type { TimeGroup } from "../core/history";
import { reconcileList, type CardModel } from "./keyed-reconcile";
import { clickable } from "./dom";

export const CHATS_VIEW_TYPE = "exo-chats";
export const CHATS_ICON = "messages-square";

/** How often the list re-derives when nothing emits. Matches the board's
 *  backstop (board-view.ts:162) — it also advances the relative-time labels,
 *  which no event announces. reconcileList diffs by signature, so a tick with
 *  no change touches no DOM. */
const BACKSTOP_MS = 5000;

/** The three empty states, kept distinct on purpose. `open-exo` means the data
 *  exists on disk but no ChatView is mounted to read it — rendering "no chats"
 *  there would be a lie about the user's own history, which is exactly why the
 *  bridge returns `null` instead of `[]`. */
type EmptyKind = "open-exo" | "no-chats" | "no-matches";

/** Live-tier status line. `needs-input` outranks `running` in the model already;
 *  here it only has to say WHICH kind of answer is being waited on. */
const statusText = (r: ChatRow, now: number): string => {
  const age = r.updatedAt ? ` · ${relativeTime(r.updatedAt, now)}` : "";
  if (r.lane === "needs-input") {
    return `Needs input · ${r.reason === "perm" ? "permission" : "answer"}${age}`;
  }
  return `Working${age}`;
};

export class ChatListView extends ItemView {
  private query = "";
  private liveHost: HTMLElement | null = null;
  private groupsHost: HTMLElement | null = null;
  private emptyHost: HTMLElement | null = null;
  private searchEl: HTMLInputElement | null = null;
  /** Which empty state is currently painted, so the 5s backstop doesn't rebuild
   *  it (and steal focus from its button) on every tick. Same reasoning as the
   *  hub's `renderedTab` guard. `null` means the list itself is on screen. */
  private emptyKind: EmptyKind | null = null;
  private convoUnsub: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ExoPlugin) {
    super(leaf);
  }

  getViewType(): string { return CHATS_VIEW_TYPE; }
  getDisplayText(): string { return "Exo chats"; }
  getIcon(): string { return CHATS_ICON; }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("mva-root");
    this.contentEl.addClass("mva-chats");
    this.buildChrome();
    // Freshness is wired BEFORE the first paint, deliberately. A paint that
    // throws while the ChatView is still restoring — which is exactly what a
    // plugin reload produces — must not be able to leave this pane with no
    // subscription and no backstop. Painting first turned one transient failure
    // into a permanently dead view: chrome on screen, zero rows, and nothing
    // ever scheduled to try again. A render may fail and retry; a subscription
    // that was never registered never retries.
    //
    // onConvoState returns a plain Unsubscribe, NOT an Obsidian EventRef, so it
    // cannot go through registerEvent — hold it and release it in onClose.
    this.convoUnsub = this.plugin.onConvoState(() => this.paint());
    this.registerInterval(window.setInterval(() => this.paint(), BACKSTOP_MS));
    // The ChatView may still be restoring when this first paints — one delayed
    // catch-up picks the conversations up without waiting for the backstop.
    // Same reasoning as board-view.ts:166. Registered, not bare: an unmanaged
    // timer fires after onClose and paints into detached DOM. Timer ids are a
    // shared space, so registerInterval clears a setTimeout just as well.
    this.registerInterval(window.setTimeout(() => this.paint(), 800));
    this.paint();
  }

  async onClose(): Promise<void> {
    this.convoUnsub?.();
    this.convoUnsub = null;
  }

  /* ------------------------------- chrome ------------------------------- */

  private buildChrome(): void {
    const root = this.contentEl;
    root.empty();

    const head = root.createDiv({ cls: "mva-chats-head" });
    head.createSpan({ cls: "mva-chats-heading", text: "Chats" });
    const add = head.createEl("button", { cls: "mva-icon-btn", attr: { "aria-label": "New chat" } });
    setIcon(add, "plus");
    add.onclick = () => void this.plugin.newConversation();

    const search = root.createEl("input", {
      cls: "mva-chats-search",
      attr: { type: "search", placeholder: "Search chats" },
    });
    search.addEventListener("input", () => {
      this.query = search.value;
      this.paint();
    });
    this.searchEl = search;

    const body = root.createDiv({ cls: "mva-chats-body" });
    // Three siblings, not one host: `reconcileList` orders by child INDEX, so a
    // group header or an empty-state box sharing a container would occupy an
    // index and shuffle the rows out of the order the model asked for
    // (keyed-reconcile.ts:23-32).
    this.liveHost = body.createDiv({ cls: "mva-chats-live" });
    this.groupsHost = body.createDiv({ cls: "mva-chats-groups" });
    this.emptyHost = body.createDiv({ cls: "mva-chats-empty" });
  }

  /* -------------------------------- paint ------------------------------- */

  private paint(): void {
    if (!this.liveHost) return;
    const sources = this.plugin.listChatRows();
    if (sources === null) return this.renderEmpty("open-exo");
    // One clock read per paint: grouping and the row labels must agree, and two
    // Date.now() calls a few lines apart can straddle a minute boundary.
    const now = Date.now();
    const vm = buildChatList(sources, { query: this.query, now });
    if (vm.total === 0) return this.renderEmpty("no-chats");
    if (vm.matched === 0) return this.renderEmpty("no-matches");
    if (this.emptyKind !== null) {
      this.emptyKind = null;
      this.emptyHost?.empty();
    }
    reconcileList(this.liveHost, vm.live.map((r) => this.rowModel(r, now)));
    this.renderGroups(vm.groups, now);
  }

  /**
   * One reconciled list per time bucket, with the bucket's header as its
   * SIBLING. Sections are keyed by label and reused across paints, so a chat
   * moving from "Today" to "Yesterday" does not reflash the whole history.
   */
  private renderGroups(groups: TimeGroup<ChatRow>[], now: number): void {
    const host = this.groupsHost;
    if (!host) return;
    const wanted = new Set(groups.map((g) => g.label as string));
    for (const el of Array.from(host.children) as HTMLElement[]) {
      if (!wanted.has(el.dataset.group ?? "")) el.remove();
    }
    groups.forEach((g, i) => {
      let sec = Array.from(host.children).find(
        (el) => (el as HTMLElement).dataset.group === g.label,
      ) as HTMLElement | undefined;
      if (!sec) {
        sec = createDiv({ cls: "mva-chats-group" });
        sec.dataset.group = g.label;
        sec.createDiv({ cls: "mva-chats-group-label", text: g.label });
        sec.createDiv({ cls: "mva-chats-group-list" });
      }
      if (host.children[i] !== sec) host.insertBefore(sec, host.children[i] ?? null);
      const list = sec.querySelector<HTMLElement>(".mva-chats-group-list");
      if (list) reconcileList(list, g.items.map((r) => this.rowModel(r, now)));
    });
  }

  private renderEmpty(kind: EmptyKind): void {
    if (this.liveHost) reconcileList(this.liveHost, []);
    this.groupsHost?.empty();
    const host = this.emptyHost;
    if (!host || this.emptyKind === kind) return;
    this.emptyKind = kind;
    host.empty();
    const box = host.createDiv({ cls: "mva-chats-empty-box" });
    if (kind === "open-exo") {
      box.createDiv({ cls: "mva-chats-empty-text", text: "Open Exo to see your chats" });
      const btn = box.createEl("button", { cls: "mva-btn", text: "Open Exo" });
      // Repaint on the promise, not on the next backstop tick: mounting a
      // ChatView emits no convo-state, so without this the pane the user just
      // acted on sits empty for up to BACKSTOP_MS and the button reads as dead.
      btn.onclick = () => void this.plugin.activateView().then(() => this.paint());
      return;
    }
    if (kind === "no-chats") {
      box.createDiv({ cls: "mva-chats-empty-text", text: "No conversations yet" });
      return;
    }
    box.createDiv({ cls: "mva-chats-empty-text", text: "No chats match" });
    const clear = box.createEl("button", { cls: "mva-btn", text: "Clear search" });
    clear.onclick = () => {
      this.query = "";
      if (this.searchEl) this.searchEl.value = "";
      this.paint();
    };
  }

  /* --------------------------------- rows ------------------------------- */

  /** One model builder for both tiers, so `reconcileList` sees a single keyed
   *  identity per conversation even when a row crosses from live to history. */
  private rowModel(r: ChatRow, now: number): CardModel {
    // The rendered AGE LABEL, not the raw `updatedAt`: the label moves as `now`
    // advances while the timestamp sits still, so a raw-ms signature would leave
    // "now" on screen for an hour. It also collapses millisecond churn that
    // changes nothing on screen into a no-op tick. `provider`/`model` are in
    // here because the live tier prints them — a mid-conversation model switch
    // is rendered state like any other.
    const age = r.updatedAt ? relativeTime(r.updatedAt, now) : "";
    return {
      key: r.id,
      sig: [r.title, r.preview, r.lane ?? "", r.reason ?? "", r.badge ?? "", r.provider, r.model, r.open, age].join("|"),
      build: () => (r.lane ? this.buildLiveRow(r, now) : this.buildCompactRow(r, now)),
    };
  }

  /** Live row: status, preview, `provider · model`. Built DETACHED —
   *  `reconcileList` owns insertion and ordering. */
  private buildLiveRow(r: ChatRow, now: number): HTMLElement {
    const row = createDiv({ cls: "mva-chats-row is-live" });
    if (r.lane === "needs-input") row.addClass("is-needs-input");
    if (r.open) row.addClass("is-active");
    row.createDiv({ cls: "mva-chats-status", text: statusText(r, now) });
    // A conversation can be streaming its very first turn, with no assistant
    // text to preview yet; fall back to the title rather than an empty row.
    row.createDiv({ cls: "mva-chats-preview", text: r.preview || r.title });
    row.createDiv({ cls: "mva-chats-meta", text: `${r.provider} · ${r.model}` });
    this.wireRow(row, r);
    return row;
  }

  /** History row: one line — optional badge marker, title, right-aligned age. */
  private buildCompactRow(r: ChatRow, now: number): HTMLElement {
    const row = createDiv({ cls: "mva-chats-row is-compact" });
    if (r.open) row.addClass("is-active");
    if (r.badge) {
      const mark = row.createSpan({ cls: "mva-chats-badge", attr: { "aria-hidden": "true" } });
      setIcon(mark, r.badge === "error" ? "octagon-x" : "circle-stop");
    }
    row.createSpan({ cls: "mva-chats-name", text: r.title });
    row.createSpan({ cls: "mva-chats-age", text: r.updatedAt ? relativeTime(r.updatedAt, now) : "" });
    this.wireRow(row, r);
    return row;
  }

  private wireRow(row: HTMLElement, r: ChatRow): void {
    clickable(row, () => void this.plugin.revealConversation(r.id));
    row.oncontextmenu = (e) => this.rowMenu(e, r);
  }

  /**
   * Rename / Archive / Delete. Delete is two-step: the first click re-opens this
   * menu with the item relabelled "Confirm delete", the second one deletes.
   *
   * Obsidian closes a Menu on any item click, so the gallery's timer-based
   * arm/disarm (gallery-cards.ts:131-164) can't be transplanted as-is; the armed
   * state instead lives in the re-opened menu and dies with it. Dismissing the
   * menu — Escape, a click anywhere else — disarms, which is what the gallery's
   * 3s timer and outside-click listener were buying.
   */
  private rowMenu(e: MouseEvent, r: ChatRow, armed = false): void {
    e.preventDefault();
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("Rename").setIcon("pencil").onClick(() => this.promptRename(r)),
    );
    menu.addItem((i) =>
      i.setTitle("Archive").setIcon("archive").onClick(() => {
        // Three causes reach this false — a streaming turn, no mounted ChatView,
        // an id the store no longer holds — and the row cannot tell them apart,
        // so the message names the state rather than guessing the cause.
        if (!this.plugin.setConvoArchived(r.id, true)) {
          new Notice("Couldn't archive this chat. Open Exo and let any running turn finish.");
          return;
        }
        this.paint();
      }),
    );
    menu.addItem((i) =>
      i
        .setTitle(armed ? "Confirm delete" : "Delete")
        .setIcon("trash-2")
        // The armed item re-opens under the cursor, so a double-click on Delete
        // would land on Confirm without the user ever reading it. The warning
        // styling is what makes the second menu look different from the first.
        .setWarning(armed)
        .onClick(() => {
          if (!armed) {
            window.setTimeout(() => this.rowMenu(e, r, true), 0);
            return;
          }
          // The only destructive action here, and the only one that can no-op:
          // an unknown id returns false. Say so rather than repainting an
          // unchanged row and letting it read as a dead click.
          if (!this.plugin.deleteConversation(r.id)) {
            new Notice("Couldn't delete this chat — it is no longer in the store.");
            return;
          }
          this.paint();
        }),
    );
    menu.showAtMouseEvent(e);
  }

  private promptRename(r: ChatRow): void {
    new RenameChatModal(this.app, r.title, (title) => {
      // The mutation rejects a blank title and an unknown id (core/title-ownership
      // applyRename) — both surface here, because neither is visible from the row.
      if (!this.plugin.renameConversation(r.id, title)) {
        new Notice("Couldn't rename this chat. The title can't be empty, and Exo has to be open.");
        return;
      }
      this.paint();
    }).open();
  }
}

/** Prefilled single-field rename. Enter submits; Escape (Modal's own scope)
 *  cancels without touching the conversation. */
class RenameChatModal extends Modal {
  constructor(
    app: App,
    private readonly current: string,
    private readonly onSubmit: (title: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Rename chat");
    const input = this.contentEl.createEl("input", {
      cls: "mva-chats-rename-input",
      attr: { type: "text", placeholder: "Chat title" },
    });
    input.value = this.current;
    input.focus();
    input.select();
    const actions = this.contentEl.createDiv({ cls: "mva-chats-rename-actions" });
    const save = actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Rename" });
    const submit = () => {
      this.onSubmit(input.value);
      this.close();
    };
    save.onclick = submit;
    input.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      submit();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
