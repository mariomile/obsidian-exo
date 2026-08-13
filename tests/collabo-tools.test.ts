import { describe, it, expect } from "vitest";
import {
  buildCollaboTools,
  COLLABO_READ_TOOLS,
  isOwnedShare,
  commentIdempotencyKey,
  suggestionIdempotencyKey,
  type CollaboToolBridge,
} from "../src/obsidian/collabo-tools";

function fakeBridge(over: Partial<CollaboToolBridge> = {}): CollaboToolBridge {
  return {
    shares: () => [{ path: "Active/Plan.md", slug: "abc123xy", role: "commenter", owned: true }],
    read: async () => ({ markdown: "# Shared\n\nbody", updatedAt: "2026-08-12T10:00:00.000Z" }),
    events: async () => [
      { id: 7, type: "suggestion.accept", by: "mario", at: "2026-08-12T11:00:00.000Z" },
    ],
    comment: async () => {},
    suggest: async () => {},
    ...over,
  };
}

type Handler = (args: unknown, extra: unknown) => Promise<{
  content: { type: string; text?: string }[];
  isError?: boolean;
}>;

const handlerOf = (bridge: CollaboToolBridge, name: string): Handler => {
  const t = buildCollaboTools(bridge).find((x) => x.name === name);
  expect(t, name).toBeTruthy();
  return t!.handler as Handler;
};

describe("registration surface", () => {
  it("registers exactly the five v1 tools", () => {
    expect(buildCollaboTools(fakeBridge()).map((t) => t.name).sort()).toEqual([
      "collabo_comment",
      "collabo_events",
      "collabo_list_shares",
      "collabo_read",
      "collabo_suggest",
    ]);
  });

  it("marks only the three observers as auto-allowed reads", () => {
    expect([...COLLABO_READ_TOOLS].sort()).toEqual([
      "mcp__obsidian__collabo_events",
      "mcp__obsidian__collabo_list_shares",
      "mcp__obsidian__collabo_read",
    ]);
  });

  it("exposes no tool that promotes or overwrites: the agent proposes only", () => {
    const names = buildCollaboTools(fakeBridge()).map((t) => t.name);
    expect(names).not.toContain("collabo_accept");
    expect(names).not.toContain("collabo_reject");
    expect(names).not.toContain("collabo_rewrite");
  });

  it("tells the model, in both proposing tools, to name the document when it is not Mario's", () => {
    const tools = buildCollaboTools(fakeBridge());
    for (const name of ["collabo_comment", "collabo_suggest"]) {
      const description = tools.find((t) => t.name === name)!.description;
      expect(description).toMatch(/received from someone else/);
      expect(description).toMatch(/say which document/);
    }
  });
});

describe("collabo_list_shares", () => {
  it("names every shared note with its slug and role", async () => {
    const out = await handlerOf(fakeBridge(), "collabo_list_shares")({}, {});
    expect(out.content[0].text).toContain("Active/Plan.md");
    expect(out.content[0].text).toContain("abc123xy");
    expect(out.content[0].text).toContain("commenter");
  });

  it("says so plainly when nothing is shared", async () => {
    const out = await handlerOf(fakeBridge({ shares: () => [] }), "collabo_list_shares")({}, {});
    expect(out.content[0].text).toMatch(/no shared/i);
  });

  it("marks a document this vault created as yours", async () => {
    const bridge = fakeBridge({
      shares: () => [{ path: "Active/Plan.md", slug: "abc123xy", role: "commenter", owned: true }],
    });
    const out = await handlerOf(bridge, "collabo_list_shares")({}, {});
    expect(out.content[0].text).toContain("yours");
    expect(out.content[0].text).not.toContain("received from someone else");
  });

  it("marks a document merely imported as received from someone else, not yours", async () => {
    const bridge = fakeBridge({
      shares: () => [{ path: "_inbox/Collabo newdoc.md", slug: "newdoc", role: "unknown", owned: false }],
    });
    const out = await handlerOf(bridge, "collabo_list_shares")({}, {});
    expect(out.content[0].text).toContain("received from someone else");
    expect(out.content[0].text).not.toMatch(/\byours\b/);
  });
});

