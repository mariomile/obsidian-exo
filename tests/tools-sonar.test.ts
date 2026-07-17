import { describe, it, expect } from "vitest";
import { createObsidianToolServer, OBSIDIAN_READ_TOOLS } from "../src/obsidian/tools";

/** Registered tool handlers on the SDK MCP server instance. */
function registeredTools(server: ReturnType<typeof createObsidianToolServer>) {
  return (server.instance as unknown as {
    _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<any> }>;
  })._registeredTools;
}

interface FakeAction {
  id: string;
  title: string;
  source: string;
  destructive: boolean;
}

/** Fake Obsidian App with an optional sonar plugin exposing the action API. */
function fakeApp(opts: { actions?: FakeAction[]; withSonar?: boolean } = {}) {
  const actions = opts.actions ?? [];
  const ranCalls: string[] = [];
  const sonar = {
    getActions: () => actions,
    runAction: async (id: string) => {
      const a = actions.find((x) => x.id === id);
      if (!a) return { ok: false, destructive: false };
      ranCalls.push(id);
      return { ok: true, destructive: a.destructive };
    },
  };
  const app = {
    vault: { getMarkdownFiles: () => [] },
    workspace: { getActiveFile: () => null, activeEditor: undefined },
    metadataCache: {},
    plugins: { plugins: opts.withSonar === false ? {} : { sonar } },
  } as any;
  return { app, ranCalls };
}

function makeServer(app: any) {
  // Read-only construction — the sonar tools are unconditional so this
  // default shape registers them.
  return createObsidianToolServer(app, true, false, undefined, true);
}

const ACTIONS: FakeAction[] = [
  { id: "app:toggle-left-sidebar", title: "Toggle left sidebar", source: "app", destructive: false },
  { id: "app:delete-file", title: "Delete current file", source: "app", destructive: true },
  { id: "sonar:open", title: "Open Sonar", source: "sonar", destructive: false },
];

describe("sonar action tools registration", () => {
  it("registers list_sonar_actions (read) and run_sonar_action (action)", () => {
    const { app } = fakeApp();
    const names = Object.keys(registeredTools(makeServer(app)));
    expect(names).toContain("list_sonar_actions");
    expect(names).toContain("run_sonar_action");
  });

  it("auto-allows list_sonar_actions as read-only but NOT run_sonar_action", () => {
    expect(OBSIDIAN_READ_TOOLS.has("mcp__obsidian__list_sonar_actions")).toBe(true);
    expect(OBSIDIAN_READ_TOOLS.has("mcp__obsidian__run_sonar_action")).toBe(false);
  });
});

describe("list_sonar_actions behavior", () => {
  it("lists every action with source and marks destructive ones", async () => {
    const { app } = fakeApp({ actions: ACTIONS });
    const res = await registeredTools(makeServer(app))["list_sonar_actions"].handler({}, {});
    const text = res.content[0].text as string;
    expect(text).toContain("app:toggle-left-sidebar · Toggle left sidebar (app)");
    expect(text).toContain("app:delete-file · Delete current file (app) ⚠ destructive");
    expect(text).not.toContain("Toggle left sidebar (app) ⚠");
  });

  it("filters case-insensitively over title/id/source", async () => {
    const { app } = fakeApp({ actions: ACTIONS });
    const res = await registeredTools(makeServer(app))["list_sonar_actions"].handler({ query: "SIDEBAR" }, {});
    const text = res.content[0].text as string;
    expect(text).toContain("app:toggle-left-sidebar");
    expect(text).not.toContain("app:delete-file");
  });

  it("reports no matches for an unmatched query", async () => {
    const { app } = fakeApp({ actions: ACTIONS });
    const res = await registeredTools(makeServer(app))["list_sonar_actions"].handler({ query: "zzz" }, {});
    expect(res.content[0].text).toMatch(/No actions match/i);
  });

  it("caps long lists and points at query narrowing", async () => {
    const many: FakeAction[] = Array.from({ length: 90 }, (_, i) => ({
      id: `p:cmd-${i}`,
      title: `Command ${i}`,
      source: "p",
      destructive: false,
    }));
    const { app } = fakeApp({ actions: many });
    const res = await registeredTools(makeServer(app))["list_sonar_actions"].handler({}, {});
    const text = res.content[0].text as string;
    expect(text).toContain("(+10 more — pass query to narrow)");
    expect(text.split("\n").length).toBe(81); // 80 actions + trailer
  });

  it("degrades gracefully when sonar is not enabled", async () => {
    const { app } = fakeApp({ withSonar: false });
    const res = await registeredTools(makeServer(app))["list_sonar_actions"].handler({}, {});
    expect(res.content[0].text).toMatch(/Sonar plugin isn't enabled/i);
  });
});

describe("run_sonar_action behavior", () => {
  it("delegates to sonar.runAction and reports success", async () => {
    const { app, ranCalls } = fakeApp({ actions: ACTIONS });
    const res = await registeredTools(makeServer(app))["run_sonar_action"].handler(
      { id: "app:toggle-left-sidebar" },
      {}
    );
    expect(res.isError).toBeFalsy();
    expect(ranCalls).toEqual(["app:toggle-left-sidebar"]);
  });

  it("notes when the executed action was flagged destructive", async () => {
    const { app } = fakeApp({ actions: ACTIONS });
    const res = await registeredTools(makeServer(app))["run_sonar_action"].handler({ id: "app:delete-file" }, {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/flagged destructive/i);
  });

  it("returns an error for an unknown id without executing", async () => {
    const { app, ranCalls } = fakeApp({ actions: ACTIONS });
    const res = await registeredTools(makeServer(app))["run_sonar_action"].handler({ id: "nope:missing" }, {});
    expect(res.isError).toBe(true);
    expect(ranCalls).toEqual([]);
  });

  it("errors cleanly when sonar is not enabled", async () => {
    const { app } = fakeApp({ withSonar: false });
    const res = await registeredTools(makeServer(app))["run_sonar_action"].handler({ id: "sonar:open" }, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Sonar plugin isn't enabled/i);
  });
});
