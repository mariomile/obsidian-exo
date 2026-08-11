import { describe, it, expect } from "vitest";
import { Platform } from "obsidian";
import { browserBridgeFor, getBrowserController } from "../src/obsidian/browser-controller";
import type ExoPlugin from "../src/main";

/**
 * The controller itself is impure by design (it drives a live webview through
 * a workspace leaf); its decisions live in the pure modules of Tasks 1-3. What
 * IS testable here is the gate, and the gate is the whole safety story of the
 * feature: `undefined` from this factory is what keeps the session tool list
 * byte-identical to before the browser existed.
 */

const plugin = (browserEnabled: boolean): ExoPlugin =>
  ({ settings: { browserEnabled }, app: { workspace: {} } }) as unknown as ExoPlugin;

describe("browserBridgeFor gating", () => {
  it("returns undefined when the feature is off (byte-identical tool list)", () => {
    expect(browserBridgeFor(plugin(false), "convo-a")).toBeUndefined();
  });

  it("returns a full bridge when enabled on desktop", () => {
    const bridge = browserBridgeFor(plugin(true), "convo-a");
    expect(bridge).toBeTruthy();
    for (const m of [
      "open",
      "navigate",
      "snapshot",
      "readPage",
      "screenshot",
      "click",
      "type",
      "scroll",
    ] as const) {
      expect(typeof bridge![m], m).toBe("function");
    }
  });

  it("returns undefined on mobile even when enabled", () => {
    (Platform as { isMobile: boolean }).isMobile = true;
    try {
      expect(browserBridgeFor(plugin(true), "convo-a")).toBeUndefined();
    } finally {
      (Platform as { isMobile: boolean }).isMobile = false;
    }
  });

  it("hands two conversations of one plugin the same controller (shared lease)", () => {
    const p = plugin(true);
    const a = browserBridgeFor(p, "convo-a");
    const b = browserBridgeFor(p, "convo-b");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b); // distinct per-convo closures over ONE controller
    expect(getBrowserController(p)).toBe(getBrowserController(p));
  });

  it("gives two different plugin instances two different controllers", () => {
    expect(getBrowserController(plugin(true))).not.toBe(getBrowserController(plugin(true)));
  });
});

/* ---------------------- leaf ownership over the native viewer ---------------- */

/**
 * The one decision the migration to Obsidian's native Web Viewer forced, and
 * the one worth pinning: WHICH `webviewer` leaf the agent drives.
 *
 * A Web Viewer leaf carries no owner marker, so "reuse the first one" and
 * "reuse ours" are indistinguishable from the workspace's side. They are not
 * indistinguishable for Mario: adopting his tab means navigating away from
 * whatever he was reading, mid-read, because the agent was asked to look
 * something up. That loss is not one we can undo; an extra tab is.
 */

interface FakeLeafShape {
  id: string;
  view: unknown;
  setViewState(s: { type: string; state?: unknown; active?: boolean }): Promise<void>;
  detach(): void;
}

const fakeWebview = () => ({
  listeners: new Map<string, Array<() => void>>(),
  addEventListener(t: string, fn: () => void): void {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]);
  },
  removeEventListener(t: string, fn: () => void): void {
    this.listeners.set(t, (this.listeners.get(t) ?? []).filter((f) => f !== fn));
  },
  emit(t: string): void {
    for (const fn of [...(this.listeners.get(t) ?? [])]) fn();
  },
  getURL: () => "https://example.com/",
  getTitle: () => "Example Domain",
  isLoading: () => false,
  stop: (): void => {},
  executeJavaScript: async () => '{"scrollY":0,"scrollHeight":800,"viewportHeight":800}',
  capturePage: async () => ({
    getSize: () => ({ width: 800, height: 600 }),
    isEmpty: () => false,
    resize: () => ({ toPNG: () => new Uint8Array([1]) }),
    toPNG: () => new Uint8Array([1]),
  }),
});

const webViewerView = (): Record<string, unknown> => ({
  getViewType: () => "webviewer",
  webview: fakeWebview(),
  webviewMounted: true,
  webviewFirstLoadFinished: true,
  navigated: [] as string[],
  navigate(url: string) {
    (this.navigated as string[]).push(url);
    // Obsidian's guest settles asynchronously; the host waits for this event.
    setTimeout(() => (this.webview as { emit(t: string): void }).emit("did-stop-loading"), 0);
  },
});

/** A workspace with just enough surface for the controller's leaf handling,
 *  and a log of every leaf it was asked to create. */
function fakeWorkspace(seed: FakeLeafShape[] = []) {
  const leaves: FakeLeafShape[] = [...seed];
  const created: FakeLeafShape[] = [];
  let n = seed.length;
  const revealed: string[] = [];
  const workspace = {
    getLeavesOfType: (t: string) =>
      t === "webviewer" ? leaves.filter((l) => !!l.view) : [],
    getLeaf: (): FakeLeafShape => {
      const leaf: FakeLeafShape = {
        id: `leaf-${++n}`,
        view: null,
        async setViewState(s) {
          if (s.type === "webviewer") this.view = webViewerView();
        },
        detach() {
          this.view = null;
        },
      };
      leaves.push(leaf);
      created.push(leaf);
      return leaf;
    },
    revealLeaf: (l: FakeLeafShape) => revealed.push(l.id),
  };
  return { workspace, leaves, created, revealed };
}

const wiredPlugin = (workspace: unknown): ExoPlugin =>
  ({ settings: { browserEnabled: true }, app: { workspace } }) as unknown as ExoPlugin;

describe("which Web Viewer leaf the agent drives", () => {
  it("opens its own webviewer leaf on the first browser_open", async () => {
    const w = fakeWorkspace();
    const bridge = browserBridgeFor(wiredPlugin(w.workspace), "convo-a")!;
    await bridge.open("https://example.com");
    expect(w.created).toHaveLength(1);
    expect((w.created[0].view as { getViewType(): string }).getViewType()).toBe("webviewer");
  });

  it("reuses that same leaf instead of littering a tab per call", async () => {
    const w = fakeWorkspace();
    const bridge = browserBridgeFor(wiredPlugin(w.workspace), "convo-a")!;
    await bridge.open("https://example.com");
    await bridge.navigate("https://example.org");
    await bridge.open("https://example.net");
    expect(w.created).toHaveLength(1);
  });

  it("never adopts a Web Viewer tab Mario opened himself", async () => {
    // His tab stays on his page: the agent gets its own.
    const his: FakeLeafShape = {
      id: "his",
      view: webViewerView(),
      async setViewState() {},
      detach() {
        this.view = null;
      },
    };
    const w = fakeWorkspace([his]);
    const bridge = browserBridgeFor(wiredPlugin(w.workspace), "convo-a")!;
    await bridge.open("https://example.com");
    expect(w.created).toHaveLength(1);
    expect(w.created[0].id).not.toBe("his");
    expect((his.view as { navigated: string[] }).navigated).toEqual([]);
  });

  it("opens a fresh one after Mario closes the agent's tab", async () => {
    const w = fakeWorkspace();
    const bridge = browserBridgeFor(wiredPlugin(w.workspace), "convo-a")!;
    await bridge.open("https://example.com");
    w.created[0].detach();
    await bridge.open("https://example.com");
    expect(w.created).toHaveLength(2);
  });

  it("refuses the read tools until browser_open has made a tab, creating none", async () => {
    const w = fakeWorkspace();
    const bridge = browserBridgeFor(wiredPlugin(w.workspace), "convo-a")!;
    await expect(bridge.snapshot()).rejects.toThrow(/browser_open/i);
    expect(w.created).toHaveLength(0);
  });
});
