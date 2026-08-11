/**
 * The `exo-chats` sidebar — every AI conversation in one left-hand list,
 * grouped by state (what needs you, what is running, what you have open) or,
 * in `days` mode, by the day it was last touched.
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
import {
  buildChatList,
  relativeTime,
  modelLabel,
  type ChatRow,
  type ChatSection,
  type ChatListMode,
} from "../core/chat-rows";
import type { ChatSectionKey } from "../core/chat-rows";
import {
  chatDot,
  collapseChildren,
  isParentCollapsed,
  isSectionCollapsed,
  toggleParentCollapsed,
  toggleSectionCollapsed,
  type ChatDot,
  type ChildCollapse,
} from "../core/chat-list-state";
import { reconcileList, type CardModel } from "./keyed-reconcile";
import { clickable } from "./dom";
import { recallChats, reindexChats, recallHost, isRecallUnavailable } from "./chat-recall";

export const CHATS_VIEW_TYPE = "exo-chats";
export const CHATS_ICON = "messages-square";

/** Per-pane prefix for the header/list id pairs that wire `aria-controls` and
 *  `aria-labelledby`. Obsidian allows the same view type in two leaves, and two
 *  panes minting the same ids would point every header at the first pane's
 *  lists — a screen reader would then announce the wrong section. */
let paneSeq = 0;

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

/** What the gutter dot says out loud. Shape and colour are the visual channel;
 *  a screen reader gets neither, so the meaning is spelled out. */
