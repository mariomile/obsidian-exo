import { describe, it, expect } from "vitest";
import {
  resolveImport,
  importDocument,
  planInboxImport,
  type ShareDeps,
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
