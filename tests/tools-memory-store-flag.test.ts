import { describe, it, expect } from "vitest";
import { createObsidianToolServer } from "../src/obsidian/tools";

/** Registered tool (bare, unprefixed) names on the SDK MCP server instance. */
function registeredNames(server: ReturnType<typeof createObsidianToolServer>): Set<string> {
  const reg = (server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  return new Set(Object.keys(reg));
}

function fakeApp() {
  return {
    vault: { getMarkdownFiles: () => [] },
    workspace: { getActiveFile: () => null, activeEditor: undefined },
    metadataCache: {},
    plugins: { plugins: {} },
  } as any;
}

/** `memoryStoreEnabled` is the last positional argument of
 *  `createObsidianToolServer` (see src/obsidian/tools.ts) — default true, so
 *  every other caller/test in the suite is unaffected. */
function makeServer(memoryStoreEnabled: boolean) {
  return createObsidianToolServer(
    fakeApp(),
    /* alwaysLoad            */ true,
    /* memoryWrite           */ true,
    /* askBridge             */ async () => ({}),
    /* memoryRead            */ true,
    /* memoryWriteQueue      */ undefined,
    /* orchestrationEnabled  */ false,
    /* tasksWriteQueue       */ undefined,
    /* agentFolderEnabled    */ true,
    /* rethinkBridge         */ async () => "",
    /* loopsWriteQueue       */ undefined,
    /* paths                 */ undefined,
    /* parentConvoId         */ undefined,
    /* browserBridge         */ undefined,
    /* memoryStoreEnabled    */ memoryStoreEnabled
  );
}

const STORE_TOOLS = ["remember", "recall", "log_session", "capture_learning"];
const NON_STORE_MEMORY_TOOLS = ["capture_decision", "open_loop", "close_loop", "rethink_memory"];

describe("memoryStoreEnabled gates the Memory Union Store tools", () => {
  it("ON (default): store tools AND decisions/loops/identity tools are all registered", () => {
    const names = registeredNames(makeServer(true));
    for (const n of [...STORE_TOOLS, ...NON_STORE_MEMORY_TOOLS]) {
      expect(names.has(n), `${n} missing with memoryStoreEnabled=true`).toBe(true);
    }
  });

  it("OFF: remember/recall/log_session/capture_learning are NOT registered", () => {
    const names = registeredNames(makeServer(false));
    for (const n of STORE_TOOLS) {
      expect(names.has(n), `${n} still registered with memoryStoreEnabled=false`).toBe(false);
    }
  });

  it("OFF: capture_decision, open_loop, close_loop, and rethink_memory keep working", () => {
    const names = registeredNames(makeServer(false));
    for (const n of NON_STORE_MEMORY_TOOLS) {
      expect(names.has(n), `${n} was dropped with memoryStoreEnabled=false`).toBe(true);
    }
  });
});