describe("commentIdempotencyKey / suggestionIdempotencyKey", () => {
  // Regression: both used to be `exo-${slug}-${Date.now()}`. A tool-loop
  // retry after a timeout resends the identical comment or suggestion with a
  // fresh timestamp, so the server's own Idempotency-Key dedup — the
  // guarantee in the design doc — never caught the duplicate. Deriving the
  // key from the operation's own fields makes an identical retry produce the
  // identical key regardless of when it happens.

  it("gives an identical retry the identical comment key, with no clock involved", () => {
    const first = commentIdempotencyKey("abc123xy", "Needs a source.", "revenue tripled");
    const second = commentIdempotencyKey("abc123xy", "Needs a source.", "revenue tripled");
    expect(first).toBe(second);
  });

  it("gives a genuinely different comment a different key", () => {
    const a = commentIdempotencyKey("abc123xy", "Needs a source.", "revenue tripled");
    const b = commentIdempotencyKey("abc123xy", "Needs a source.", "revenue doubled");
    expect(a).not.toBe(b);
  });

  it("gives an identical retry the identical suggestion key", () => {
    const first = suggestionIdempotencyKey("abc123xy", "replace", "old", "new");
    const second = suggestionIdempotencyKey("abc123xy", "replace", "old", "new");
    expect(first).toBe(second);
  });

  it("gives a genuinely different suggestion a different key", () => {
    const a = suggestionIdempotencyKey("abc123xy", "replace", "old", "new");
    const b = suggestionIdempotencyKey("abc123xy", "insert", "old", "new");
    expect(a).not.toBe(b);
  });

  it("never collides a comment key with a suggestion key on the same document", () => {
    const comment = commentIdempotencyKey("abc123xy", "same text", "same quote");
    const suggestion = suggestionIdempotencyKey("abc123xy", "replace", "same quote", "same text");
    expect(comment).not.toBe(suggestion);
  });

  // Regression: joining fields with a plain space had no field-boundary
  // marker, so two DIFFERENT comments could hash to the identical joined
  // string: "Fix typo" + "in the intro" and "Fix typo in the" + "intro" both
  // joined to "abc123xy Fix typo in the intro". The server would then treat
  // the second, genuinely different comment as a duplicate of the first.
  it("does not collide when text/quote boundaries shift but the concatenation matches", () => {
    const a = commentIdempotencyKey("abc123xy", "Fix typo", "in the intro");
    const b = commentIdempotencyKey("abc123xy", "Fix typo in the", "intro");
    expect(a).not.toBe(b);
  });

  it("does not collide when suggestion field boundaries shift the same way", () => {
    const a = suggestionIdempotencyKey("abc123xy", "replace", "old text", "here");
    const b = suggestionIdempotencyKey("abc123xy", "replace", "old text here", "");
    expect(a).not.toBe(b);
  });
});

describe("isOwnedShare", () => {
  it("is owned when this vault holds a real owner secret", () => {
    expect(isOwnedShare({ ownerSecret: "owner-secret" })).toBe(true);
  });

  it("is not owned when the owner secret is empty, as it is for an imported document", () => {
    // This is the exact case that regressed: importing a colleague's
    // document used to register it with no ownership signal at all, so the
    // agent's tool surface could not tell it apart from Mario's own shares.
    expect(isOwnedShare({ ownerSecret: "" })).toBe(false);
  });
});

describe("collabo_read", () => {
  it("returns the document markdown", async () => {
    const out = await handlerOf(fakeBridge(), "collabo_read")({ slug: "abc123xy" }, {});
    expect(out.content[0].text).toContain("# Shared");
  });

  it("reports a refusal as an error result instead of throwing", async () => {
    const bridge = fakeBridge({
      read: async () => {
        throw new Error("no access");
      },
    });
    const out = await handlerOf(bridge, "collabo_read")({ slug: "gone" }, {});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("no access");
  });
});

describe("collabo_events", () => {
  it("reports what the humans did, so a rejected suggestion is not retried blindly", async () => {
    const out = await handlerOf(fakeBridge(), "collabo_events")({ slug: "abc123xy" }, {});
    expect(out.content[0].text).toContain("suggestion.accept");
    expect(out.content[0].text).toContain("mario");
  });

  it("says so plainly when nothing has happened since the last check", async () => {
    const out = await handlerOf(fakeBridge({ events: async () => [] }), "collabo_events")(
      { slug: "s" },
      {},
    );
    expect(out.content[0].text).toMatch(/nothing new/i);
  });
});

describe("collabo_comment / collabo_suggest", () => {
  it("passes the comment through to the bridge", async () => {
    const calls: unknown[] = [];
    const bridge = fakeBridge({
      comment: async (slug, text, quote) => {
        calls.push({ slug, text, quote });
      },
    });
    const out = await handlerOf(bridge, "collabo_comment")(
      { slug: "abc123xy", text: "Needs a source.", quote: "revenue tripled" },
      {},
    );
    expect(calls[0]).toEqual({ slug: "abc123xy", text: "Needs a source.", quote: "revenue tripled" });
    expect(out.isError).toBeFalsy();
  });

  it("passes the suggestion through with its kind", async () => {
    const calls: unknown[] = [];
    const bridge = fakeBridge({
      suggest: async (slug, kind, quote, content) => {
        calls.push({ slug, kind, quote, content });
      },
    });
    await handlerOf(bridge, "collabo_suggest")(
      { slug: "s", kind: "replace", quote: "old", content: "new" },
      {},
    );
    expect(calls[0]).toEqual({ slug: "s", kind: "replace", quote: "old", content: "new" });
  });
});
