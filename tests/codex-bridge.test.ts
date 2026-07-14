import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { toolsManifest, callBridgeTool, authOk, startCodexBridge } from "../src/obsidian/codex-bridge";

const echo = tool("echo", "Echo the input back.", { text: z.string() }, async (a) => ({
  content: [{ type: "text", text: `echo:${a.text}` }],
}));
const boom = tool("boom", "Always throws.", {}, async () => {
  throw new Error("kaboom");
});

describe("toolsManifest", () => {
  it("exposes name, description, and a JSON schema with the right properties", () => {
    const m = toolsManifest([echo]);
    expect(m[0].name).toBe("echo");
    expect(m[0].description).toContain("Echo");
    expect(m[0].inputSchema).toMatchObject({ type: "object" });
    expect((m[0].inputSchema as { properties?: Record<string, unknown> }).properties).toHaveProperty("text");
  });
});

describe("callBridgeTool", () => {
  it("validates input and runs the handler", async () => {
    const r = await callBridgeTool([echo], "echo", { text: "hi" });
    expect(r).toEqual({ content: [{ type: "text", text: "echo:hi" }] });
  });

  it("rejects invalid input as an MCP error result, not a throw", async () => {
    const r = await callBridgeTool([echo], "echo", { text: 5 });
    expect(r.isError).toBe(true);
  });

  it("unknown tool and handler throw both become isError results", async () => {
    expect((await callBridgeTool([echo], "nope", {})).isError).toBe(true);
    const r = await callBridgeTool([boom], "boom", {});
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("kaboom");
  });
});

describe("authOk", () => {
  it("accepts only the exact bearer token", () => {
    expect(authOk("Bearer abc", "abc")).toBe(true);
    expect(authOk("Bearer abd", "abc")).toBe(false);
    expect(authOk(undefined, "abc")).toBe(false);
    expect(authOk("abc", "abc")).toBe(false);
  });
});

describe("startCodexBridge (live http)", () => {
  it("serves /tools and /call with auth, 401 without", async () => {
    const b = await startCodexBridge();
    try {
      b.setTools([echo]);
      const base = `http://127.0.0.1:${b.port}`;
      const h = { Authorization: `Bearer ${b.token}` };
      const list = await (await fetch(`${base}/tools`, { headers: h })).json();
      expect(list[0].name).toBe("echo");
      const call = await (
        await fetch(`${base}/call`, {
          method: "POST",
          headers: { ...h, "Content-Type": "application/json" },
          body: JSON.stringify({ tool: "echo", input: { text: "x" } }),
        })
      ).json();
      expect(call.content[0].text).toBe("echo:x");
      expect((await fetch(`${base}/tools`)).status).toBe(401);
    } finally {
      b.stop();
    }
  });
});
