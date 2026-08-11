import type { WorkspaceLeaf } from "obsidian";
import type ExoPlugin from "../main";
import { ChatView, VIEW_TYPE } from "../view";
import { BoardView, BOARD_VIEW_TYPE } from "./board-view";
import { CockpitView, COCKPIT_VIEW_TYPE } from "./cockpit-view";
import { AgentsView, AGENTS_VIEW_TYPE } from "./agents-view";
import { HubView, HUB_VIEW_TYPE, type HubTab } from "./hub/hub-view";
import { ChatListView, CHATS_VIEW_TYPE } from "./chat-list-view";
import { BrowserView, EXO_BROWSER_VIEW_TYPE } from "./browser-view";

/** Every Exo view is registered here, in one place, so `main.ts` carries the
 *  plugin lifecycle and not a catalogue of panes. Registration is unconditional
 *  for all of them: a leaf restored from a saved workspace layout must be able
 *  to render even when its entry point is gated (see BoardView.onOpen). */
export function registerExoViews(plugin: ExoPlugin): void {
  plugin.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, plugin));
  // The board view is always REGISTERED (so a leaf restored from the saved
  // workspace layout can render) but only ENTERED via a gated ribbon/command.
  // If it opens while orchestration is off it renders a "disabled" placeholder
  // and never starts the driver (see BoardView.onOpen).
  plugin.registerView(BOARD_VIEW_TYPE, (leaf) => new BoardView(leaf, plugin));
  plugin.registerView(COCKPIT_VIEW_TYPE, (leaf) => new CockpitView(leaf, plugin));
  plugin.registerView(HUB_VIEW_TYPE, (leaf) => new HubView(leaf, plugin));
  plugin.registerView(AGENTS_VIEW_TYPE, (leaf) => new AgentsView(leaf, plugin));
  plugin.registerView(CHATS_VIEW_TYPE, (leaf) => new ChatListView(leaf, plugin));
  // Same contract as the board: always registered so a restored leaf renders,
  // gated at entry so it never creates a webview while the flag is off.
  plugin.registerView(EXO_BROWSER_VIEW_TYPE, (leaf) => new BrowserView(leaf, plugin));
}

/** Open `viewType` as a main-pane tab, reusing an existing leaf if one is open. */
export async function activateInMain(plugin: ExoPlugin, viewType: string): Promise<WorkspaceLeaf | null> {
  const { workspace } = plugin.app;
  let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(viewType)[0] ?? null;
  if (!leaf) {
    // Main-area tab (not the sidebar) — these are full-width surfaces.
    leaf = workspace.getLeaf(true);
    await leaf.setViewState({ type: viewType, active: true });
  }
  workspace.revealLeaf(leaf);
  return leaf;
}

/** Open `viewType` as a right-sidebar tab, reusing an existing leaf if one is open. */
export async function activateInRightSidebar(plugin: ExoPlugin, viewType: string): Promise<WorkspaceLeaf | null> {
  const { workspace } = plugin.app;
  let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(viewType)[0] ?? null;
  if (!leaf) {
    leaf = workspace.getRightLeaf(false);
    await leaf?.setViewState({ type: viewType, active: true });
  }
  if (leaf) workspace.revealLeaf(leaf);
  return leaf;
}

export async function activateView(plugin: ExoPlugin): Promise<void> {
  const leaf = await activateInRightSidebar(plugin, VIEW_TYPE);
  if (leaf && leaf.view instanceof ChatView) leaf.view.focusComposer();
}

/**
 * Open the Orchestration Board in the MAIN workspace pane (a new tab, not the
 * sidebar). Reuses an already-open board leaf if present. Only ever invoked
 * from the gated ribbon/command, so the flag is on by the time we get here.
 */
export async function activateBoard(plugin: ExoPlugin): Promise<void> {
  await activateInMain(plugin, BOARD_VIEW_TYPE);
}

/** Open the Capabilities hub, optionally deep-linking to a tab. */
export async function activateHub(plugin: ExoPlugin, tab?: HubTab): Promise<void> {
  const leaf = await activateInMain(plugin, HUB_VIEW_TYPE);
  if (tab && leaf?.view instanceof HubView) leaf.view.showTab(tab);
}

export async function activateConnections(plugin: ExoPlugin): Promise<void> {
  await activateHub(plugin);
}

export async function activateAgents(plugin: ExoPlugin): Promise<void> {
  await activateInMain(plugin, AGENTS_VIEW_TYPE);
}

/**
 * Open the chats list in the LEFT sidebar — the only left-mounted view Exo has,
 * and the codebase's only `getLeftLeaf` call. Left on purpose: the chat itself
 * lives on the right, so a list that opened there would fight it for the same
 * strip. Placement is only a default; the leaf is a normal `ItemView` the user
 * can drag anywhere, and Obsidian persists that choice in the workspace layout.
 */
export async function activateChats(plugin: ExoPlugin): Promise<void> {
  const { workspace } = plugin.app;
  let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(CHATS_VIEW_TYPE)[0] ?? null;
  if (!leaf) {
    leaf = workspace.getLeftLeaf(false);
    await leaf?.setViewState({ type: CHATS_VIEW_TYPE, active: true });
  }
  if (leaf) workspace.revealLeaf(leaf);
}
