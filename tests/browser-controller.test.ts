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
