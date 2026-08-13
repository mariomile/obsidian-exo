import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, type CollaboShare } from "../src/settings-schema";

describe("Collabo settings defaults", () => {
  it("ships disabled: no service configured until the user sets one", () => {
    expect(DEFAULT_SETTINGS.collaboUrl).toBe("");
    expect(DEFAULT_SETTINGS.collaboApiKey).toBe("");
  });

  it("starts with an empty share registry", () => {
    expect(DEFAULT_SETTINGS.collaboShares).toEqual({});
  });

  it("types a share entry with everything needed to reach the document again", () => {
    const share: CollaboShare = {
      slug: "abc123xy",
      ownerSecret: "owner",
      accessToken: "tok",
      role: "commenter",
    };
    expect(share.slug).toBe("abc123xy");
  });
});