const DOT_LABEL: Record<ChatDot, string> = {
  running: "Running",
  "needs-you": "Needs you",
  unseen: "Unseen reply",
};

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
  /** Ids from the last semantic pass, and the query they answered. Both are
   *  kept so a stale result can be recognised and dropped: the pass is ~0.8s
   *  and the user keeps typing, so answers routinely arrive for a query that is
   *  no longer on screen. */
  private semanticIds: string[] = [];
  private semanticFor = "";
  private semanticTimer: number | null = null;
  /** Keyboard cursor. Applied as a class after reconciliation rather than
   *  carried in the row signature: putting it in the signature would rebuild two
   *  rows on every arrow press, which drops focus and defeats the point. */
  private cursor: string | null = null;
  /** Namespace for this pane's aria ids — see `paneSeq`. */
  private readonly uid = `exo-chats-${++paneSeq}`;

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
    // Bring the semantic index up to date in the background. Incremental and
    // pipeline-free when nothing changed, so opening the pane costs ~50ms; the
    // expensive case is a first build, which is exactly when you want it to
    // happen unattended rather than on the first search.
    void reindexChats(recallHost(this.pluginDir()));
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
    const sort = head.createEl("button", { cls: "mva-icon-btn", attr: { "aria-label": "Grouping" } });
    setIcon(sort, "arrow-down-narrow-wide");
    sort.onclick = (e) => this.groupingMenu(e);
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
      this.scheduleSemantic();
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

  /**
   * Grouping picker. A menu with both options checked/unchecked rather than a
   * button that flips: the two readings are peers, and a toggle would force you
   * to click it to find out which one you are in.
   */
  private groupingMenu(e: MouseEvent): void {
    const menu = new Menu();
    const pick = (mode: ChatListMode, title: string, icon: string) =>
      menu.addItem((i) =>
        i
          .setTitle(title)
          .setIcon(icon)
          .setChecked(this.mode() === mode)
          .onClick(() => {
            this.plugin.settings.chatsMode = mode;
            void this.plugin.saveSettings();
            // The cursor indexes into the painted order, which is about to be a
            // different order entirely.
            this.cursor = null;
            this.paint();
          }),
      );
    pick("activity", "Group by activity", "layers");
    pick("days", "Group by day", "calendar-days");
    menu.showAtMouseEvent(e);
  }

  private mode(): ChatListMode {
    return this.plugin.settings.chatsMode === "days" ? "days" : "activity";
  }

  /* ------------------------------ semantic ------------------------------ */

  /**
   * Run the semantic pass once the typing stops. Debounced, not per keystroke:
   * a query costs ~0.8s and spawning one per character would queue a dozen
   * processes to answer questions the user has already moved past.
   */
  private scheduleSemantic(): void {
    if (this.semanticTimer !== null) window.clearTimeout(this.semanticTimer);
    const q = this.query.trim();
    // Clearing the box must clear the Related section immediately — leaving it
    // would show results for a search that is no longer on screen.
    if (!q) {
      this.semanticIds = [];
      this.semanticFor = "";
      return;
    }
    if (isRecallUnavailable()) return;
    this.semanticTimer = window.setTimeout(() => {
      void recallChats(recallHost(this.pluginDir()), q).then((ids) => {
        // `null` means the pass could not run; keep whatever was already there
        // rather than blanking a good section on a transient failure.
        if (ids === null) return;
        // The answer is only valid for the query it was asked about.
        if (this.query.trim() !== q) return;
        this.semanticIds = ids;
        this.semanticFor = q;
        this.paint();
      });
    }, 350);
  }

  private pluginDir(): string {
    const base = this.app.vault.adapter as unknown as { basePath?: string };
    return `${base.basePath ?? ""}/${this.plugin.manifest.dir ?? ""}`;
  }

  /* -------------------------------- paint ------------------------------- */

  private paint(): void {
    if (!this.listHost) return;
    const sources = this.plugin.listChatRows();
    if (sources === null) return this.renderEmpty("open-exo");
    // One clock read per paint: grouping and the row labels must agree, and two
    // Date.now() calls a few lines apart can straddle a minute boundary.
    const now = Date.now();
    const vm = buildChatList(sources, {
      query: this.query,
      now,
      mode: this.mode(),
      // Only feed the ranking back in if it answered the query on screen.
      semanticIds: this.semanticFor === this.query.trim() ? this.semanticIds : [],
    });
    if (vm.total === 0) return this.renderEmpty("no-chats");
    if (vm.matched === 0) return this.renderEmpty("no-matches");
    if (this.emptyKind !== null) {
      this.emptyKind = null;
      this.emptyHost?.empty();
    }
    // Density is decided PER ROW, not per section: anything running, open or
    // pinned is something you are choosing between and earns the metadata line,
    // wherever it happens to sit. That is what keeps the day view useful — the
    // grouping changes, the information does not. The model already ordered the
    // sections and dropped the empty ones, and it owns the section KEYS: a key
    // has to survive a label being reworded, so this file never derives one
    // from display text.
    // Resolved ONCE, over every section at a time: the renderer and the
    // arrow-key axis have to agree about which rows are on screen, and two
    // passes over the same rule is how they stop agreeing.
    const kids = collapseChildren(
      vm.sections.flatMap((s) => s.items),
      this.plugin.settings.chatsCollapsedParents,
    );
    this.renderSections(vm.sections, now, kids);
    // Only what is on screen is on the arrow-key axis: a collapsed section's
    // rows are not painted and a collapsed parent's children are hidden, so
    // leaving either in the order would make Down walk the cursor into nothing
    // and Enter open a chat the user cannot see.
    this.order = vm.sections
      .filter((s) => !this.collapsed(s.key))
      .flatMap((s) => s.items)
      .filter((r) => !kids.hidden.has(r.id))
      .map((r) => r.id);
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

  /* ------------------------------ sections ------------------------------ */

  private collapsed(key: ChatSectionKey): boolean {
    return isSectionCollapsed(this.plugin.settings.chatsCollapsed, key);
  }

  /** Flip one section and persist it. The whole point of the state is that it
   *  survives a reload, so the write happens on the gesture rather than on some
   *  later save — a crash between the two would silently discard the choice. */
  private toggleSection(key: ChatSectionKey): void {
    this.plugin.settings.chatsCollapsed = toggleSectionCollapsed(
      this.plugin.settings.chatsCollapsed,
      key,
    );
    void this.plugin.saveSettings();
    // The cursor may have been sitting on a row that just went off screen;
    // `paint` re-derives the order and drops it if so.
    this.paint();
  }

  private parentCollapsed(convoId: string): boolean {
    return isParentCollapsed(this.plugin.settings.chatsCollapsedParents, convoId);
  }

  /** Fold one conversation's fan-out away, or bring it back. A second, fully
   *  independent axis: it writes its own list, so a parent stays folded through
   *  a section being collapsed and reopened, and vice versa. */
  private toggleParent(convoId: string): void {
    this.plugin.settings.chatsCollapsedParents = toggleParentCollapsed(
      this.plugin.settings.chatsCollapsedParents,
      convoId,
    );
    void this.plugin.saveSettings();
    this.paint();
  }

  /**
   * One reconciled list per section, with the section's header as its SIBLING.
   * Sections are keyed by `ChatSectionKey` and reused across paints, so a chat
   * moving from Running to Settled does not reflash the whole list.
   *
   * Collapsing is a STATE on the reused section, never a rebuild: the header,
   * its handler and its aria wiring are built once and only the class, the
   * count and `aria-expanded` change. A collapsed section reconciles to an empty
   * list rather than hiding a full one — the rows would otherwise stay in the
   * accessibility tree, and building rows nobody can see costs a paint on every
   * 5s tick for a section the user explicitly put away.
   */
  private renderSections(
    specs: readonly ChatSection[],
    now: number,
    kids: ChildCollapse,
  ): void {
    const host = this.listHost;
    if (!host) return;
    const wanted = new Set<string>(specs.map((s) => s.key));
    // A static snapshot: removing from a live HTMLCollection mid-iteration skips
    // siblings.
    for (const el of Array.from(host.children) as HTMLElement[]) {
      if (!wanted.has(el.dataset.section ?? "")) el.remove();
    }
    specs.forEach((spec, i) => {
      let sec = Array.from(host.children).find(
        (el) => (el as HTMLElement).dataset.section === spec.key,
      ) as HTMLElement | undefined;
      if (!sec) sec = this.buildSection(spec);
      // Reading host.children live is correct here: after iteration i-1 the
      // first i slots already hold the first i sections, so a match can only sit
      // at an index >= i and insertBefore always moves it forward.
      if (host.children[i] !== sec) host.insertBefore(sec, host.children[i] ?? null);
      const collapsed = this.collapsed(spec.key);
      sec.toggleClass("is-collapsed", collapsed);
      const header = sec.querySelector<HTMLElement>(".mva-chats-group-label");
      header?.setAttribute("aria-expanded", String(!collapsed));
      // The count exists ONLY while collapsed, and that is what makes collapsing
      // safe: a header that hides its rows without saying how many it is hiding
      // turns "put this away" into "forget this exists". Expanded, the rows are
      // right there and the number would be noise.
      sec
        .querySelector<HTMLElement>(".mva-chats-group-count")
        ?.setText(collapsed ? String(spec.items.length) : "");
      const list = sec.querySelector<HTMLElement>(".mva-chats-group-list");
      if (!list) return;
      reconcileList(list, collapsed ? [] : spec.items.map((r) => this.rowModel(r, now)));
      if (!collapsed) this.applyChildCollapse(list, spec.items, kids);
    });
  }

  /**
   * The section shell: a header that toggles, and the list it controls. Built
   * once per key and reused, so the click handler is registered once — a header
   * rebuilt on every paint would drop keyboard focus mid-interaction.
   *
   * The header is a `div` made operable by `clickable` (role=button, tabIndex,
   * Enter/Space), not a `<button>`: on a real button, Obsidian's own
   * `button:not(.clickable-icon)` rule out-specifies a single-class selector and
   * strips the padding and background out from under it.
   */
  private buildSection(spec: ChatSection): HTMLElement {
    const sec = createDiv({ cls: "mva-chats-group" });
    sec.dataset.section = spec.key;
    // `day:This week` is a legal section key and an ILLEGAL id: `aria-controls`
    // and `aria-labelledby` are space-separated id LISTS, so a key with a space
    // in it would resolve to two ids that do not exist and silently unwire the
    // whole relationship. Slugged, not indexed by paint order — the id has to
    // survive a section being dropped and re-added.
    const slug = spec.key.replace(/[^a-zA-Z0-9]+/g, "-");
    const headerId = `${this.uid}-h-${slug}`;
    const listId = `${this.uid}-l-${slug}`;
    const header = sec.createDiv({ cls: "mva-chats-group-label", attr: { id: headerId } });
    // A rotation, not two icons: swapping chevron-right for chevron-down would
    // re-run setIcon on every toggle and lose the transition that makes the
    // gesture legible.
    setIcon(header.createSpan({ cls: "mva-chats-group-chevron" }), "chevron-right");
    header.createSpan({ cls: "mva-chats-group-name", text: spec.label });
    header.createSpan({ cls: "mva-chats-group-count" });
    header.setAttribute("aria-controls", listId);
    clickable(header, () => this.toggleSection(spec.key));
    const list = sec.createDiv({ cls: "mva-chats-group-list", attr: { id: listId } });
    list.setAttribute("role", "region");
    list.setAttribute("aria-labelledby", headerId);
    return sec;
  }

  /**
   * Per-parent collapse, applied to the rows `reconcileList` just settled.
   *
   * A CLASS on the element that is already there, never a rebuild and never a
   * shorter model list: the whole gesture is meant to feel instant in both
   * directions, and re-deriving the list would make expanding pay for a rebuild
   * of rows that never left the DOM. Same reason the collapsed flag stays OUT
   * of the row signature — a rebuild here would drop focus mid-keystroke, on
   * exactly the control the user just pressed Enter on.
   *
   * Indexed rather than queried: after reconciliation `list.children` is
   * `spec.items` in order, by construction, so this needs no second lookup.
   */
  private applyChildCollapse(
    list: HTMLElement,
    items: readonly ChatRow[],
    kids: ChildCollapse,
  ): void {
    const els = Array.from(list.children) as HTMLElement[];
    items.forEach((r, i) => {
      const el = els[i];
      if (!el) return;
      if (r.depth === 1) {
        el.toggleClass("is-kid-hidden", kids.hidden.has(r.id));
        return;
      }
      if (!r.hasChildren) return;
      const collapsed = this.parentCollapsed(r.id);
      el.toggleClass("is-kids-collapsed", collapsed);
      const toggle = el.querySelector<HTMLElement>(".mva-chats-kids");
      if (!toggle) return;
      const n = kids.counts.get(r.id) ?? 0;
      toggle.setAttribute("aria-expanded", String(!collapsed));
      // The shape and the number are the sighted channel; this is the whole of
      // it for a screen reader, so it names the count rather than saying
      // "expand" over a row that could be hiding one reply or nine.
      toggle.setAttribute(
        "aria-label",
        collapsed ? `Show ${n} nested chat${n === 1 ? "" : "s"}` : "Hide nested chats",
      );
      // Only while collapsed, exactly like a section header's count: expanded,
      // the rows are right there and the number is noise.
      toggle.querySelector<HTMLElement>(".mva-chats-kids-count")?.setText(
        collapsed ? String(n) : "",
      );
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
  private rowModel(r: ChatRow, now: number): CardModel {
    // Running, open or pinned: something you are actively choosing between.
    const rich = r.lane != null || r.open || r.pinned;
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
        // A row that gains or loses its parent changes shape, so it has to
        // rebuild rather than be patched in place at the wrong indent. Gaining
        // or losing CHILDREN is the same kind of change — it adds or removes
        // the collapse control. Whether that control is currently collapsed is
        // deliberately absent: that is applied as a class afterwards, so
        // toggling never rebuilds the row you are standing on.
        r.depth, r.hasChildren,
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
    if (r.depth === 1) row.addClass("is-child");
    // `is-needs-input` still colours the status text; the running and unseen
    // row classes went with the rails they were the only consumers of — the
    // gutter dot carries those two states now, and a class nothing styles is a
    // hook that quietly rots.
    if (r.lane === "needs-input") row.addClass("is-needs-input");
    if (r.open) row.addClass("is-active");

    this.dotInto(row, r);
    const head = row.createDiv({ cls: "mva-chats-line" });
    head.createSpan({ cls: "mva-chats-name", text: r.title });
    // Markers trail the title, never precede it: a leading icon shifts the title
    // right on exactly the rows that have one, so the column breaks on the few
    // rows and holds on the many. Left gutter = live state, title column, then
    // trailing markers and age.
    if (r.pinned) setIcon(head.createSpan({ cls: "mva-chats-pin", attr: { "aria-label": "Pinned" } }), "pin");
    this.kidsToggleInto(head, r);
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

  /**
   * The status dot, in a gutter that is ALWAYS reserved — the element is
   * created for every row, whether or not it carries a state, so the titles sit
   * on one vertical line and the list does not jitter as a chat starts running
   * or goes quiet. That stability is the whole reason this replaced the left
   * rails, which painted three unrelated meanings into the same 2px channel.
   *
   * The state is carried as a class, not a colour: filled / ring / small is the
   * signal, colour only reinforces it, so the row still reads under a theme that
   * flattens the palette and for someone who cannot separate orange from green.
   * The label is what a screen reader gets — the shape means nothing to it.
   */
  private dotInto(row: HTMLElement, r: ChatRow): void {
    const dot = chatDot(r);
    const el = row.createSpan({ cls: "mva-chats-dot" });
    if (!dot) return;
    el.addClass(`is-${dot}`);
    el.setAttribute("aria-label", DOT_LABEL[dot]);
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
    if (r.depth === 1) row.addClass("is-child");
    if (r.open) row.addClass("is-active");
    this.dotInto(row, r);
    row.createSpan({ cls: "mva-chats-name", text: r.title });
    // Same rule as the rich row: markers trail, so the title column holds for
    // every row whether or not it is pinned or carries a badge.
    if (r.pinned) setIcon(row.createSpan({ cls: "mva-chats-pin", attr: { "aria-label": "Pinned" } }), "pin");
    this.badgeInto(row, r);
    this.kidsToggleInto(row, r);
    row.createSpan({ cls: "mva-chats-age", text: r.updatedAt ? relativeTime(r.updatedAt, now) : "" });
    row.dataset.id = r.id;
    this.wireRow(row, r);
    return row;
  }

  /**
   * The collapse control for a conversation that fanned out. Same gesture as a
   * section header, one rung down: the same chevron, the same rotation, the
   * same count-only-while-collapsed rule — reusing the language rather than
   * inventing a second one for the same idea.
   *
   * It TRAILS the title, like the pin and the badge and for the same reason: a
   * leading chevron would shift the title right on exactly the few rows that
   * fanned out, breaking the column the whole list is read down. It is smaller
   * and fainter than the section chevron, because a parent row is one row among
   * many and not a boundary between groups.
   *
   * A `div` made operable by `clickable`, never a `<button>` — Obsidian's
   * `button:not(.clickable-icon)` rule out-specifies a single-class selector
   * and would strip the layout out from under it, the same trap documented on
   * the section header.
   *
   * The handler STOPS PROPAGATION: this sits inside the row, and the row's own
   * click reveals the conversation. Without it, folding the children would also
   * open the chat — for the click AND for the Enter/Space that `clickable`
   * wires, since both bubble to the row's identical handlers.
   */
  private kidsToggleInto(host: HTMLElement, r: ChatRow): void {
    if (!r.hasChildren) return;
    const toggle = host.createSpan({ cls: "mva-chats-kids" });
    // A rotation, not two icons — same reasoning as the section chevron.
    setIcon(toggle.createSpan({ cls: "mva-chats-kids-chevron" }), "chevron-right");
    toggle.createSpan({ cls: "mva-chats-kids-count" });
    clickable(toggle, (e) => {
      e.stopPropagation();
      this.toggleParent(r.id);
    });
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
