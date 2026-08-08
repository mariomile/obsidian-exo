import { describe, it, expect } from "vitest";
import { canAutoTitle } from "../src/core/title-ownership";

describe("canAutoTitle", () => {
  it("allows the first-message derivation on an untitled conversation", () => {
    expect(canAutoTitle({ title: "", titleLocked: false }, "first-message")).toBe(true);
  });

  it("treats the literal 'New chat' as untitled", () => {
    // The untitled state is represented inconsistently: some sites leave the
    // title falsy, others write the default string. Both mean untitled.
    expect(canAutoTitle({ title: "New chat", titleLocked: false }, "first-message")).toBe(true);
  });

  it("blocks the first-message derivation once a title exists", () => {
    expect(canAutoTitle({ title: "Drag and drop", titleLocked: false }, "first-message")).toBe(false);
  });

  it("allows an AI title to replace an auto-derived one", () => {
    // The AI title is a REPLACEMENT for the crude first-message slice, so
    // unlike the derivation it may overwrite an existing title.
    expect(canAutoTitle({ title: "Aggiungi il drag and", titleLocked: false }, "ai")).toBe(true);
  });

  it("blocks the AI title on a user-named conversation", () => {
    expect(canAutoTitle({ title: "Sidebar work", titleLocked: true }, "ai")).toBe(false);
  });

  it("blocks the first-message derivation on a user-named conversation", () => {
    expect(canAutoTitle({ title: "", titleLocked: true }, "first-message")).toBe(false);
  });

  it("treats an absent titleLocked as unlocked", () => {
    expect(canAutoTitle({ title: "" }, "first-message")).toBe(true);
  });
});
