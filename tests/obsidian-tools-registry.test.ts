import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import { buildObsidianTools } from "../src/obsidian/tools";

const app = {} as App;
const names = (opts?: Parameters<typeof buildObsidianTools>[1]) =>
  buildObsidianTools(app, opts).map((t) => t.name);

const fakeStatus = {
  url: "u",
  title: "t",
  loading: false,
  scrollY: 0,
  scrollHeight: 0,
  viewportHeight: 0,
  ownerConvoId: null,
};
const fakeBrowserBridge = {
  open: async () => fakeStatus,
  navigate: async () => fakeStatus,
  snapshot: async () => ({ status: fakeStatus, elements: [] }),
  readPage: async () => ({ status: fakeStatus, text: "", total: 0 }),
  screenshot: async () => ({ status: fakeStatus, pngB64: "" }),
  click: async () => fakeStatus,
  type: async () => fakeStatus,
  scroll: async () => fakeStatus,
};

const BROWSER_TOOLS = [
  "browser_open",
  "browser_navigate",
  "browser_snapshot",
  "browser_read_page",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_scroll",
];

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

  it("browser tools register only when a bridge is present, byte-identical otherwise", () => {
    const off = names({});
    for (const t of BROWSER_TOOLS) expect(off, t).not.toContain(t);
    // Pre-feature call shape vs post-feature with no bridge: identical lists.
    expect(names({})).toEqual(names({ browserBridge: undefined }));
    const on = names({ browserBridge: fakeBrowserBridge });
    for (const t of BROWSER_TOOLS) expect(on, t).toContain(t);
    // The bridge adds the browser set and NOTHING else.
    expect(on.filter((n) => !n.startsWith("browser_"))).toEqual(off);
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

describe("ask_user handler contract", () => {
  const QUESTIONS = {
    questions: [
      { question: "Which approach?", header: "Approach", options: [{ label: "A" }, { label: "B" }] },
    ],
  };
  type ToolResult = { isError?: boolean; content: Array<{ text?: string }> };
  const askUserOf = (opts?: Parameters<typeof buildObsidianTools>[1]) => {
    const t = buildObsidianTools(app, opts).find((x) => x.name === "ask_user");
    if (!t) throw new Error("ask_user not registered");
    return t as unknown as { handler: (args: unknown, extra: unknown) => Promise<ToolResult> };
  };

  it("returns the bridge's answers as JSON", async () => {
    const t = askUserOf({ askBridge: async () => ({ Approach: "A" }) });
    const res = await t.handler(QUESTIONS, {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toBe(JSON.stringify({ Approach: "A" }));
  });

  it("degrades to best-judgment guidance when no bridge is wired (headless)", async () => {
    const res = await askUserOf().handler(QUESTIONS, {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toMatch(/best judgment/i);
  });

  it("reports a dismissal (Stop / teardown) as a NORMAL result, never isError", async () => {
    // isError here would poison the Codex turn: the dismissal is guidance to
    // the model ("proceed"), not a failure.
    const t = askUserOf({
      askBridge: async () => {
        throw new Error("cancelled");
      },
    });
    const res = await t.handler(QUESTIONS, {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toMatch(/dismissed/i);
  });
});
