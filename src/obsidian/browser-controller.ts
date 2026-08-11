/**
 * Browser controller: the plugin-level owner of the shared agent browser.
 *
 * One controller per plugin instance (WeakMap accessor, so main.ts carries
 * ZERO wiring lines for it: it is at its size-ratchet ceiling). It owns the
 * lease, finds-or-creates the exo-browser leaf, and translates BrowserBridge
 * calls into host operations plus the injected scripts. All refusals go
 * through BrowserToolRefused so the tools render them as answers rather than
 * as failures the model should retry.
 *
 * Import direction: view.ts -> this module -> ui/browser-view. This module must
 * never import view.ts or ui/view-registry.ts (cycle).
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
import type { BrowserHost } from "./browser-host";
import { BrowserView, EXO_BROWSER_VIEW_TYPE } from "../ui/browser-view";

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

export class BrowserController {
  private lease: BrowserLease | null = null;

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

  private async ensureView(reveal: boolean): Promise<{ view: BrowserView; host: BrowserHost }> {
    const { workspace } = this.plugin.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(EXO_BROWSER_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: EXO_BROWSER_VIEW_TYPE, active: reveal });
    }
    // A leaf restored from layout may still be deferred: realize it first.
    await (leaf as WorkspaceLeaf & { loadIfDeferred?: () => Promise<void> }).loadIfDeferred?.();
    if (reveal) workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (!(view instanceof BrowserView)) {
      throw new BrowserToolRefused("The agent-browser view could not be created in this workspace.");
    }
    const host = view.ensureHost();
    if (!host) {
      throw new BrowserToolRefused(
        "The agent browser is unavailable here (disabled, mobile, or no webview support)."
      );
    }
    return { view, host };
  }

  /** Existing, live view+host: for tools that must not create the tab. */
  private async currentView(): Promise<{ view: BrowserView; host: BrowserHost }> {
    const leaves = this.plugin.app.workspace.getLeavesOfType(EXO_BROWSER_VIEW_TYPE);
    if (!leaves.length) {
      throw new BrowserToolRefused("No agent-browser tab is open. Call browser_open first.");
    }
    return this.ensureView(false);
  }

  private requireLease(convoId: string): void {
    const res = checkLease(this.lease, convoId);
    if (!res.ok) throw new BrowserToolRefused(res.reason);
  }

  private async status(view: BrowserView, host: BrowserHost): Promise<BrowserStatus> {
    const basics = host.pageBasics();
    let scroll = { scrollY: 0, scrollHeight: 0, viewportHeight: 0 };
    try {
      scroll = JSON.parse(await host.exec(STATUS_SCRIPT)) as typeof scroll;
    } catch {
      /* about:blank or a crashed guest: basics still stand */
    }
    view.setStatus(basics.url, basics.title);
    return { ...basics, ...scroll, ownerConvoId: this.lease?.ownerConvoId ?? null };
  }

  /* ------------------------------- ops ---------------------------------- */

  private async open(convoId: string, url?: string): Promise<BrowserStatus> {
    const { lease, tookOverFrom } = acquireLease(this.lease, convoId, Date.now());
    this.lease = lease;
    const { view, host } = await this.ensureView(true);
    if (url) {
      const gate = isAllowedUrl(url);
      if (!gate.ok) throw new BrowserToolRefused(gate.reason);
      await host.navigate(gate.url);
    }
    const status = await this.status(view, host);
    if (tookOverFrom) {
      status.title = `${status.title} [took over the browser from ${tookOverFrom}]`;
    }
    return status;
  }

  private async navigate(convoId: string, url: string): Promise<BrowserStatus> {
    this.requireLease(convoId);
    const gate = isAllowedUrl(url);
    if (!gate.ok) throw new BrowserToolRefused(gate.reason);
    const { view, host } = await this.currentView();
    await host.navigate(gate.url);
    return this.status(view, host);
  }

  private async snapshot(): Promise<{ status: BrowserStatus; elements: PageElement[] }> {
    const { view, host } = await this.currentView();
    let elements: PageElement[] = [];
    try {
      elements = JSON.parse(await host.exec(SNAPSHOT_SCRIPT)) as PageElement[];
    } catch {
      elements = [];
    }
    return { status: await this.status(view, host), elements };
  }

  private async readPage(): Promise<{ status: BrowserStatus; text: string; total: number }> {
    const { view, host } = await this.currentView();
    let text = "";
    let total = 0;
    try {
      const parsed = JSON.parse(await host.exec(READ_PAGE_SCRIPT)) as { text: string; total: number };
      text = parsed.text;
      total = parsed.total;
    } catch {
      /* leave empty: status still reports the URL */
    }
    return { status: await this.status(view, host), text, total };
  }

  private async screenshot(): Promise<{ status: BrowserStatus; pngB64: string }> {
    const { view, host } = await this.currentView();
    const pngB64 = await host.capture();
    // An unpainted surface does not fail: capturePage resolves with a 0x0,
    // zero-byte image (probed 2026-08-11). Refusing here is the difference
    // between the model being told the tab was not visible and the model
    // confidently describing a blank page as the page.
    if (!pngB64) {
      throw new BrowserToolRefused(
        "The browser tab rendered nothing to capture: it is hidden, collapsed, or in a background window. " +
          "Ask Mario to bring the Agent browser tab into view, or use browser_read_page and browser_snapshot instead."
      );
    }
    return { status: await this.status(view, host), pngB64 };
  }

  private async act(convoId: string, script: string): Promise<BrowserStatus> {
    this.requireLease(convoId);
    const { view, host } = await this.currentView();
    let res: { ok: boolean; reason?: string } = { ok: false, reason: "no result" };
    try {
      res = JSON.parse(await host.exec(script)) as typeof res;
    } catch (e) {
      res = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    if (!res.ok) throw new BrowserToolRefused(res.reason ?? "The page rejected the action.");
    await host.settleAfterAction();
    return this.status(view, host);
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
