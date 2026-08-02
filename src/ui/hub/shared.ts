import { setIcon, type App } from "obsidian";
import type ExoPlugin from "../../main";
import { clickable } from "../dom";

/** Everything a hub tab renderer needs. Tabs are free functions
 *  `render<Tab>Tab(host, ctx)` — the view shell owns navigation and refresh,
 *  the tab owns its data gathering and rows. */
export interface HubTabContext {
  app: App;
  plugin: ExoPlugin;
  /** Re-render the currently visible tab (after an action mutated state). */
  rerender: () => void;
  /** Vault base path on disk ("" on non-desktop adapters). */
  base: () => string;
  /** Accordion open/closed state, keyed by the caller (e.g. "mcp:notion").
   *  Lives on the HubView instance — ephemeral UI state, not a setting, and
   *  resets when the pane closes. Row `sig`s should include this so
   *  reconcileList rebuilds a row when it's toggled. */
  expanded: (key: string) => boolean;
  toggleExpanded: (key: string) => void;
}

/** Uppercase section header, with an optional count pill (list sections only —
 *  a count on a fixed set of status rows is noise). */
export function buildGroupHeader(label: string, count?: number): HTMLElement {
  const h = createDiv({ cls: "mva-conn-group" });
  h.createSpan({ cls: "mva-conn-group-name", text: label });
  if (count !== undefined) h.createSpan({ cls: "mva-conn-group-count", text: String(count) });
  return h;
}

function chevron(open: boolean): HTMLElement {
  const c = createSpan({ cls: "mva-hub-chevron" });
  setIcon(c, open ? "chevron-down" : "chevron-right");
  return c;
}

/** A group header that collapses/expands the rows under it — the member rows
 *  are simply omitted from the model list for a render pass while closed, so
 *  callers gate on `ctx.expanded(key)` themselves before building them. */
export function buildAccordionGroupHeader(ctx: HubTabContext, key: string, label: string, count?: number): HTMLElement {
  const h = buildGroupHeader(label, count);
  h.insertBefore(chevron(ctx.expanded(key)), h.firstChild);
  h.addClass("is-clickable");
  clickable(h, () => ctx.toggleExpanded(key));
  return h;
}

/** Wrap a built row in accordion behavior: a leading chevron toggles a body
 *  panel appended below the header. The header itself (name/origin/desc/
 *  actions) is untouched — this only prepends a chevron and appends the body
 *  when open. `buildBody` is called only when open, so callers can skip
 *  gathering expensive detail (tool lists, doc content) for closed rows. */
export function buildAccordionRow(ctx: HubTabContext, key: string, header: HTMLElement, buildBody: () => HTMLElement): HTMLElement {
  const wrap = createDiv({ cls: "mva-hub-accordion" });
  const isOpen = ctx.expanded(key);
  header.insertBefore(chevron(isOpen), header.firstChild);
  header.addClass("is-clickable");
  clickable(header, (e) => {
    // Action buttons inside the header (Edit/Remove/…) must not also toggle.
    if ((e.target as HTMLElement).closest("button")) return;
    ctx.toggleExpanded(key);
  });
  wrap.appendChild(header);
  if (isOpen) wrap.appendChild(buildBody());
  return wrap;
}

/** Row scaffold: name · origin badge · desc on the left, actions container on
 *  the right. Tabs fill `right` with their own status + buttons. */
export function buildRowScaffold(name: string, origin?: string, desc?: string): { row: HTMLElement; right: HTMLElement } {
  const row = createDiv({ cls: "mva-conn-row" });
  row.createSpan({ cls: "mva-conn-name", text: name });
  if (origin) row.createSpan({ cls: "mva-conn-origin", text: origin });
  if (desc) row.createSpan({ cls: "mva-conn-desc", text: desc });
  const right = row.createDiv({ cls: "mva-conn-actions" });
  return { row, right };
}

/** Read-only status row: label left, dot + value right. `enabled` drives the
 *  dot (green when on, faint when off); omit it for a neutral, dotless value. */
export function buildStatusRow(label: string, value: string, enabled?: boolean, desc?: string): HTMLElement {
  const { row, right } = buildRowScaffold(label, undefined, desc);
  if (enabled !== undefined) {
    const dot = right.createSpan({ cls: "mva-conn-dot" });
    dot.toggleClass("is-connected", enabled);
    dot.toggleClass("is-disabled", !enabled);
  }
  right.createSpan({ cls: "mva-conn-state", text: value });
  return row;
}

/** Run an existing command by id (the palette is the single source of behavior;
 *  hub rows only ever delegate to it). */
export function runCommand(ctx: HubTabContext, id: string): void {
  (ctx.app as unknown as { commands: { executeCommandById(id: string): boolean } }).commands.executeCommandById(id);
}

/** Open a vault note in a new tab (the hub lives in its own leaf — no panel to
 *  close first, unlike the old in-chat overlay). */
export function openNote(ctx: HubTabContext, path: string): void {
  void ctx.app.workspace.openLinkText(path, "", "tab");
}

/** Deep-link to the Exo settings tab. */
export function openExoSettings(ctx: HubTabContext): void {
  const setting = (ctx.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
  setting?.open();
  setting?.openTabById("exo");
}
