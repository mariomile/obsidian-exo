/**
 * Browser host: the thin impure wrapper around one Electron `<webview>`
 * element (Obsidian desktop only; the tag does not exist on mobile).
 *
 * Security posture, decided in the plan and pinned by tests on WEBVIEW_ATTRS:
 * a dedicated persistent partition (logins survive restarts, isolated from
 * Obsidian's own sessions), contextIsolation + sandbox on, no node
 * integration, no popups (window.open is inert without `allowpopups`). On top
 * of that, MAIN-session hardening through the remote module: deny-all
 * permission handlers and a download block. Electron GRANTS permission
 * requests by default when no handler is set, so a failed hardening is a
 * weaker posture, not a neutral one, and `hardened` exists to say so out loud
 * (the leaf surfaces it; it is never swallowed).
 *
 * All page access goes through executeJavaScript with the Task-3 scripts
 * (JSON-string protocol, capped results). No API here takes raw agent input:
 * the controller passes scripts in; this host stays script-agnostic and has
 * no core imports at all.
 *
 * Probed live 2026-08-11 (see the plan's Probe results): the element exposes
 * loadURL/executeJavaScript/capturePage/getURL/getTitle/isLoading directly,
 * executeJavaScript hands back a string, and `remote.session` is available.
 */
export const BROWSER_PARTITION = "persist:exo-agent-browser";
export const EXEC_RESULT_CAP = 64_000;
const NAV_TIMEOUT_MS = 15_000;
const SETTLE_EXTRA_MS = 300;

/** Attributes set on the webview BEFORE it enters the DOM: partition is
 *  immutable after attach. Pure and exported so a unit test pins the posture. */
export const WEBVIEW_ATTRS: Record<string, string> = {
  partition: BROWSER_PARTITION,
  webpreferences: "contextIsolation=yes,sandbox=yes",
  src: "about:blank",
};

/** A captured frame, as Electron's NativeImage hands it over. */
interface CapturedImage {
  resize(opts: { width: number }): CapturedImage;
  toPNG(): Uint8Array;
  getSize(): { width: number; height: number };
  isEmpty(): boolean;
}

/** The slice of the webview element this host uses (Electron types are not a
 *  dependency of this repo: declare only what we touch). */
interface WebviewEl extends HTMLElement {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  stop(): void;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  capturePage(): Promise<CapturedImage>;
}

/** Cap + coerce an executeJavaScript return value to a bounded string. */
export function capExecResult(raw: unknown): string {
  const s = raw == null ? "" : typeof raw === "string" ? raw : String(raw);
  return s.length > EXEC_RESULT_CAP ? s.slice(0, EXEC_RESULT_CAP) : s;
}

export class BrowserHost {
  private webview: WebviewEl | null = null;
  private hardenedFlag = false;

  constructor(private readonly container: HTMLElement) {}

  get supported(): boolean {
    return this.webview !== null;
  }

  get hardened(): boolean {
    return this.hardenedFlag;
  }

  /** Create and mount the webview. Returns false when the environment has no
   *  usable webview tag (mobile, or a future Electron without it). */
  attach(): boolean {
    if (this.webview) return true;
    const el = document.createElement("webview") as WebviewEl;
    for (const [k, v] of Object.entries(WEBVIEW_ATTRS)) el.setAttribute(k, v);
    el.classList.add("mva-browser-webview");
    this.container.appendChild(el);
    if (typeof el.executeJavaScript !== "function" && typeof el.loadURL !== "function") {
      // Methods bind on attach; if they never appear this build has no webview.
      el.remove();
      return false;
    }
    this.webview = el;
    this.hardenedFlag = this.hardenSession();
    return true;
  }

  /** Main-session hardening: deny-all permissions, block downloads. Runs once
   *  per host per partition. Failure is REPORTED (via `hardened`), not fatal
   *  and never silent: with no handler installed Electron grants requests. */
  private hardenSession(): boolean {
    try {
      const electron = require("electron") as {
        remote?: {
          session?: {
            fromPartition(p: string): {
              setPermissionRequestHandler(
                h: ((wc: unknown, p: string, cb: (ok: boolean) => void) => void) | null
              ): void;
              setPermissionCheckHandler(h: ((wc: unknown, p: string) => boolean) | null): void;
              on(ev: "will-download", h: (e: { preventDefault(): void }) => void): void;
            };
          };
        };
      };
      const session = electron.remote?.session?.fromPartition(BROWSER_PARTITION);
      if (!session) return false;
      session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
      session.setPermissionCheckHandler(() => false);
      session.on("will-download", (e) => e.preventDefault());
      return true;
    } catch {
      return false;
    }
  }

  private need(): WebviewEl {
    if (!this.webview) throw new Error("The agent browser is not attached.");
    return this.webview;
  }

  /** Navigate and wait for the load to settle (did-stop-loading, did-fail-load,
   *  or the timeout, whichever comes first, plus a short paint-settle delay). */
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
      void wv.loadURL(url).catch(() => finish());
    });
    await new Promise((r) => setTimeout(r, SETTLE_EXTRA_MS));
  }

  /** After a click that may have triggered navigation: wait for quiet. */
  async settleAfterAction(maxMs = 5_000): Promise<void> {
    const wv = this.need();
    const start = Date.now();
    await new Promise((r) => setTimeout(r, SETTLE_EXTRA_MS));
    while (wv.isLoading() && Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** Run one of the Task-3 scripts; returns the (capped) JSON string. */
  async exec(script: string): Promise<string> {
    return capExecResult(await this.need().executeJavaScript(script, false));
  }

  /**
   * Capture the visible page, downscaled to bound tokens, as base64 PNG.
   *
   * Returns "" when the compositor has nothing painted for this webview.
   * That case is NOT hypothetical and NOT loud: probed 2026-08-11, an
   * off-composite webview resolves capturePage() with a 0x0, isEmpty(),
   * zero-byte image rather than throwing. Handing that to the model as a
   * screenshot would be handing it a blank page it cannot tell from a real
   * one, so the empty string is the signal the controller refuses on.
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

  destroy(): void {
    this.webview?.remove();
    this.webview = null;
  }
}
