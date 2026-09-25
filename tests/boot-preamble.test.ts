import { describe, it, expect } from "vitest";
import { TFile } from "obsidian";
import { BootPreambleCache, buildBootPreamble } from "../src/obsidian/memory";
import { memoryCaps, type MemorySettings } from "../src/core/memory-caps";
import { exoPaths } from "../src/core/paths";

const P = exoPaths("_system");

function makeApp(files: Record<string, { content: string; mtime: number }>) {
  let reads = 0;
  const tfile = (path: string) =>
    Object.assign(new TFile(), { path, basename: path.split("/").pop()!.replace(/\.md$/, ""), stat: { mtime: files[path].mtime } });
  const app = {
    vault: {
      getAbstractFileByPath: (p: string) => (files[p] ? tfile(p) : null),
      cachedRead: async (f: TFile) => {
        reads++;
        return files[f.path].content;
      },
      getMarkdownFiles: () => Object.keys(files).map(tfile),
    },
  } as never;
  return { app, files, reads: () => reads };
}

const settings = (over: Partial<MemorySettings> = {}): MemorySettings => ({
  memoryReadEnabled: true,
  memoryWriteEnabled: true,
  agentFolderEnabled: false,
  autoMemory: true,
  backgroundPassesEnabled: true,
  ...over,
});
const caps = (over: Partial<MemorySettings> = {}) => memoryCaps(settings(over), { surface: "chat" });

describe("buildBootPreamble", () => {
  it("is empty when boot reads are off", async () => {
    const { app } = makeApp({ "_system/vault-context.md": { content: "ctx", mtime: 1 } });
    expect(await buildBootPreamble(app, { caps: caps({ memoryReadEnabled: false }), tools: true, paths: P })).toBe("");
  });
  it("adds the automatic-memory note, with recent_chats only when tools are on", async () => {
    const { app } = makeApp({ "_system/vault-context.md": { content: "ctx", mtime: 1 } });
    const withTools = await buildBootPreamble(app, { caps: caps(), tools: true, paths: P });
    const noTools = await buildBootPreamble(app, { caps: caps(), tools: false, paths: P });
    expect(withTools).toContain("### Memory");
    expect(withTools).toContain("recent_chats");
    expect(noTools).toContain("### Memory");
    expect(noTools).not.toContain("recent_chats");
    const off = await buildBootPreamble(app, { caps: caps({ autoMemory: false }), tools: true, paths: P });
    expect(off).not.toContain("### Memory\n");
  });
  it("adds the rethink note only when rethink is granted and tools are on", async () => {
    const { app } = makeApp({ "_system/vault-context.md": { content: "ctx", mtime: 1 } });
    expect(await buildBootPreamble(app, { caps: caps({ agentFolderEnabled: true }), tools: true, paths: P })).toContain("rethink_memory");
    expect(await buildBootPreamble(app, { caps: caps(), tools: true, paths: P })).not.toContain("rethink_memory");
  });
});

describe("BootPreambleCache", () => {
  it("reuses the preamble while its inputs are unchanged", async () => {
    const { app, reads } = makeApp({ "_system/vault-context.md": { content: "ctx", mtime: 1 } });
    const cache = new BootPreambleCache();
    const a = await cache.get(app, { caps: caps(), tools: true, paths: P });
    const n = reads();
    const b = await cache.get(app, { caps: caps(), tools: true, paths: P });
    expect(b).toBe(a);
    expect(reads()).toBe(n);
  });
  it("rebuilds when the caps change", async () => {
    const { app } = makeApp({ "_system/vault-context.md": { content: "ctx", mtime: 1 } });
    const cache = new BootPreambleCache();
    const on = await cache.get(app, { caps: caps(), tools: true, paths: P });
    const off = await cache.get(app, { caps: caps({ autoMemory: false }), tools: true, paths: P });
    expect(on).not.toBe(off);
  });
  it("rebuilds when a source note is edited (mtime) or the memory root moves", async () => {
    const { app, files } = makeApp({ "_system/vault-context.md": { content: "first", mtime: 1 } });
    const cache = new BootPreambleCache();
    expect(await cache.get(app, { caps: caps(), tools: true, paths: P })).toContain("first");
    files["_system/vault-context.md"] = { content: "second", mtime: 2 };
    expect(await cache.get(app, { caps: caps(), tools: true, paths: P })).toContain("second");
    expect(await cache.get(app, { caps: caps(), tools: true, paths: exoPaths("_exo") })).not.toContain("second");
  });
});
