import { describe, it, expect } from "vitest";
import { shareNote, shareOrReuse, docUrl, renameShare, type ShareDeps } from "../src/obsidian/collabo-commands";
import type { CollaboShare } from "../src/settings-schema";
import type { HttpFn, HttpRequest } from "../src/core/collab-bridge";

function deps(shares: Record<string, CollaboShare> = {}) {
  const seen: HttpRequest[] = [];
  let saved = 0;
  const http: HttpFn = async (req) => {
    seen.push(req);
    return {
      status: 200,
      json: {
        success: true,
        slug: "abc123xy",
        shareUrl: "https://collabo.test/d/abc123xy",
        tokenUrl: "https://collabo.test/d/abc123xy?token=tok-9",
        ownerSecret: "owner",
        accessToken: "tok-9",
        accessRole: "commenter",
      },
    };
  };
  const d: ShareDeps = {
    http,
    cfg: { baseUrl: "https://collabo.test", apiKey: "k" },
    shares,
    save: async () => {
      saved += 1;
    },
  };
  return { d, seen, saved: () => saved };
}

describe("shareNote", () => {
  it("creates the document and returns the tokenised link", async () => {
    const { d } = deps();
    const url = await shareNote(d, {
      path: "Active/Plan.md",
      markdown: "# Plan",
      title: "Plan",
      role: "commenter",
    });
    expect(url).toBe("https://collabo.test/d/abc123xy?token=tok-9");
  });

  it("records the share against the note path and persists it", async () => {
    const shares: Record<string, CollaboShare> = {};
    const { d, saved } = deps(shares);
    await shareNote(d, { path: "Active/Plan.md", markdown: "# Plan", title: "Plan", role: "editor" });
    expect(shares["Active/Plan.md"]).toEqual({
      slug: "abc123xy",
      ownerSecret: "owner",
      accessToken: "tok-9",
      role: "commenter",
    });
    expect(saved()).toBe(1);
  });

  it("reuses the existing document instead of creating a second one", async () => {
    const shares: Record<string, CollaboShare> = {
      "Active/Plan.md": { slug: "old-slug", ownerSecret: "o", accessToken: "t", role: "commenter" },
    };
    const { d, seen } = deps(shares);
    const url = await shareNote(d, {
      path: "Active/Plan.md",
      markdown: "# Plan",
      title: "Plan",
      role: "commenter",
    });
    // No create call at all: the note already has a document.
    expect(seen).toHaveLength(0);
    expect(url).toBe("https://collabo.test/d/old-slug?token=t");
    expect(shares["Active/Plan.md"].slug).toBe("old-slug");
  });

  it("sends a deterministic idempotency key derived from the note path", async () => {
    const { d, seen } = deps();
    await shareNote(d, { path: "Active/Plan.md", markdown: "# Plan", title: "Plan", role: "commenter" });
    const first = seen[0].headers["Idempotency-Key"];
    expect(first).toBeTruthy();

    const { d: d2, seen: seen2 } = deps();
    await shareNote(d2, { path: "Active/Plan.md", markdown: "# different content now", title: "Plan 2", role: "editor" });
    // Same note path -> same key, regardless of content/title/role, so a lost
    // response and a retried share cannot create a second document server-side.
    expect(seen2[0].headers["Idempotency-Key"]).toBe(first);

    const { d: d3, seen: seen3 } = deps();
    await shareNote(d3, { path: "Active/Other.md", markdown: "# Plan", title: "Plan", role: "commenter" });
    expect(seen3[0].headers["Idempotency-Key"]).not.toBe(first);
  });
});

describe("shareOrReuse", () => {
  it("never opens the role picker for a note that already has a document", async () => {
    // Regression: collabo-share-note used to always show the role picker,
    // even when re-sharing. shareNote's early return then silently ignored
    // whatever role was picked, so choosing "editor" to upgrade a colleague
    // did nothing and gave no error.
    const shares: Record<string, CollaboShare> = {
      "Active/Plan.md": { slug: "old-slug", ownerSecret: "o", accessToken: "t", role: "commenter" },
    };
    const { d, seen } = deps(shares);
    let pickerOpened = false;
    const url = await shareOrReuse(
      d,
      { path: "Active/Plan.md", markdown: "# Plan", title: "Plan" },
      async () => {
        pickerOpened = true;
        return "editor";
      },
    );
    expect(pickerOpened).toBe(false);
    expect(seen).toHaveLength(0);
    expect(url).toBe("https://collabo.test/d/old-slug?token=t");
  });

  it("opens the role picker and shares when there is a real decision to make", async () => {
    const { d, seen } = deps();
    let pickerOpened = false;
    const url = await shareOrReuse(d, { path: "Active/Plan.md", markdown: "# Plan", title: "Plan" }, async () => {
      pickerOpened = true;
      return "editor";
    });
    expect(pickerOpened).toBe(true);
    expect(seen).toHaveLength(1);
    expect(url).toBe("https://collabo.test/d/abc123xy?token=tok-9");
  });
});

describe("docUrl", () => {
  const cfg = { baseUrl: "https://collabo.test", apiKey: "k" };

  it("builds the recipient link from the scoped token", () => {
    expect(docUrl(cfg, "abc123xy", "tok-9")).toBe("https://collabo.test/d/abc123xy?token=tok-9");
  });

  it("builds the owner link from the owner secret, which is a different link", () => {
    expect(docUrl(cfg, "abc123xy", "owner-secret")).toBe(
      "https://collabo.test/d/abc123xy?token=owner-secret",
    );
  });

  it("does not double the slash when the base url has a trailing one", () => {
    expect(docUrl({ baseUrl: "https://collabo.test/", apiKey: "k" }, "s", "t")).toBe(
      "https://collabo.test/d/s?token=t",
    );
  });
});

describe("renameShare", () => {
  // Regression: collaboShares is keyed by note path with no rename handling,
  // unlike every other path-keyed registry in this codebase (contracts,
  // automations). Renaming a shared note orphaned its registry entry: "Open
  // this note's shared document as owner" silently vanished from the palette
  // because the lookup missed under the new path, and collabo_list_shares
  // kept reporting the dead old path to the agent.
  const entry: CollaboShare = { slug: "abc123xy", ownerSecret: "o", accessToken: "t", role: "editor" };

  it("moves the entry from the old path to the new one", () => {
    const shares = { "Active/Plan.md": entry };
    const moved = renameShare(shares, "Active/Plan.md", "Active/Renamed.md");
    expect(moved).toEqual({ "Active/Renamed.md": entry });
  });

  it("leaves shares alone when the renamed file was never shared", () => {
    const shares = { "Active/Plan.md": entry };
    const moved = renameShare(shares, "Active/Other.md", "Active/Moved.md");
    expect(moved).toBe(shares);
  });

  it("leaves every other entry untouched", () => {
    const other: CollaboShare = { slug: "def456", ownerSecret: "o2", accessToken: "t2", role: "viewer" };
    const shares = { "Active/Plan.md": entry, "Active/Other.md": other };
    const moved = renameShare(shares, "Active/Plan.md", "Active/Renamed.md");
    expect(moved).toEqual({ "Active/Renamed.md": entry, "Active/Other.md": other });
  });
});
