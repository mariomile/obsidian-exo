import { describe, it, expect } from "vitest";
import {
  createDocument,
  fetchState,
  postOp,
  pendingEvents,
  ackEvents,
  parseShareRef,
  CollaboError,
  type CollaboConfig,
  type HttpFn,
  type HttpRequest,
} from "../src/core/collab-bridge";

const cfg: CollaboConfig = { baseUrl: "https://collabo.test", apiKey: "k-123" };

/** Records every request and replies with a canned response. */
function recorder(res: { status?: number; json?: unknown } = {}) {
  const seen: HttpRequest[] = [];
  const http: HttpFn = async (req) => {
    seen.push(req);
    return { status: res.status ?? 200, json: res.json ?? { success: true } };
  };
  return { http, seen };
}

describe("createDocument", () => {
  it("posts the markdown with the api key and returns the share credentials", async () => {
    const { http, seen } = recorder({
      json: {
        success: true,
        slug: "abc123xy",
        shareUrl: "https://collabo.test/d/abc123xy",
        tokenUrl: "https://collabo.test/d/abc123xy?token=tok-9",
        ownerSecret: "owner-secret",
        accessToken: "tok-9",
        accessRole: "commenter",
      },
    });

    const doc = await createDocument(http, cfg, {
      markdown: "# Plan\n\nShip it.",
      title: "Plan",
      role: "commenter",
    });

    expect(doc.slug).toBe("abc123xy");
    expect(doc.ownerSecret).toBe("owner-secret");
    expect(doc.accessToken).toBe("tok-9");
    expect(doc.accessRole).toBe("commenter");
    // tokenUrl is what a collaborator can actually open without signing in
    expect(doc.shareUrl).toBe("https://collabo.test/d/abc123xy?token=tok-9");

    expect(seen[0].url).toBe("https://collabo.test/documents");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers.Authorization).toBe("Bearer k-123");
    expect(JSON.parse(seen[0].body!)).toEqual({
      markdown: "# Plan\n\nShip it.",
      title: "Plan",
      role: "commenter",
    });
  });

  it("falls back to shareUrl when the service returns no tokenUrl", async () => {
    const { http } = recorder({
      json: {
        success: true,
        slug: "s",
        shareUrl: "https://collabo.test/d/s",
        ownerSecret: "o",
        accessToken: "t",
        accessRole: "editor",
      },
    });
    const doc = await createDocument(http, cfg, { markdown: "x", title: "t", role: "editor" });
    expect(doc.shareUrl).toBe("https://collabo.test/d/s");
  });

  it("throws CollaboError carrying the status on a refusal", async () => {
    const { http } = recorder({ status: 401, json: { error: "UNAUTHORIZED" } });
    await expect(
      createDocument(http, cfg, { markdown: "x", title: "t", role: "editor" }),
    ).rejects.toBeInstanceOf(CollaboError);
  });

  it("trims a trailing slash on the base url instead of doubling it", async () => {
    const { http, seen } = recorder({
      json: { success: true, slug: "s", shareUrl: "u", ownerSecret: "o", accessToken: "t", accessRole: "viewer" },
    });
    await createDocument(http, { baseUrl: "https://collabo.test/", apiKey: "k" }, {
      markdown: "x",
      title: "t",
      role: "viewer",
    });
    expect(seen[0].url).toBe("https://collabo.test/documents");
  });
});

describe("fetchState", () => {
  it("reads markdown and updatedAt with the document token", async () => {
    const { http, seen } = recorder({
      json: { markdown: "# Live\n\nbody", updatedAt: "2026-08-12T10:00:00.000Z" },
    });
    const state = await fetchState(http, cfg, "abc123xy", "tok-9");
    expect(state.markdown).toBe("# Live\n\nbody");
    expect(state.updatedAt).toBe("2026-08-12T10:00:00.000Z");
    expect(seen[0].url).toBe("https://collabo.test/documents/abc123xy/state");
    expect(seen[0].method).toBe("GET");
    expect(seen[0].headers.Authorization).toBe("Bearer tok-9");
  });

  it("reports a missing document as a CollaboError, not an empty note", async () => {
    const { http } = recorder({ status: 404, json: { error: "NOT_FOUND" } });
    await expect(fetchState(http, cfg, "gone", "tok")).rejects.toBeInstanceOf(CollaboError);
  });
});

describe("postOp", () => {
  it("sends the op with an idempotency key so a retry cannot duplicate it", async () => {
    const { http, seen } = recorder();
    await postOp(
      http,
      cfg,
      "abc123xy",
      "tok-9",
      { type: "comment.add", by: "ai:exo", text: "This claim needs a source.", quote: "revenue tripled" },
      "idem-1",
    );
    expect(seen[0].url).toBe("https://collabo.test/documents/abc123xy/ops");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers["Idempotency-Key"]).toBe("idem-1");
    expect(JSON.parse(seen[0].body!)).toEqual({
      type: "comment.add",
      by: "ai:exo",
      text: "This claim needs a source.",
      quote: "revenue tripled",
    });
  });

  it("carries a suggestion op through unchanged", async () => {
    const { http, seen } = recorder();
    await postOp(
      http,
      cfg,
      "s",
      "tok",
      { type: "suggestion.add", by: "ai:exo", kind: "replace", quote: "old", content: "new" },
      "idem-2",
    );
    expect(JSON.parse(seen[0].body!).kind).toBe("replace");
  });
});

describe("pendingEvents / ackEvents", () => {
  it("polls after a cursor and returns the events", async () => {
    const { http, seen } = recorder({
      json: { events: [{ id: 7, type: "suggestion.accept", by: "mario", at: "2026-08-12T11:00:00.000Z" }] },
    });
    const events = await pendingEvents(http, cfg, "s", "tok", 3);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(7);
    expect(events[0].type).toBe("suggestion.accept");
    expect(seen[0].url).toBe("https://collabo.test/documents/s/events/pending?after=3&limit=50");
  });

  it("returns an empty list when the service sends no events array", async () => {
    const { http } = recorder({ json: { ok: true } });
    expect(await pendingEvents(http, cfg, "s", "tok", 0)).toEqual([]);
  });

  it("acks through the last seen id", async () => {
    const { http, seen } = recorder();
    await ackEvents(http, cfg, "s", "tok", 7);
    expect(seen[0].url).toBe("https://collabo.test/documents/s/events/ack");
    expect(JSON.parse(seen[0].body!)).toEqual({ through: 7 });
  });
});

describe("parseShareRef", () => {
  it("reads slug, token and base url out of a pasted share link", () => {
    expect(parseShareRef("https://collabo.test/d/abc123xy?token=tok-9")).toEqual({
      baseUrl: "https://collabo.test",
      slug: "abc123xy",
      token: "tok-9",
    });
  });

  it("accepts a link with no token", () => {
    expect(parseShareRef("https://collabo.test/d/abc123xy")).toEqual({
      baseUrl: "https://collabo.test",
      slug: "abc123xy",
      token: null,
    });
  });

  it("accepts a bare slug and leaves the base url to the caller", () => {
    expect(parseShareRef("abc123xy")).toEqual({ baseUrl: null, slug: "abc123xy", token: null });
  });

  it("rejects a url that is not a share link", () => {
    expect(parseShareRef("https://collabo.test/documents/abc")).toBeNull();
    expect(parseShareRef("")).toBeNull();
    expect(parseShareRef("not a slug at all")).toBeNull();
  });
});
