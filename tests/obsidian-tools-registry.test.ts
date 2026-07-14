import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import { buildObsidianTools } from "../src/obsidian/tools";

const app = {} as App;
const names = (opts?: Parameters<typeof buildObsidianTools>[1]) =>
  buildObsidianTools(app, opts).map((t) => t.name);

describe("buildObsidianTools", () => {
  it("default build carries the full read+write set, no memory writes off-flag", () => {
    const n = names({ memoryWrite: true, memoryRead: true });
    for (const t of ["search_vault", "read_note", "ask_user", "edit_note", "create_note", "recall", "remember", "open_loop"]) {
      expect(n, t).toContain(t);
    }
  });

  it("memoryWrite=false drops the memory-write tools but keeps recall", () => {
    const n = names({ memoryWrite: false, memoryRead: true });
    for (const t of ["capture_decision", "log_session", "capture_learning", "remember", "open_loop", "close_loop"]) {
      expect(n, t).not.toContain(t);
    }
    expect(n).toContain("recall");
  });

  it("memoryRead=false drops recall", () => {
    expect(names({ memoryRead: false })).not.toContain("recall");
  });

  it("orchestrationEnabled gates add_task", () => {
    expect(names({ orchestrationEnabled: false })).not.toContain("add_task");
    expect(names({ orchestrationEnabled: true })).toContain("add_task");
  });

  it("rethink_memory needs memoryWrite AND agentFolder AND a bridge", () => {
    expect(names({ memoryWrite: true, agentFolderEnabled: true })).not.toContain("rethink_memory");
    expect(
      names({ memoryWrite: true, agentFolderEnabled: true, rethinkBridge: async () => "" })
    ).toContain("rethink_memory");
  });

  it("every tool exposes name, description, inputSchema, handler", () => {
    for (const t of buildObsidianTools(app)) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema).toBeTruthy();
      expect(typeof t.handler).toBe("function");
    }
  });
});
