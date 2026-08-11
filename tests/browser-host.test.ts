import { describe, it, expect } from "vitest";
import {
  BrowserHost,
  WEBVIEWER_VIEW_TYPE,
  capExecResult,
  EXEC_RESULT_CAP,
  type WebViewerView,
} from "../src/obsidian/browser-host";

/**
 * Browser host contract, now that the host DRIVES Obsidian's native Web Viewer
 * instead of owning a `<webview>` of its own.
 *
 * The readiness gate is the part worth pinning, and its shape comes from live
 * probes of the running app (recorded in the execution report): the native view
 * exposes `webviewMounted` and `webviewFirstLoadFinished`, and only the first
 * one is a usable gate. A Web Viewer tab opened with no URL sits on
 * `data:text/plain,` forever with `webviewFirstLoadFinished === false`, because
 * Obsidian's `commitPageLoad` returns early for that blank URL. Gating on it
 * would hang `browser_open` with no arguments, permanently.
 */

/* ------------------------- fake native harness -------------------------- */

type Listener = () => void;

/** The slice of an Electron `<webview>` the host touches. `emit` lets a test
 *  decide when a navigation settles; listener bookkeeping proves nothing is
 *  left behind. */
class FakeWebview {
  private readonly listeners = new Map<string, Listener[]>();
  emptyCapture = true;
  loaded: string[] = [];
  stopped = 0;

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  listenerCount(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
  emit(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  getURL(): string {
    return this.loaded[this.loaded.length - 1] ?? "about:blank";
  }
  getTitle(): string {
    return "Fake";
  }
  isLoading(): boolean {
    return false;
  }
  stop(): void {
    this.stopped += 1;
  }
  async loadURL(url: string): Promise<void> {
    this.loaded.push(url);
  }
  async executeJavaScript(): Promise<string> {
    return "exec-result";
  }
  async capturePage(): Promise<unknown> {
    const empty = this.emptyCapture;
    return {
      getSize: () => (empty ? { width: 0, height: 0 } : { width: 2000, height: 100 }),
      isEmpty: () => empty,
      resize: () => ({ toPNG: () => new Uint8Array([1, 2, 3]) }),
      toPNG: () => (empty ? new Uint8Array() : new Uint8Array([1, 2, 3])),
    };
  }
}

/** The slice of Obsidian's WebViewerView the host reads. */
class FakeView implements WebViewerView {
  webview: FakeWebview | null = new FakeWebview();
  webviewMounted = false;
  webviewFirstLoadFinished = false;
  navigated: string[] = [];

  navigate(url: string): void {
    this.navigated.push(url);
    void this.webview?.loadURL(url);
  }
  /** Obsidian replaces the element on `destroyed` and on cross-window moves. */
  reinstantiate(): FakeWebview {
    this.webview = new FakeWebview();
    this.webviewMounted = false;
    this.webviewFirstLoadFinished = false;
    return this.webview;
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("the host targets Obsidian's own view type", () => {
  it("uses the core Web Viewer type, not a type of ours", () => {
    expect(WEBVIEWER_VIEW_TYPE).toBe("webviewer");
  });
});

describe("readiness over the native flags", () => {
  it("does not resolve while the native view reports the webview unmounted", async () => {
    const view = new FakeView();
    const host = new BrowserHost(view);
    let settled = "";
    const waiting = host.whenReady(1_000).then(
      () => (settled = "ready"),
      (e: Error) => (settled = `error: ${e.message}`)
    );
    await tick();
    expect(settled).toBe("");
    view.webviewMounted = true;
    await waiting;
    expect(settled).toBe("ready");
  });

  it("waits for webviewMounted only, never for webviewFirstLoadFinished", async () => {
    // A blank Web Viewer tab never finishes a first load: probed live, its URL
    // stays `data:text/plain,` and the flag stays false forever. Requiring it
    // would hang browser_open with no url.
    const view = new FakeView();
    view.webviewMounted = true;
    view.webviewFirstLoadFinished = false;
    // A zero budget would expire instantly if this waited on anything else.
    await expect(new BrowserHost(view).whenReady(0)).resolves.toBeUndefined();
  });

  it("fails with an actionable message when the wait expires", async () => {
    const host = new BrowserHost(new FakeView());
    await expect(host.whenReady(5)).rejects.toThrow(/did not become ready/i);
    await expect(host.whenReady(5)).rejects.toThrow(/web viewer/i);
  });

  it("fails when the native view has no webview element at all", async () => {
    const view = new FakeView();
    view.webview = null;
    view.webviewMounted = true;
    await expect(new BrowserHost(view).whenReady(5)).rejects.toThrow(/did not become ready/i);
  });

  it("goes back to waiting when Obsidian re-instantiates the webview", async () => {
    const view = new FakeView();
    view.webviewMounted = true;
    await expect(new BrowserHost(view).whenReady(0)).resolves.toBeUndefined();
    view.reinstantiate();
    await expect(new BrowserHost(view).whenReady(5)).rejects.toThrow(/did not become ready/i);
  });
});

describe("the host never caches the webview element", () => {
  it("reads view.webview fresh, so a re-instantiated guest is the one driven", async () => {
    const view = new FakeView();
    view.webviewMounted = true;
    const host = new BrowserHost(view);
    const first = view.webview!;
    const second = view.reinstantiate();
    view.webviewMounted = true;
    await host.exec("noop");
    expect(await host.capture()).toBe("");
    expect(host.pageBasics().title).toBe("Fake");
    // The stale element is untouched; everything landed on the current one.
    expect(first.listenerCount("did-stop-loading")).toBe(0);
    expect(second).toBe(view.webview);
  });
});

describe("navigation goes through the native view, not raw loadURL", () => {
  it("calls view.navigate so the Web Viewer leaves its blank mode", async () => {
    // Probed live: a raw webview.loadURL() from a blank Web Viewer tab loads
    // the page but leaves `mode === "blank"`, so the element stays hidden and
    // every capture comes back empty. view.navigate() switches the mode.
    const view = new FakeView();
    view.webviewMounted = true;
    const host = new BrowserHost(view);
    const wv = view.webview!;
    const done = host.navigate("https://example.com", 5_000);
    await tick();
    wv.emit("did-stop-loading");
    await done;
    expect(view.navigated).toEqual(["https://example.com"]);
    expect(wv.listenerCount("did-stop-loading")).toBe(0);
    expect(wv.listenerCount("did-fail-load")).toBe(0);
  });
});

describe("capture of an unpainted webview", () => {
  it("still returns the empty string, so the controller can refuse", async () => {
    // Probed live against the NATIVE viewer too: a background Web Viewer tab
    // resolves capturePage() with a 0x0, isEmpty(), zero-byte image rather
    // than throwing. Handing that to the model is handing it a blank page.
    const view = new FakeView();
    view.webviewMounted = true;
    expect(await new BrowserHost(view).capture()).toBe("");
  });

  it("returns base64 for a painted one", async () => {
    const view = new FakeView();
    view.webviewMounted = true;
    view.webview!.emptyCapture = false;
    expect(await new BrowserHost(view).capture()).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });
});

describe("capExecResult", () => {
  it("passes strings through and caps huge ones", () => {
    expect(capExecResult("ok")).toBe("ok");
    const huge = capExecResult("x".repeat(EXEC_RESULT_CAP + 100));
    expect(huge.length).toBeLessThanOrEqual(EXEC_RESULT_CAP);
  });

  it("stringifies non-strings defensively", () => {
    expect(capExecResult(null)).toBe("");
    expect(capExecResult(undefined)).toBe("");
    expect(capExecResult(42)).toBe("42");
  });
});
