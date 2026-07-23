import { describe, it, expect } from "vitest";
import { normalizeCodexServer } from "../src/core/connections-scan";

describe("normalizeCodexServer", () => {
  it("maps url form to http config, keeping headers", () => {
    const out = normalizeCodexServer({ url: "https://mcp.context7.com/mcp", http_headers: { Authorization: "Bearer x" } });
    expect(out).toEqual({ type: "http", url: "https://mcp.context7.com/mcp", headers: { Authorization: "Bearer x" } });
  });
  it("maps command form to stdio config, keeping args and env", () => {
    const out = normalizeCodexServer({ command: "npx", args: ["-y", "posthog-mcp"], env: { KEY: "v" } });
    expect(out).toEqual({ command: "npx", args: ["-y", "posthog-mcp"], env: { KEY: "v" } });
  });
  it("drops codex-only per-tool gating keys", () => {
    const out = normalizeCodexServer({ args: ["@playwright/mcp@latest"], tools: { browser_run_code_unsafe: {} } });
    expect(out).toEqual({ args: ["@playwright/mcp@latest"] });
  });
  it("returns null when neither url nor command nor args present", () => {
    expect(normalizeCodexServer({ description: "x" })).toBeNull();
  });
});
