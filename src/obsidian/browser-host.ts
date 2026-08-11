/**
 * Browser host: a thin driver over Obsidian's OWN Web Viewer leaf.
 *
 * It creates nothing. The `webviewer` core plugin owns the `<webview>` element,
 * its lifecycle, its chrome (address bar, history, favicon) and its session;
 * this module only reads the element off the view and calls into it.
 *
 * SECURITY POSTURE, stated plainly because it changed and a stale comment would
 * be worse than none. The native viewer runs in Obsidian's OWN vault session
 * (partition `persist:vault-<hash>`, from `app.getWebviewPartition()`), so:
 *
 * - There is no dedicated partition, and no deny-all permission handler or
 *   download block of ours. Whatever posture Obsidian sets for its Web Viewer
 *   is the posture the agent gets. We do not harden it and we do not claim to.
 * - The agent therefore browses AS MARIO: any site he is logged into in the Web
 *   Viewer is a site the agent sees authenticated, and `browser_click` /
 *   `browser_type` act inside those sessions. That is the deliberate trade of
 *   this design, not an oversight: research behind a login is the use case.
 *
 * What is still OURS and still enforced: the http/https URL gate
 * (`core/browser-page`) and the JSON-escaped script protocol
 * (`core/browser-inject`). No API here takes raw agent input; the controller
 * passes finished scripts in, and this host stays script-agnostic with no core
 * imports at all.
 *
 * Probed live 2026-08-11 against the running app (results in the execution
 * report): the native view exposes `webview`, `webviewMounted`,
 * `webviewFirstLoadFinished`, `url` and `navigate()`, and the element exposes
 * loadURL/executeJavaScript/capturePage/getURL/getTitle/isLoading/stop.
 */

/** Obsidian's own view type for the Web Viewer. Not ours: never rename it, and
 *  never register it. */
export const WEBVIEWER_VIEW_TYPE = "webviewer";

export const EXEC_RESULT_CAP = 64_000;
const NAV_TIMEOUT_MS = 15_000;
const SETTLE_EXTRA_MS = 300;
const READY_POLL_MS = 25;

/**
 * How long an entry point waits for the native view's guest to attach.
 *
 * The flags are plain fields, not events (Obsidian sets `webviewMounted` inside
 * its own `dom-ready` listener), so the wait is a bounded poll rather than a
 * subscription: an element that gets re-instantiated underneath us cannot slip
 * past a poll the way it would slip past a listener bound to the old element.
 * Observed cost live: 61ms for a background tab, ~400ms to 1s for a visible one
 * loading a page. 10s is a wide margin over the real case and still under
 * NAV_TIMEOUT_MS, so a guest that never attaches fails with an actionable
 * message rather than eating the caller's whole navigation budget.
 */
export const READY_TIMEOUT_MS = 10_000;

/** A captured frame, as Electron's NativeImage hands it over. */
interface CapturedImage {
  resize(opts: { width: number }): CapturedImage;
  toPNG(): Uint8Array;
  getSize(): { width: number; height: number };
  isEmpty(): boolean;
}

/** The slice of the webview element this host uses (Electron types are not a
 *  dependency of this repo: declare only what we touch). */
interface WebviewEl {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  stop(): void;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  capturePage(): Promise<CapturedImage>;
}

/**
 * The slice of Obsidian's WebViewerView this host drives.
 *
 * `webview` is nullable and MUTABLE on purpose: Obsidian re-instantiates the
 * element (on `destroyed`, and when the leaf moves to another window) and
 * resets both flags when it does. Nothing here may cache the element.
 */
export interface WebViewerView {
  webview: WebviewEl | null;
  webviewMounted: boolean;
  webviewFirstLoadFinished: boolean;
  /** Obsidian's own navigation: it also switches the view out of its blank
   *  mode, which a raw `loadURL` does not do (probed live). */
  navigate(url: string, pushHistory?: boolean): void;
}

