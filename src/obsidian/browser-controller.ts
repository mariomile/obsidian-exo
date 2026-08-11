/**
 * Browser controller: the plugin-level owner of the agent's browsing.
 *
 * One controller per plugin instance (WeakMap accessor, so main.ts carries
 * ZERO wiring lines for it: it is at its size-ratchet ceiling). It owns the
 * lease, owns ONE leaf of Obsidian's native Web Viewer, and translates
 * BrowserBridge calls into host operations plus the injected scripts. All
 * refusals go through BrowserToolRefused so the tools render them as answers
 * rather than as failures the model should retry.
 *
 * Import direction: view.ts -> this module -> obsidian/browser-host. Exo
 * registers no view of its own for this feature; the `webviewer` leaf belongs
 * to Obsidian's core plugin. This module must never import view.ts or
 * ui/view-registry.ts (cycle).
 */
import { Platform, type WorkspaceLeaf } from "obsidian";
import type ExoPlugin from "../main";
import { acquireLease, checkLease, type BrowserLease } from "../core/browser-lease";
import { isAllowedUrl, type PageElement } from "../core/browser-page";
import {
  READ_PAGE_SCRIPT,
  SNAPSHOT_SCRIPT,
  STATUS_SCRIPT,
  clickScript,
  scrollScript,
  typeIntoScript,
  type ElementTarget,
} from "../core/browser-inject";
import { BrowserToolRefused, type BrowserBridge, type BrowserStatus } from "./browser-tools";
import { BrowserHost, WEBVIEWER_VIEW_TYPE, type WebViewerView } from "./browser-host";

const controllers = new WeakMap<ExoPlugin, BrowserController>();

export function getBrowserController(plugin: ExoPlugin): BrowserController {
  let c = controllers.get(plugin);
  if (!c) {
    c = new BrowserController(plugin);
    controllers.set(plugin, c);
  }
  return c;
}

/** Per-convo bridge, or undefined when the feature is gated off: undefined is
 *  what keeps the session tool list byte-identical with the flag off. */
export function browserBridgeFor(plugin: ExoPlugin, convoId: string): BrowserBridge | undefined {
  if (!plugin.settings.browserEnabled || Platform.isMobile) return undefined;
  return getBrowserController(plugin).bridgeFor(convoId);
}

/** Read a leaf as a Web Viewer, or null if it is anything else. Obsidian's
 *  view is not an exported class, so the check is structural: the view type it
 *  reports plus the one method we drive it through. */
function asWebViewer(leaf: WorkspaceLeaf): WebViewerView | null {
  const v = leaf.view as unknown as (WebViewerView & { getViewType?(): string }) | null;
  if (!v || v.getViewType?.() !== WEBVIEWER_VIEW_TYPE) return null;
  return typeof v.navigate === "function" ? v : null;
}

export class BrowserController {
  private lease: BrowserLease | null = null;
  /** The ONE Web Viewer leaf this plugin session opened. See ensureView. */
  private ownLeaf: WorkspaceLeaf | null = null;

  constructor(private readonly plugin: ExoPlugin) {}

  bridgeFor(convoId: string): BrowserBridge {
    return {
      open: (url) => this.open(convoId, url),
      navigate: (url) => this.navigate(convoId, url),
      snapshot: () => this.snapshot(),
      readPage: () => this.readPage(),
      screenshot: () => this.screenshot(),
      click: (t) => this.click(convoId, t),
      type: (t, text, opts) => this.type(convoId, t, text, opts),
      scroll: (op) => this.scroll(convoId, op),
    };
  }

  /* ------------------------------ plumbing ------------------------------ */

  /** The leaf we opened, if it is still in the workspace. Null once Mario
   *  closes it, so the next open makes a new one rather than driving a
   *  detached view. */
  private liveOwnLeaf(): WorkspaceLeaf | null {
    if (!this.ownLeaf) return null;
    const open = this.plugin.app.workspace.getLeavesOfType(WEBVIEWER_VIEW_TYPE);
    if (!open.includes(this.ownLeaf)) this.ownLeaf = null;
    return this.ownLeaf;
  }

