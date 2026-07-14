import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import {
  createObsidianToolServer,
  OBSIDIAN_READ_TOOLS,
  OBSIDIAN_MEMORY_TOOLS,
  OBSIDIAN_ORCHESTRATION_TOOLS,
} from "../src/obsidian/tools";

const PREFIX = "mcp__obsidian__";

/** Bare tool names actually registered on the server. The SDK adds the
 *  `mcp__obsidian__` prefix at runtime, so the classifier Sets (which use the
 *  full names) must match these stripped of the prefix. Every optional feature
 *  flag is enabled so the full possible tool surface registers. */
function registeredBareNames(): Set<string> {
  const app = { vault: {}, workspace: {}, metadataCache: {} } as unknown as App;
  const server = createObsidianToolServer(
    app,
    /* alwaysLoad     */ true,
    /* memoryWrite    */ true,
    /* askBridge      */ async () => ({}),
    /* memoryRead     */ true,
    /* memoryWriteQueue */ undefined,
    /* orchestrationEnabled */ true,
    /* tasksWriteQueue */ undefined,
    /* agentFolderEnabled */ true,
    /* rethinkBridge  */ async () => ""
  );
  const reg = (server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  return new Set(Object.keys(reg));
}

describe("obsidian tool classifier registries stay in sync with registered tools", () => {
  const registered = registeredBareNames();

  const cases: Array<[string, Set<string>]> = [
    ["OBSIDIAN_READ_TOOLS", OBSIDIAN_READ_TOOLS],
    ["OBSIDIAN_MEMORY_TOOLS", OBSIDIAN_MEMORY_TOOLS],
    ["OBSIDIAN_ORCHESTRATION_TOOLS", OBSIDIAN_ORCHESTRATION_TOOLS],
  ];

  for (const [label, set] of cases) {
    it(`every ${label} entry maps to a registered tool (no drift)`, () => {
      const missing = [...set]
        .map((n) => n.replace(PREFIX, ""))
        .filter((bare) => !registered.has(bare));
      expect(missing, `${label} lists tools not registered on the server: ${missing.join(", ")}`).toEqual([]);
    });
  }

  it("all classifier entries carry the mcp__obsidian__ prefix", () => {
    const all = [...OBSIDIAN_READ_TOOLS, ...OBSIDIAN_MEMORY_TOOLS, ...OBSIDIAN_ORCHESTRATION_TOOLS];
    expect(all.filter((n) => !n.startsWith(PREFIX))).toEqual([]);
  });
});
