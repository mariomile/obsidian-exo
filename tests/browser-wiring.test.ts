import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Browser wiring contract: the seams that connect the tested browser core to
 * the untestable view.ts. Same rationale as fanout-wiring.test.ts: every link
 * is a plain call whose failure mode is silence. A session that never receives
 * the bridge simply has no browser tools; a session signature that ignores
 * `browserEnabled` keeps serving stale tool lists after the flag flips.
 * Red here means "re-wire the seam", never "relax the assertion".
 */
const read = (...rel: string[]): string => readFileSync(join(__dirname, "..", ...rel), "utf8");
const view = read("src", "view.ts");
const tools = read("src", "obsidian", "tools.ts");
const controller = read("src", "obsidian", "browser-controller.ts");

describe("browser wiring", () => {
  it("view.ts builds a per-convo browser bridge for the Claude tool server", () => {
    expect(view).toMatch(/createObsidianToolServer\([\s\S]*?browserBridgeFor\(this\.plugin,\s*c\.id\)/);
  });

  it("view.ts passes the bridge to the Codex registry too", () => {
    expect(view).toMatch(/browserBridge:\s*browserBridgeFor\(this\.plugin,\s*c\.id\)/);
  });

  it("the session signature includes browserEnabled, so flipping the flag respawns", () => {
    const at = view.indexOf("sessionSigOf");
    expect(at).toBeGreaterThan(-1);
    expect(view.slice(at, at + 900)).toContain("browserEnabled");
  });

  it("tools.ts registers the browser set only behind the bridge", () => {
    expect(tools).toMatch(/browserBridge \? buildBrowserTools\(browserBridge\) : \[\]/);
  });

  it("every entry point waits for dom-ready: the wait sits inside ensureView", () => {
    const at = controller.indexOf("private async ensureView");
    expect(at).toBeGreaterThan(-1);
    const body = controller.slice(at, controller.indexOf("private async currentView"));
    expect(body).toContain("await host.whenReady()");
    // The host throws plain Errors; the caller must see a refusal, not a crash.
    expect(body).toContain("BrowserToolRefused");
  });
});
