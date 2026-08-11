import { describe, it, expect } from "vitest";
import { BROWSER_PARTITION, WEBVIEW_ATTRS, capExecResult, EXEC_RESULT_CAP } from "../src/obsidian/browser-host";

/**
 * Browser host contract: the security posture is data, so it is testable.
 * Everything else in BrowserHost touches a live `<webview>` and is verified
 * against the running Obsidian instead (see the plan's probe results).
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
