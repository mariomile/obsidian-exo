import { describe, it, expect } from "vitest";
import { canAutoTitle, applyRename, looksAutoTitled, SLICE_CAP } from "../src/core/title-ownership";

describe("looksAutoTitled", () => {
  it("treats an empty or whitespace title as auto", () => {
    expect(looksAutoTitled("")).toBe(true);
    expect(looksAutoTitled("   ")).toBe(true);
  });

  it("treats the literal New chat placeholder as auto", () => {
    expect(looksAutoTitled("New chat")).toBe(true);
  });

  it("treats a title cut at exactly the slice cap as auto", () => {
    // The real signal: addUserTurn slices the first user message at 40, so a
    // title of exactly 40 characters is a fragment of a longer sentence.
    expect(looksAutoTitled("a".repeat(SLICE_CAP))).toBe(true);
    expect(looksAutoTitled("Recupero il contesto su quell'idea che a")).toBe(true);
  });

  it("leaves a short authored title alone", () => {
    expect(looksAutoTitled("Sidebar work")).toBe(false);
  });

  it("leaves a title longer than the cap alone", () => {
    // Longer than the cap cannot be a slice of it, so somebody chose it.
    expect(looksAutoTitled("b".repeat(SLICE_CAP + 1))).toBe(false);
  });

  it("ignores surrounding whitespace when measuring", () => {
    expect(looksAutoTitled(`  ${"c".repeat(SLICE_CAP)}  `)).toBe(true);
  });
});

interface TestConvo {
  id: string;
  title: string;
  titleLocked?: boolean;
}

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

describe("applyRename", () => {
  it("rejects a blank title and does not set the lock", () => {
    const c: TestConvo = { id: "1", title: "Old title" };
    const convos = [c];
    expect(applyRename(convos, undefined, "1", "")).toBeNull();
    expect(c.title).toBe("Old title");
    expect(c.titleLocked).toBeUndefined();
  });

  it("rejects a whitespace-only title and does not set the lock", () => {
    const c: TestConvo = { id: "1", title: "Old title" };
    const convos = [c];
    expect(applyRename(convos, undefined, "1", "   ")).toBeNull();
    expect(c.title).toBe("Old title");
    expect(c.titleLocked).toBeUndefined();
  });

  it("returns null for an unknown id", () => {
    const convos: TestConvo[] = [{ id: "1", title: "Old title" }];
    expect(applyRename(convos, undefined, "missing", "New title")).toBeNull();
  });

  it("renames and locks the conversation found by id", () => {
    const c: TestConvo = { id: "1", title: "Old title" };
    const convos = [c];
    const result = applyRename(convos, undefined, "1", "  New title  ");
    expect(result).toBe(c);
    expect(c.title).toBe("New title"); // trimmed
    expect(c.titleLocked).toBe(true);
  });

  it("falls back to active when the id is not yet in convos", () => {
    // A freshly created tab isn't always pushed into `convos` yet (several
    // paths push it lazily) — renaming it must still find it via `active`.
    const active: TestConvo = { id: "fresh", title: "New chat" };
    const result = applyRename([], active, "fresh", "Renamed");
    expect(result).toBe(active);
    expect(active.title).toBe("Renamed");
    expect(active.titleLocked).toBe(true);
  });

  it("returns null, and does not throw, when active is undefined and no convo matches", () => {
    // `this.active` is only assigned inside restore(), itself only reached
    // via `await this.restore()` in onOpen() — before that resolves it is
    // genuinely undefined at runtime despite its `!` type assertion.
    expect(() => applyRename([], undefined, "anything", "Renamed")).not.toThrow();
    expect(applyRename([], undefined, "anything", "Renamed")).toBeNull();
  });
});