/** Cap + coerce an executeJavaScript return value to a bounded string. */
export function capExecResult(raw: unknown): string {
  const s = raw == null ? "" : typeof raw === "string" ? raw : String(raw);
  return s.length > EXEC_RESULT_CAP ? s.slice(0, EXEC_RESULT_CAP) : s;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class BrowserHost {
  constructor(private readonly view: WebViewerView) {}

  /**
   * Resolve once the native guest is genuinely usable, i.e. once Obsidian has
   * seen `dom-ready` for the element currently on the view.
   *
   * Gated on `webviewMounted` ALONE. `webviewFirstLoadFinished` looks like the
   * stronger signal and is a trap: Obsidian's `commitPageLoad` returns early
   * for the blank `data:text/plain,` URL a Web Viewer tab opens on, so on a tab
   * with no page that flag never flips (probed live: still false after 3.3s,
   * while the guest was already executing scripts at 61ms). Requiring it would
   * hang `browser_open` with no url, permanently.
   */
  async whenReady(timeoutMs = READY_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.view.webviewMounted && this.view.webview) return;
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(
          `Obsidian's Web viewer did not become ready within ${Math.round(timeoutMs / 1000)}s. ` +
            "Its tab did not finish starting up: ask Mario to check that the Web viewer core plugin " +
            "is enabled and that the tab is not stuck, then try again."
        );
      }
      await sleep(Math.min(READY_POLL_MS, left));
    }
  }

  private need(): WebviewEl {
    const wv = this.view.webview;
    if (!wv) throw new Error("Obsidian's Web viewer has no page attached.");
    return wv;
  }

  /**
   * Navigate and wait for the load to settle (did-stop-loading, did-fail-load,
   * or the timeout, whichever comes first, plus a short paint-settle delay).
   *
   * Goes through the view's own `navigate` rather than `webview.loadURL`: from
   * a blank Web Viewer tab a raw loadURL loads the page but leaves the view in
   * `mode === "blank"`, which keeps the element hidden and makes every capture
   * come back empty. Obsidian's `stop()` on an idle guest emits nothing, so it
   * cannot settle this wait early (both probed live).
   */
  async navigate(url: string, timeoutMs = NAV_TIMEOUT_MS): Promise<void> {
    const wv = this.need();
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        wv.removeEventListener("did-stop-loading", finish);
        wv.removeEventListener("did-fail-load", finish);
        resolve();
      };
      wv.addEventListener("did-stop-loading", finish);
      wv.addEventListener("did-fail-load", finish);
      setTimeout(finish, timeoutMs);
      this.view.navigate(url, true);
    });
    await sleep(SETTLE_EXTRA_MS);
  }

  /** After a click that may have triggered navigation: wait for quiet. */
  async settleAfterAction(maxMs = 5_000): Promise<void> {
    const start = Date.now();
    await sleep(SETTLE_EXTRA_MS);
    while (this.need().isLoading() && Date.now() - start < maxMs) {
      await sleep(200);
    }
  }

  /** Run one of the injected scripts; returns the (capped) JSON string. */
  async exec(script: string): Promise<string> {
    return capExecResult(await this.need().executeJavaScript(script, false));
  }

  /**
   * Capture the visible page, downscaled to bound tokens, as base64 PNG.
   *
   * Returns "" when the compositor has nothing painted for this webview.
   * That case is NOT hypothetical and NOT loud: re-probed 2026-08-11 against
   * the NATIVE viewer, a Web Viewer tab sitting in the background resolves
   * capturePage() with a 0x0, isEmpty(), zero-byte image rather than throwing.
   * Handing that to the model as a screenshot would be handing it a blank page
   * it cannot tell from a real one, so the empty string is the signal the
   * controller refuses on.
   */
  async capture(maxWidth = 1024): Promise<string> {
    const img = await this.need().capturePage();
    const { width, height } = img.getSize();
    if (img.isEmpty() || width < 1 || height < 1) return "";
    const png = width > maxWidth ? img.resize({ width: maxWidth }).toPNG() : img.toPNG();
    return png.length ? Buffer.from(png).toString("base64") : "";
  }

  pageBasics(): { url: string; title: string; loading: boolean } {
    const wv = this.need();
    return { url: wv.getURL(), title: wv.getTitle(), loading: wv.isLoading() };
  }
}
