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
import { buildChatList, relativeTime, modelLabel, type ChatRow } from "../core/chat-rows";
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

/** Status chip for a running or blocked row. The age already sits on the title
 *  line, so this only has to say WHICH kind of answer is being waited on —
 *  `needs-input` already outranks `running` in the model. */
const statusText = (r: ChatRow): string =>
  r.lane === "needs-input" ? `Needs ${r.reason === "perm" ? "permission" : "an answer"}` : "Working";

export class ChatListView extends ItemView {
  private query = "";
  private listHost: HTMLElement | null = null;
  private emptyHost: HTMLElement | null = null;
  private searchEl: HTMLInputElement | null = null;
  /** Which empty state is currently painted, so the 5s backstop doesn't rebuild
   *  it (and steal focus from its button) on every tick. Same reasoning as the
   *  hub's `renderedTab` guard. `null` means the list itself is on screen. */
  private emptyKind: EmptyKind | null = null;
  private convoUnsub: (() => void) | null = null;
  /** Visible row ids, in painted order — the axis the arrow keys move along.
   *  Recomputed every paint so the cursor can never point at a row that was
   *  filtered out or archived since the last keystroke. */
  private order: string[] = [];
  /** Keyboard cursor. Applied as a class after reconciliation rather than
   *  carried in the row signature: putting it in the signature would rebuild two
   *  rows on every arrow press, which drops focus and defeats the point. */
  private cursor: string | null = null;

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
      // A new filter invalidates the old cursor position; re-anchor to the top
      // so Enter after typing opens the best match, not a stale row.
      this.cursor = null;
      this.paint();
    });
    search.addEventListener("keydown", (e) => this.onKey(e));
    this.searchEl = search;

    const body = root.createDiv({ cls: "mva-chats-body" });
    // Two siblings, not one host: `reconcileList` orders by child INDEX, so a
    // section header or an empty-state box sharing a container would occupy an
    // index and shuffle the rows out of the order the model asked for
    // (keyed-reconcile.ts:23-32). `listHost` holds only sections, each of which
    // holds a header plus its own reconciled list — so no reconciled container
    // ever contains anything but rows.
    this.listHost = body.createDiv({ cls: "mva-chats-sections" });
    this.emptyHost = body.createDiv({ cls: "mva-chats-empty" });
    // tabindex so the list itself can hold focus and answer arrow keys after a
    // click, without stealing them from the search field when that has focus.
    body.tabIndex = 0;
    body.addEventListener("keydown", (e) => this.onKey(e));
  }

  /* -------------------------------- paint ------------------------------- */

  private paint(): void {
    if (!this.listHost) return;
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
    // Two densities, one section mechanism. The working set and the pins render
    // rich because they are the rows you choose between; history renders compact
    // because it is a list you scan. Empty sections are dropped rather than
    // shown empty — a header with nothing under it is a promise of content.
    this.renderSections(
      [
        { key: "active", label: "Active", rich: true, items: vm.active },
        { key: "pinned", label: "Pinned", rich: true, items: vm.pinned },
        ...vm.groups.map((g) => ({ key: `t:${g.label}`, label: g.label, rich: false, items: g.items })),
      ].filter((s) => s.items.length > 0),
      now,
    );
    this.order = [...vm.active, ...vm.pinned, ...vm.groups.flatMap((g) => g.items)].map((r) => r.id);
    if (this.cursor && !this.order.includes(this.cursor)) this.cursor = null;
    this.paintCursor(false);
  }

  /* ------------------------------ keyboard ------------------------------ */

  /**
   * Move the cursor along the painted order. `delta` of 0 just re-anchors,
   * which is what a fresh arrow press after a filter change should do. Wraps at
   * neither end on purpose: in a list this long, wrapping from the oldest chat
   * back to the newest reads as a glitch rather than a convenience.
   */
  private moveCursor(delta: number): void {
    if (this.order.length === 0) return;
    const at = this.cursor ? this.order.indexOf(this.cursor) : -1;
    const next = at === -1 ? (delta < 0 ? this.order.length - 1 : 0) : at + delta;
    if (next < 0 || next >= this.order.length) return;
    this.cursor = this.order[next];
    this.paintCursor(true);
  }

  private paintCursor(scroll: boolean): void {
    const host = this.listHost;
    if (!host) return;
    host.querySelectorAll<HTMLElement>(".mva-chats-row.is-cursor").forEach((el) => el.removeClass("is-cursor"));
    if (!this.cursor) return;
    const el = host.querySelector<HTMLElement>(`.mva-chats-row[data-id="${CSS.escape(this.cursor)}"]`);
    if (!el) return;
    el.addClass("is-cursor");
    if (scroll) el.scrollIntoView({ block: "nearest" });
  }

  /** Arrow keys traverse, Enter opens, Escape clears the filter then the focus.
   *  Bound on the search field AND the list, so the gesture works whether you
   *  arrived by typing or by clicking into the pane. */
  private onKey(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") { e.preventDefault(); this.moveCursor(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); this.moveCursor(-1); return; }
    if (e.key === "Enter" && this.cursor) {
      e.preventDefault();
      void this.plugin.revealConversation(this.cursor);
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    // Two-step: the first Escape clears a filter you can see, the second gives
    // the pane back. Clearing and blurring at once loses the filtered list
    // before you have read it.
    if (this.query) {
      this.query = "";
      if (this.searchEl) this.searchEl.value = "";
      this.paint();
      return;
    }
    this.searchEl?.blur();
  }

  /**
   * One reconciled list per section, with the section's header as its SIBLING.
   * Sections are keyed and reused across paints, so a chat moving from Active to
   * Yesterday does not reflash the whole list.
   */
  private renderSections(
    specs: Array<{ key: string; label: string; rich: boolean; items: ChatRow[] }>,
    now: number,
  ): void {
    const host = this.listHost;
    if (!host) return;
    const wanted = new Set(specs.map((s) => s.key));
    // A static snapshot: removing from a live HTMLCollection mid-iteration skips
    // siblings.
    for (const el of Array.from(host.children) as HTMLElement[]) {
      if (!wanted.has(el.dataset.section ?? "")) el.remove();
    }
    specs.forEach((spec, i) => {
      let sec = Array.from(host.children).find(
        (el) => (el as HTMLElement).dataset.section === spec.key,
      ) as HTMLElement | undefined;
      if (!sec) {
        sec = createDiv({ cls: "mva-chats-group" });
        sec.dataset.section = spec.key;
        sec.createDiv({ cls: "mva-chats-group-label", text: spec.label });
        sec.createDiv({ cls: "mva-chats-group-list" });
      }
      // Reading host.children live is correct here: after iteration i-1 the
      // first i slots already hold the first i sections, so a match can only sit
      // at an index >= i and insertBefore always moves it forward.
      if (host.children[i] !== sec) host.insertBefore(sec, host.children[i] ?? null);
      const list = sec.querySelector<HTMLElement>(".mva-chats-group-list");
      if (list) reconcileList(list, spec.items.map((r) => this.rowModel(r, spec.rich, now)));
    });
  }

  private renderEmpty(kind: EmptyKind): void {
    this.listHost?.empty();
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

  /** One model builder for both densities, so `reconcileList` sees a single
   *  keyed identity per conversation even when a row crosses a section. */
  private rowModel(r: ChatRow, rich: boolean, now: number): CardModel {
    // The rendered AGE LABEL, not the raw `updatedAt`: the label moves as `now`
    // advances while the timestamp sits still, so a raw-ms signature would leave
    // "now" on screen for an hour. It also collapses millisecond churn that
    // changes nothing on screen into a no-op tick. `rich` is part of the
    // identity too — the same conversation is a different element in the
    // working set than in history, so crossing that line rebuilds rather than
    // patches.
    const age = r.updatedAt ? relativeTime(r.updatedAt, now) : "";
    return {
      key: r.id,
      sig: [
        rich, r.title, r.preview, r.lane ?? "", r.reason ?? "", r.badge ?? "",
        r.provider, r.model, r.messageCount, r.open, r.pinned, r.unseen, age,
      ].join("|"),
      build: () => (rich ? this.buildRichRow(r, now) : this.buildCompactRow(r, now)),
    };
  }

  /**
   * Rich row — title and age, the last exchange, then a metadata line: status
   * when something is happening, otherwise provider, model and how many turns
   * are yours. Three lines is the budget. The model earns its place because
   * choosing between an Opus chat and a Sonnet one is a real decision, and the
   * title alone never tells you which is which. Built DETACHED —
   * `reconcileList` owns insertion and ordering.
   */
  private buildRichRow(r: ChatRow, now: number): HTMLElement {
    const row = createDiv({ cls: "mva-chats-row is-rich" });
    if (r.lane === "needs-input") row.addClass("is-needs-input");
    else if (r.lane === "running") row.addClass("is-running");
    if (r.open) row.addClass("is-active");
    if (r.unseen) row.addClass("is-unseen");

    const head = row.createDiv({ cls: "mva-chats-line" });
    if (r.pinned) setIcon(head.createSpan({ cls: "mva-chats-pin", attr: { "aria-label": "Pinned" } }), "pin");
    head.createSpan({ cls: "mva-chats-name", text: r.title });
    head.createSpan({ cls: "mva-chats-age", text: r.updatedAt ? relativeTime(r.updatedAt, now) : "" });

    // A conversation can be streaming its very first turn with no assistant text
    // to preview yet; omit the line rather than repeating the title under it.
    if (r.preview) row.createDiv({ cls: "mva-chats-preview", text: r.preview });

    const meta = row.createDiv({ cls: "mva-chats-meta" });
    if (r.lane) meta.createSpan({ cls: "mva-chats-status", text: statusText(r) });
    else if (r.unseen) meta.createSpan({ cls: "mva-chats-status is-unseen", text: "New reply" });
    meta.createSpan({ text: modelLabel(r.provider, r.model) });
    meta.createSpan({ cls: "mva-chats-count", text: `${r.messageCount}` });
    this.badgeInto(meta, r);
    row.dataset.id = r.id;
    this.wireRow(row, r);
    return row;
  }

  /** The stopped/error marker, shared by both densities so a failed turn is
   *  never visible in one section and invisible in the other. */
  private badgeInto(host: HTMLElement, r: ChatRow): void {
    if (!r.badge) return;
    const mark = host.createSpan({
      cls: `mva-chats-badge is-${r.badge}`,
      attr: { "aria-label": r.badge === "error" ? "Last turn errored" : "Stopped" },
    });
    setIcon(mark, r.badge === "error" ? "octagon-x" : "circle-stop");
  }

  /** History row: one line — optional markers, title, right-aligned age. */
  private buildCompactRow(r: ChatRow, now: number): HTMLElement {
    const row = createDiv({ cls: "mva-chats-row is-compact" });
    if (r.open) row.addClass("is-active");
    if (r.unseen) row.addClass("is-unseen");
    if (r.pinned) setIcon(row.createSpan({ cls: "mva-chats-pin", attr: { "aria-label": "Pinned" } }), "pin");
    this.badgeInto(row, r);
    row.createSpan({ cls: "mva-chats-name", text: r.title });
    row.createSpan({ cls: "mva-chats-age", text: r.updatedAt ? relativeTime(r.updatedAt, now) : "" });
    row.dataset.id = r.id;
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
      i.setTitle("Retitle with AI").setIcon("sparkles").onClick(() => {
        // Cold-spawning a CLI session takes seconds, so say something first —
        // an item that appears to do nothing for ten seconds reads as broken.
        const pending = new Notice("Retitling…", 0);
        void this.plugin
          .retitleConversation(r.id)
          .then((ok) => {
            pending.hide();
            if (!ok) new Notice("Couldn't retitle — this chat has no complete exchange yet.");
            this.paint();
          })
          .catch(() => {
            pending.hide();
            new Notice("Retitling failed.");
          });
      }),
    );
    menu.addItem((i) =>
      i
        .setTitle(r.pinned ? "Unpin" : "Pin")
        .setIcon(r.pinned ? "pin-off" : "pin")
        .onClick(() => {
          this.plugin.setConvoPinned(r.id, !r.pinned);
          this.paint();
        }),
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
