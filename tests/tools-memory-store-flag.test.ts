import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import { buildObsidianTools } from "../src/obsidian/tools";

/** Registered tool names for a given store flag, everything else on. */
function registeredNames(memoryStoreEnabled: boolean): Set<string> {
  const tools = buildObsidianTools({} as App, {
    memoryWrite: true,
    askBridge: async () => ({}),
    memoryRead: true,
    agentFolderEnabled: true,
    rethinkBridge: async () => "",
    memoryStoreEnabled,
  });
  return new Set(tools.map((t) => t.name));
}

const STORE_TOOLS = ["remember", "recall", "log_session", "capture_learning"];
const NON_STORE_MEMORY_TOOLS = ["capture_decision", "open_loop", "close_loop", "rethink_memory"];

describe("memoryStoreEnabled gates the Memory Union Store tools", () => {
  it("ON (default): store tools AND decisions/loops/identity tools are all registered", () => {
    const names = registeredNames(true);
    for (const n of [...STORE_TOOLS, ...NON_STORE_MEMORY_TOOLS]) {
      expect(names.has(n), `${n} missing with memoryStoreEnabled=true`).toBe(true);
    }
  });

  it("OFF: remember/recall/log_session/capture_learning are NOT registered", () => {
    const names = registeredNames(false);
    for (const n of STORE_TOOLS) {
      expect(names.has(n), `${n} still registered with memoryStoreEnabled=false`).toBe(false);
    }
  });

  it("OFF: capture_decision, open_loop, close_loop, and rethink_memory keep working", () => {
    const names = registeredNames(false);
    for (const n of NON_STORE_MEMORY_TOOLS) {
      expect(names.has(n), `${n} was dropped with memoryStoreEnabled=false`).toBe(true);
    }
  });
});
