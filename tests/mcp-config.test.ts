import { describe, it, expect } from "vitest";
import {
  parseMcpJson,
  serializeMcpJson,
  upsertServer,
  removeServer,
  setServerEnabled,
  summarizeServer,
  buildServerConfig,
} from "../src/core/mcp-config";

const RAW = JSON.stringify({
  mcpServers: {
    context7: { type: "http", url: "https://mcp.context7.com/mcp" },
    ft: { command: "ft", args: ["mcp"] },
  },
  mcpServersDisabled: {
    playwright: { command: "npx", args: ["-y", "@playwright/mcp"] },
  },
});

describe("parseMcpJson", () => {
  it("reads enabled and disabled servers, sorted", () => {
    const { servers, error } = parseMcpJson(RAW);
    expect(error).toBeNull();
    expect(servers.map((s) => [s.name, s.enabled])).toEqual([
      ["context7", true],
      ["ft", true],
      ["playwright", false],
    ]);
  });

  it("reports invalid JSON without throwing", () => {
    expect(parseMcpJson("{nope").error).toMatch(/Invalid JSON/);
  });

  it("rejects a non-object mcpServers", () => {
    expect(parseMcpJson('{"mcpServers": []}').error).toContain("mcpServers");
  });

  it("enabled wins when a name appears in both maps", () => {
    const raw = '{"mcpServers":{"a":{"command":"x"}},"mcpServersDisabled":{"a":{"command":"y"}}}';
    const { servers } = parseMcpJson(raw);
    expect(servers).toHaveLength(1);
    expect(servers[0].enabled).toBe(true);
  });
});

describe("serializeMcpJson", () => {
  it("round-trips and omits the disabled key when empty", () => {
    const { servers } = parseMcpJson(RAW);
    const out = JSON.parse(serializeMcpJson(servers));
    expect(Object.keys(out.mcpServers).sort()).toEqual(["context7", "ft"]);
    expect(Object.keys(out.mcpServersDisabled)).toEqual(["playwright"]);
    const none = JSON.parse(serializeMcpJson(servers.map((s) => ({ ...s, enabled: true }))));
    expect(none.mcpServersDisabled).toBeUndefined();
  });
});

describe("mutations", () => {
  const base = parseMcpJson(RAW).servers;

  it("upsert adds a new server enabled by default", () => {
    const next = upsertServer(base, "exa", { type: "http", url: "https://mcp.exa.ai" });
    expect(next.find((s) => s.name === "exa")?.enabled).toBe(true);
  });

  it("upsert preserves the enabled flag of an existing server", () => {
    const next = upsertServer(base, "playwright", { command: "pw" });
    expect(next.find((s) => s.name === "playwright")?.enabled).toBe(false);
  });

  it("remove and toggle", () => {
    expect(removeServer(base, "ft").some((s) => s.name === "ft")).toBe(false);
    expect(setServerEnabled(base, "context7", false).find((s) => s.name === "context7")?.enabled).toBe(false);
  });
});

describe("summarizeServer", () => {
  it("summarizes stdio and http", () => {
    expect(summarizeServer({ command: "npx", args: ["-y", "foo"] })).toBe("stdio · npx -y foo");
    expect(summarizeServer({ type: "http", url: "https://x.dev/mcp" })).toBe("http · https://x.dev/mcp");
  });
});

describe("buildServerConfig", () => {
  it("builds a stdio config with args and env", () => {
    const r = buildServerConfig({ name: "ft", type: "stdio", target: "ft", args: "mcp --fast", extraJson: '{"K":"v"}' });
    expect(r).toEqual({ name: "ft", config: { command: "ft", args: ["mcp", "--fast"], env: { K: "v" } } });
  });

  it("builds an http config", () => {
    const r = buildServerConfig({ name: "exa", type: "http", target: "https://mcp.exa.ai", args: "", extraJson: "" });
    expect(r).toEqual({ name: "exa", config: { type: "http", url: "https://mcp.exa.ai" } });
  });

  it("validates name, target, url scheme and extra JSON", () => {
    expect(buildServerConfig({ name: "", type: "stdio", target: "x", args: "", extraJson: "" })).toHaveProperty("error");
    expect(buildServerConfig({ name: "bad name", type: "stdio", target: "x", args: "", extraJson: "" })).toHaveProperty("error");
    expect(buildServerConfig({ name: "a", type: "stdio", target: "", args: "", extraJson: "" })).toHaveProperty("error");
    expect(buildServerConfig({ name: "a", type: "http", target: "ftp://x", args: "", extraJson: "" })).toHaveProperty("error");
    expect(buildServerConfig({ name: "a", type: "stdio", target: "x", args: "", extraJson: "[1]" })).toHaveProperty("error");
  });
});
