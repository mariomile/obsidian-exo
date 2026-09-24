import { describe, it, expect } from "vitest";
import { createObsidianToolServer } from "../src/obsidian/tools";

/** Registered tool handlers on the SDK MCP server instance. */
function registeredTools(server: ReturnType<typeof createObsidianToolServer>) {
  return (server.instance as unknown as {
    _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<any> }>;
  })._registeredTools;
}

/** Fake Obsidian App with an optional sonar plugin exposing the search
 *  service shape (`plugin.service.query`, obsidian-sonar's SearchService). */
function fakeApp(opts: {
  sonarHits?: { path: string; basename: string; score: number; docType: string; matched: string[]; excerpt?: { text: string } }[];
  sonarReady?: boolean; // default true when sonar is present
  withSonar?: boolean;
  mdFiles?: { basename: string; path: string; stat: { size: number; mtime: number }; content: string }[];
} = {}) {
  const calls: { query: string; opts: unknown }[] = [];
  const service = {
    query: async (query: string, queryOpts: unknown) => {
      calls.push({ query, opts: queryOpts });
      return opts.sonarHits ?? [];
    },
    getStatus: () => ({ ready: opts.sonarReady !== false }),
  };
  const files = opts.mdFiles ?? [];
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      cachedRead: async (f: (typeof files)[number]) => f.content,
    },
    workspace: { getActiveFile: () => null, activeEditor: undefined },
    metadataCache: {},
    plugins: { plugins: opts.withSonar === false ? {} : { sonar: { service } } },
  } as any;
  return { app, calls };
}

function makeServer(app: any) {
  return createObsidianToolServer(app, true, false, undefined, true);
}

describe("search_vault — Sonar path", () => {
  it("uses Sonar's search service when the plugin is loaded and ready", async () => {
    const { app, calls } = fakeApp({
      sonarHits: [
        { path: "Notes/Buildrs.md", basename: "Buildrs", score: 3.1, docType: "md", matched: ["buildrs"], excerpt: { text: "Buildrs pipeline notes" } },
      ],
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
    const { app, calls } = fakeApp({ sonarHits: [] });
    const res = await registeredTools(makeServer(app))["search_vault"].handler({ query: "zzz" }, {});
    expect(calls).toHaveLength(1);
    expect(res.content[0].text).toMatch(/No matches for "zzz"/);
  });

  it("falls back to the built-in scorer when Sonar is not installed", async () => {
    const { app } = fakeApp({
      withSonar: false,
      mdFiles: [{ basename: "Buildrs", path: "Notes/Buildrs.md", stat: { size: 10, mtime: 1 }, content: "Buildrs pipeline notes" }],
    });
    const res = await registeredTools(makeServer(app))["search_vault"].handler({ query: "Buildrs" }, {});
    expect(res.content[0].text).toContain("[[Notes/Buildrs.md]]");
  });

  it("falls back to the built-in scorer when Sonar's index isn't ready", async () => {
    const { app, calls } = fakeApp({
      sonarReady: false,
      mdFiles: [{ basename: "Buildrs", path: "Notes/Buildrs.md", stat: { size: 10, mtime: 1 }, content: "Buildrs pipeline notes" }],
    });
    const res = await registeredTools(makeServer(app))["search_vault"].handler({ query: "Buildrs" }, {});
    expect(calls).toHaveLength(0); // Sonar never queried — the built-in scorer ran instead
    expect(res.content[0].text).toContain("[[Notes/Buildrs.md]]");
  });

  it("falls back to the built-in scorer when Sonar's query throws", async () => {
    const { app } = fakeApp();
    app.plugins.plugins.sonar.service.query = async () => {
      throw new Error("index not built");
    };
    const mdFile = { basename: "Buildrs", path: "Notes/Buildrs.md", stat: { size: 10, mtime: 1 }, content: "Buildrs pipeline notes" };
    app.vault.getMarkdownFiles = () => [mdFile];
    const res = await registeredTools(makeServer(app))["search_vault"].handler({ query: "Buildrs" }, {});
    expect(res.content[0].text).toContain("[[Notes/Buildrs.md]]");
  });
});
