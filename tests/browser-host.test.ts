import { describe, it, expect, afterEach } from "vitest";
import {
  BROWSER_PARTITION,
  BrowserHost,
  WEBVIEW_ATTRS,
  capExecResult,
  EXEC_RESULT_CAP,
} from "../src/obsidian/browser-host";

/**
 * Browser host contract: the security posture is data, so it is testable.
 * The readiness gate is testable too, through a fake `<webview>` that emits
 * `dom-ready` on demand. Everything else in BrowserHost touches a live guest
 * and is verified against the running Obsidian (see the plan's probe results).
 */

describe("webview security attributes", () => {
  it("pins the persistent partition", () => {
    expect(BROWSER_PARTITION).toBe("persist:exo-agent-browser");
    expect(WEBVIEW_ATTRS.partition).toBe(BROWSER_PARTITION);
  });

  it("enables contextIsolation and sandbox, and never popups or node", () => {
    expect(WEBVIEW_ATTRS.webpreferences).toContain("contextIsolation=yes");
    expect(WEBVIEW_ATTRS.webpreferences).toContain("sandbox=yes");
    expect(Object.keys(WEBVIEW_ATTRS)).not.toContain("allowpopups");
    expect(Object.keys(WEBVIEW_ATTRS)).not.toContain("nodeintegration");
    expect(WEBVIEW_ATTRS.webpreferences).not.toContain("nodeIntegration=yes");
  });

  it("starts on about:blank, never on a remote page", () => {
    expect(WEBVIEW_ATTRS.src).toBe("about:blank");
  });
});

/* ------------------------- fake webview harness ------------------------- */

type Listener = () => void;

/** The slice of an Electron `<webview>` BrowserHost actually touches, with an
 *  `emit` so a test decides when the guest becomes ready. Listener bookkeeping
 *  is exposed so a test can prove nothing is left behind. */
class FakeWebview {
  private readonly listeners = new Map<string, Listener[]>();
  readonly attrs: Record<string, string> = {};
  readonly classList = { add: (): void => {} };
  removed = false;
  emptyCapture = true;

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
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  remove(): void {
    this.removed = true;
  }
  async loadURL(): Promise<void> {}
  async executeJavaScript(): Promise<string> {
    return "";
  }
  async capturePage(): Promise<unknown> {
    const empty = this.emptyCapture;
    return {
      getSize: () => (empty ? { width: 0, height: 0 } : { width: 200, height: 100 }),
      isEmpty: () => empty,
      resize: () => ({ toPNG: () => new Uint8Array([1, 2, 3]) }),
      toPNG: () => (empty ? new Uint8Array() : new Uint8Array([1, 2, 3])),
    };
  }
}

const g = globalThis as unknown as { document?: unknown };
let savedDocument: unknown;
let hasSavedDocument = false;

/** Stand a host up over a fake webview, with no DOM in sight. */
function mountHost(): { host: BrowserHost; wv: FakeWebview } {
  const wv = new FakeWebview();
  if (!hasSavedDocument) {
    savedDocument = g.document;
    hasSavedDocument = true;
  }
  g.document = { createElement: (): FakeWebview => wv };
  const container = { appendChild: (): void => {} } as unknown as HTMLElement;
  const host = new BrowserHost(container);
  expect(host.attach()).toBe(true);
  return { host, wv };
}

afterEach(() => {
  if (hasSavedDocument) {
    g.document = savedDocument;
    hasSavedDocument = false;
  }
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("webview readiness gate", () => {
  it("does not resolve until the webview emits dom-ready", async () => {
    const { host, wv } = mountHost();
    let settled = "";
    const waiting = host.whenReady(1_000).then(
      () => (settled = "ready"),
      (e: Error) => (settled = `error: ${e.message}`)
    );
    await tick();
    expect(settled).toBe("");
    wv.emit("dom-ready");
    await waiting;
    expect(settled).toBe("ready");
  });

  it("returns at once when the webview is already ready, without listening again", async () => {
    const { host, wv } = mountHost();
    wv.emit("dom-ready");
    await tick();
    expect(wv.listenerCount("dom-ready")).toBe(0);
    // A zero budget would expire instantly if this waited a second time.
    await expect(host.whenReady(0)).resolves.toBeUndefined();
    expect(wv.listenerCount("dom-ready")).toBe(0);
  });

  it("fails with an actionable message when the wait expires", async () => {
    const { host } = mountHost();
    await expect(host.whenReady(5)).rejects.toThrow(/did not become ready/i);
    await expect(host.whenReady(5)).rejects.toThrow(/bring the Agent browser tab into view/i);
  });

  it("fails cleanly, and leaves no listener, when the leaf closes mid-wait", async () => {
    const { host, wv } = mountHost();
    const waiting = host.whenReady(60_000);
    host.destroy();
    await expect(waiting).rejects.toThrow(/closed/i);
    expect(wv.listenerCount("dom-ready")).toBe(0);
    expect(wv.removed).toBe(true);
  });

  it("refuses to wait at all once the host has been destroyed", async () => {
    const { host } = mountHost();
    host.destroy();
    await expect(host.whenReady(5)).rejects.toThrow(/not attached/i);
  });
});

describe("capture of an unpainted webview", () => {
  it("still returns the empty string, so the controller can refuse", async () => {
    const { host, wv } = mountHost();
    wv.emit("dom-ready");
    expect(await host.capture()).toBe("");
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
