import { describe, it, expect } from "vitest";
import { createObsidianToolServer } from "../src/obsidian/tools";

/** Registered tool handlers on the SDK MCP server instance. */
function registeredTools(server: ReturnType<typeof createObsidianToolServer>) {
  return (server.instance as unknown as {
    _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<any> }>;
  })._registeredTools;
}

/** Fake Obsidian App with an optional sonar plugin exposing Sonar's declared
 *  cross-plugin API: `search(query, { limit })` → `{ path, title, score, excerpt }[]`. */
function fakeApp(opts: {
  sonarHits?: { path: string; title: string; score: number; excerpt: string }[];
  withSonar?: boolean;
  mdFiles?: { basename: string; path: string; stat: { size: number; mtime: number }; content: string }[];
} = {}) {
  const calls: { query: string; opts: unknown }[] = [];
  const sonar = {
    search: async (query: string, searchOpts: unknown) => {
      calls.push({ query, opts: searchOpts });
      return opts.sonarHits ?? [];
    },
  };
  const files = opts.mdFiles ?? [];
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      cachedRead: async (f: (typeof files)[number]) => f.content,
    },
    workspace: { getActiveFile: () => null, activeEditor: undefined },
    metadataCache: {},
    plugins: { plugins: opts.withSonar === false ? {} : { sonar } },
  } as any;
  return { app, calls };
}

function makeServer(app: any) {
  return createObsidianToolServer(app, { alwaysLoad: true });
}

const BUILDRS = { basename: "Buildrs", path: "Notes/Buildrs.md", stat: { size: 10, mtime: 1 }, content: "Buildrs pipeline notes" };

describe("search_vault — Sonar path", () => {
  it("uses Sonar's public search() when the plugin is loaded", async () => {
    const { app, calls } = fakeApp({
      sonarHits: [{ path: "Notes/Buildrs.md", title: "Buildrs", score: 3.1, excerpt: "Buildrs pipeline notes" }],
    });
    const res = await registeredTools(makeServer(app))["search_vault"].handler({ query: "Buildrs" }, {});
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toBe("Buildrs");
    expect(calls[0].opts).toMatchObject({ limit: 10 });
    const text = res.content[0].text as string;
    expect(text).toContain("[[Notes/Buildrs.md]]");
    expect(text).toContain("Buildrs pipeline notes");
  });

  it("reports no matches without falling back when Sonar returns zero hits", async () => {
    const { app, calls } = fakeApp({ sonarHits: [], mdFiles: [BUILDRS] });
    const res = await registeredTools(makeServer(app))["search_vault"].handler({ query: "zzz" }, {});
    expect(calls).toHaveLength(1);
    expect(res.content[0].text).toMatch(/No matches for "zzz"/);
  });

  it("falls back to the built-in scorer when Sonar is not installed", async () => {
    const { app } = fakeApp({ withSonar: false, mdFiles: [BUILDRS] });
    const res = await registeredTools(makeServer(app))["search_vault"].handler({ query: "Buildrs" }, {});
    expect(res.content[0].text).toContain("[[Notes/Buildrs.md]]");
  });

  it("falls back to the built-in scorer when Sonar's search throws", async () => {
    const { app } = fakeApp({ mdFiles: [BUILDRS] });
    app.plugins.plugins.sonar.search = async () => {
      throw new Error("index not built");
    };
    const res = await registeredTools(makeServer(app))["search_vault"].handler({ query: "Buildrs" }, {});
    expect(res.content[0].text).toContain("[[Notes/Buildrs.md]]");
  });
});
