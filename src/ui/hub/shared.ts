import type { App } from "obsidian";
import type ExoPlugin from "../../main";

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
}

/** Uppercase section header with a count pill — shared by every hub tab. */
export function buildGroupHeader(label: string, count: number): HTMLElement {
  const h = createDiv({ cls: "mva-conn-group" });
  h.createSpan({ cls: "mva-conn-group-name", text: label });
  h.createSpan({ cls: "mva-conn-group-count", text: String(count) });
  return h;
}

/** Row scaffold: name · origin badge · desc on the left, actions container on
 *  the right. Tabs fill `right` with their own status + buttons. */
export function buildRowScaffold(name: string, origin: string, desc?: string): { row: HTMLElement; right: HTMLElement } {
  const row = createDiv({ cls: "mva-conn-row" });
  row.createSpan({ cls: "mva-conn-name", text: name });
  row.createSpan({ cls: "mva-conn-origin", text: origin });
  if (desc) row.createSpan({ cls: "mva-conn-desc", text: desc });
  const right = row.createDiv({ cls: "mva-conn-actions" });
  return { row, right };
}
