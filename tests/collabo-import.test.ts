import { describe, it, expect } from "vitest";
import {
  resolveImport,
  importDocument,
  planInboxImport,
  performImport,
  type ShareDeps,
  type ImportWriteDeps,
} from "../src/obsidian/collabo-commands";
import type { CollaboShare } from "../src/settings-schema";
import type { HttpFn } from "../src/core/collab-bridge";

function deps(shares: Record<string, CollaboShare> = {}): ShareDeps {
  const http: HttpFn = async () => ({
    status: 200,
    json: { markdown: "# Shared\n\nbody", updatedAt: "2026-08-12T10:00:00.000Z" },
  });
  return {
    http,
    cfg: { baseUrl: "https://collabo.test", apiKey: "k" },
    shares,
    save: async () => {},
  };
}

describe("resolveImport", () => {
  it("takes the token straight out of a pasted share link", () => {
    expect(resolveImport(deps(), "https://collabo.test/d/abc123xy?token=tok-9")).toEqual({
      slug: "abc123xy",
      token: "tok-9",
      targetPath: null,
    });
  });

  it("recognises a document this vault already owns and reuses its token", () => {
    const shares = {
      "Active/Plan.md": { slug: "abc123xy", ownerSecret: "o", accessToken: "stored", role: "editor" as const },
    };
    expect(resolveImport(deps(shares), "abc123xy")).toEqual({
      slug: "abc123xy",
      token: "stored",
      targetPath: "Active/Plan.md",
    });
  });

  it("refuses a bare slug it has never seen, because there is no token for it", () => {
    expect(resolveImport(deps(), "neverseen")).toBeNull();
  });

  it("refuses a paste that is not a share link", () => {
    expect(resolveImport(deps(), "https://example.com/some/page")).toBeNull();
  });
});

describe("importDocument", () => {
  it("returns the document markdown and where it belongs", async () => {
    const shares = {
      "Active/Plan.md": { slug: "abc123xy", ownerSecret: "o", accessToken: "stored", role: "editor" as const },
    };
    const out = await importDocument(deps(shares), "abc123xy");
    expect(out.markdown).toBe("# Shared\n\nbody");
    expect(out.targetPath).toBe("Active/Plan.md");
    expect(out.slug).toBe("abc123xy");
  });

  it("reports a document new to this vault with no target path", async () => {
    const out = await importDocument(deps(), "https://collabo.test/d/newdoc?token=t");
    expect(out.targetPath).toBeNull();
    expect(out.slug).toBe("newdoc");
  });

  it("throws on a paste it cannot resolve rather than writing an empty note", async () => {
    await expect(importDocument(deps(), "garbage")).rejects.toThrow();
  });
});

describe("planInboxImport", () => {
  it("creates when nothing sits at the deterministic inbox path yet", () => {
    expect(planInboxImport("newdoc", false)).toEqual({
      path: "_inbox/Collabo newdoc.md",
      mode: "create",
    });
  });

  it("modifies, not creates, on a second import of the same never-before-seen document", () => {
    // Regression: the inbox path is deterministic per slug, so a document
    // imported once as "new" landed at the same path a second import would
    // try to `vault.create` again, which throws on an existing path.
    expect(planInboxImport("newdoc", true)).toEqual({
      path: "_inbox/Collabo newdoc.md",
      mode: "modify",
    });
  });
});

describe("performImport", () => {
  function fsDeps(over: Partial<ImportWriteDeps> = {}): {
    fs: ImportWriteDeps;
    writes: { path: string; markdown: string; mode: "modify" | "create" }[];
    confirmCalls: string[];
  } {
    const writes: { path: string; markdown: string; mode: "modify" | "create" }[] = [];
    const confirmCalls: string[] = [];
    const fs: ImportWriteDeps = {
      fileExists: () => false,
      confirmOverwrite: async (path) => {
        confirmCalls.push(path);
        return true;
      },
      writeFile: async (path, markdown, mode) => {
        writes.push({ path, markdown, mode });
      },
      ...over,
    };
    return { fs, writes, confirmCalls };
  }

  it("creates directly with no confirmation when nothing exists at the inbox path yet", async () => {
    const { fs, writes, confirmCalls } = fsDeps({ fileExists: () => false });
    const outcome = await performImport(fs, { markdown: "# New", targetPath: null, slug: "newdoc" });
    expect(confirmCalls).toHaveLength(0);
    expect(writes).toEqual([{ path: "_inbox/Collabo newdoc.md", markdown: "# New", mode: "create" }]);
    expect(outcome).toEqual({ path: "_inbox/Collabo newdoc.md", mode: "create", written: true });
  });

  it("asks for confirmation before overwriting the note this vault shared FROM", async () => {
    // This is the exact scenario Finding 1 describes: a note shared as
    // editor gets edited both on the server and directly in Obsidian, and
    // nothing but this gate stands between a re-import and silently
    // discarding the local edits.
    const { fs, writes, confirmCalls } = fsDeps({
      fileExists: (path) => path === "Active/Plan.md",
    });
    const outcome = await performImport(fs, {
      markdown: "# Server version",
      targetPath: "Active/Plan.md",
      slug: "abc123xy",
    });
    expect(confirmCalls).toEqual(["Active/Plan.md"]);
    expect(writes).toEqual([{ path: "Active/Plan.md", markdown: "# Server version", mode: "modify" }]);
    expect(outcome).toEqual({ path: "Active/Plan.md", mode: "modify", written: true });
  });

  it("does not write anything when the confirmation is declined", async () => {
    const { fs, writes, confirmCalls } = fsDeps({
      fileExists: (path) => path === "Active/Plan.md",
      confirmOverwrite: async (path) => {
        confirmCalls.push(path);
        return false;
      },
    });
    const outcome = await performImport(fs, {
      markdown: "# Server version",
      targetPath: "Active/Plan.md",
      slug: "abc123xy",
    });
    expect(confirmCalls).toEqual(["Active/Plan.md"]);
    expect(writes).toEqual([]);
    expect(outcome).toEqual({ path: "Active/Plan.md", mode: "modify", written: false });
  });

  it("also gates the inbox path on a second import of the same never-before-seen document", async () => {
    const { fs, writes, confirmCalls } = fsDeps({
      fileExists: (path) => path === "_inbox/Collabo newdoc.md",
    });
    const outcome = await performImport(fs, { markdown: "# Updated", targetPath: null, slug: "newdoc" });
    expect(confirmCalls).toEqual(["_inbox/Collabo newdoc.md"]);
    expect(writes).toEqual([{ path: "_inbox/Collabo newdoc.md", markdown: "# Updated", mode: "modify" }]);
    expect(outcome).toEqual({ path: "_inbox/Collabo newdoc.md", mode: "modify", written: true });
  });

  it("falls back to the inbox path, still gated, when the registered note is gone", async () => {
    const { fs, writes, confirmCalls } = fsDeps({
      fileExists: (path) => path === "_inbox/Collabo abc123xy.md",
    });
    const outcome = await performImport(fs, {
      markdown: "# Server version",
      targetPath: "Active/Deleted.md",
      slug: "abc123xy",
    });
    expect(confirmCalls).toEqual(["_inbox/Collabo abc123xy.md"]);
    expect(outcome.path).toBe("_inbox/Collabo abc123xy.md");
    expect(writes).toHaveLength(1);
  });
});