  /**
   * Get the agent's Web Viewer leaf, creating it once per plugin session.
   *
   * LEAF REUSE, decided here: the agent reuses the leaf IT opened, and never
   * adopts a `webviewer` leaf Mario opened himself. A Web Viewer leaf carries
   * no owner marker, so "the first webviewer leaf" and "ours" look identical
   * from the workspace's side; they are not identical for Mario. Driving his
   * tab means navigating away from whatever he was reading, mid-read, because
   * the agent was asked to look something up, and we cannot give that page
   * back. One extra tab we can. So: remember ours, keep reusing it, and leave
   * his alone. Closing ours costs one new tab on the next call; a plugin
   * reload costs one more, which is the honest price of not claiming a tab we
   * did not open.
   */
  private async ensureView(reveal: boolean): Promise<BrowserHost> {
    const { workspace } = this.plugin.app;
    let leaf = this.liveOwnLeaf();
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: WEBVIEWER_VIEW_TYPE, active: reveal });
      this.ownLeaf = leaf;
    }
    // A leaf restored from layout may still be deferred: realize it first.
    await (leaf as WorkspaceLeaf & { loadIfDeferred?: () => Promise<void> }).loadIfDeferred?.();
    if (reveal) workspace.revealLeaf(leaf);
    const view = asWebViewer(leaf);
    if (!view) {
      this.ownLeaf = null;
      throw new BrowserToolRefused(
        "Obsidian's Web viewer could not be opened. Check that the Web viewer core plugin is enabled."
      );
    }
    const host = new BrowserHost(view);
    // Obsidian attaches the Electron guest asynchronously, so the first call
    // after the leaf is created would otherwise reach the webview before
    // dom-ready and come back as "The WebView must be attached to the DOM and
    // the dom-ready event emitted". That is an infrastructure race, not a tool
    // failure: waiting for it here means the agent never sees it and never has
    // to guess a retry. Cheap once the flag is set, so later calls pay nothing.
    try {
      await host.whenReady();
    } catch (e) {
      throw new BrowserToolRefused(e instanceof Error ? e.message : String(e));
    }
    return host;
  }

  /** The live host: for tools that must not create the tab. */
  private async currentView(): Promise<BrowserHost> {
    if (!this.liveOwnLeaf()) {
      throw new BrowserToolRefused("No browser tab is open. Call browser_open first.");
    }
    return this.ensureView(false);
  }

  private requireLease(convoId: string): void {
    const res = checkLease(this.lease, convoId);
    if (!res.ok) throw new BrowserToolRefused(res.reason);
  }

  /** No view chrome to update: the native Web Viewer keeps its own address bar,
   *  title and favicon in sync off the same navigation events. */
  private async status(host: BrowserHost): Promise<BrowserStatus> {
    const basics = host.pageBasics();
    let scroll = { scrollY: 0, scrollHeight: 0, viewportHeight: 0 };
    try {
      scroll = JSON.parse(await host.exec(STATUS_SCRIPT)) as typeof scroll;
    } catch {
      /* about:blank or a crashed guest: basics still stand */
    }
    return { ...basics, ...scroll, ownerConvoId: this.lease?.ownerConvoId ?? null };
  }

  /* ------------------------------- ops ---------------------------------- */

  private async open(convoId: string, url?: string): Promise<BrowserStatus> {
    const { lease, tookOverFrom } = acquireLease(this.lease, convoId, Date.now());
    this.lease = lease;
    const host = await this.ensureView(true);
    if (url) {
      const gate = isAllowedUrl(url);
      if (!gate.ok) throw new BrowserToolRefused(gate.reason);
      await host.navigate(gate.url);
    }
    const status = await this.status(host);
    if (tookOverFrom) {
      status.title = `${status.title} [took over the browser from ${tookOverFrom}]`;
    }
    return status;
  }

  private async navigate(convoId: string, url: string): Promise<BrowserStatus> {
    this.requireLease(convoId);
    const gate = isAllowedUrl(url);
    if (!gate.ok) throw new BrowserToolRefused(gate.reason);
    const host = await this.currentView();
    await host.navigate(gate.url);
    return this.status(host);
  }

  private async snapshot(): Promise<{ status: BrowserStatus; elements: PageElement[] }> {
    const host = await this.currentView();
    let elements: PageElement[] = [];
    try {
      elements = JSON.parse(await host.exec(SNAPSHOT_SCRIPT)) as PageElement[];
    } catch {
      elements = [];
    }
    return { status: await this.status(host), elements };
  }

  private async readPage(): Promise<{ status: BrowserStatus; text: string; total: number }> {
    const host = await this.currentView();
    let text = "";
    let total = 0;
    try {
      const parsed = JSON.parse(await host.exec(READ_PAGE_SCRIPT)) as { text: string; total: number };
      text = parsed.text;
      total = parsed.total;
    } catch {
      /* leave empty: status still reports the URL */
    }
    return { status: await this.status(host), text, total };
  }

  private async screenshot(): Promise<{ status: BrowserStatus; pngB64: string }> {
    const host = await this.currentView();
    const pngB64 = await host.capture();
    // An unpainted surface does not fail: capturePage resolves with a 0x0,
    // zero-byte image. Re-probed 2026-08-11 against the NATIVE Web Viewer, a
    // background tab does exactly this. Refusing here is the difference between
    // the model being told the tab was not visible and the model confidently
    // describing a blank page as the page.
    if (!pngB64) {
      throw new BrowserToolRefused(
        "The browser tab rendered nothing to capture: it is hidden, collapsed, or in a background window. " +
          "Ask Mario to bring the Web viewer tab into view, or use browser_read_page and browser_snapshot instead."
      );
    }
    return { status: await this.status(host), pngB64 };
  }

  private async act(convoId: string, script: string): Promise<BrowserStatus> {
    this.requireLease(convoId);
    const host = await this.currentView();
    let res: { ok: boolean; reason?: string } = { ok: false, reason: "no result" };
    try {
      res = JSON.parse(await host.exec(script)) as typeof res;
    } catch (e) {
      res = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    if (!res.ok) throw new BrowserToolRefused(res.reason ?? "The page rejected the action.");
    await host.settleAfterAction();
    return this.status(host);
  }

  private click(convoId: string, target: ElementTarget): Promise<BrowserStatus> {
    return this.act(convoId, clickScript(target));
  }

  private type(
    convoId: string,
    target: ElementTarget,
    text: string,
    opts: { clear?: boolean; submit?: boolean }
  ): Promise<BrowserStatus> {
    return this.act(convoId, typeIntoScript(target, text, opts));
  }

  private scroll(
    convoId: string,
    op: { to?: "top" | "bottom"; pages?: number }
  ): Promise<BrowserStatus> {
    return this.act(convoId, scrollScript(op));
  }
}
