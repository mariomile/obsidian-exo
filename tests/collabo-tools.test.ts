import { describe, it, expect } from "vitest";
import {
  buildCollaboTools,
  COLLABO_READ_TOOLS,
  type CollaboToolBridge,
} from "../src/obsidian/collabo-tools";

function fakeBridge(over: Partial<CollaboToolBridge> = {}): CollaboToolBridge {
  return {
    shares: () => [{ path: "Active/Plan.md", slug: "abc123xy", role: "commenter" }],
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
