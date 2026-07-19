import { describe, it, expect } from "vitest";
import {
  EMPTY_IGNORE_STORE,
  addIgnore,
  removeIgnore,
  isIgnored,
  filterIgnored,
  serializeIgnoreStore,
  parseIgnoreStore,
} from "../src/mentions/store-core";

describe("ignore-list store", () => {
  it("adds and detects an ignore pair scoped to (target, source)", () => {
    const s = addIgnore(EMPTY_IGNORE_STORE, "pricing", "a.md", 1);
    expect(isIgnored(s, "pricing", "a.md")).toBe(true);
    // same target, different source → still surfaced
    expect(isIgnored(s, "pricing", "b.md")).toBe(false);
    // different target, same source → still surfaced
    expect(isIgnored(s, "activation", "a.md")).toBe(false);
  });

  it("is immutable and idempotent", () => {
    const s1 = addIgnore(EMPTY_IGNORE_STORE, "pricing", "a.md", 1);
    const s2 = addIgnore(s1, "pricing", "a.md", 2);
    expect(s2).toBe(s1); // no-op returns same reference
    expect(EMPTY_IGNORE_STORE.entries.length).toBe(0); // input never mutated
  });

  it("removes an ignore pair", () => {
    const s = addIgnore(EMPTY_IGNORE_STORE, "pricing", "a.md", 1);
    expect(isIgnored(removeIgnore(s, "pricing", "a.md"), "pricing", "a.md")).toBe(false);
    expect(removeIgnore(s, "absent", "x.md")).toBe(s); // no-op returns same reference
  });

  it("filters ignored matches out of a result set", () => {
    const store = addIgnore(EMPTY_IGNORE_STORE, "pricing", "a.md", 1);
    const matches = [{ sourcePath: "a.md" }, { sourcePath: "b.md" }];
    expect(filterIgnored(matches, "pricing", store).map((m) => m.sourcePath)).toEqual(["b.md"]);
  });

  it("round-trips through JSON and tolerates corruption", () => {
    const s = addIgnore(EMPTY_IGNORE_STORE, "pricing", "a.md", 1);
    expect(parseIgnoreStore(serializeIgnoreStore(s))).toEqual(s);
    expect(parseIgnoreStore("{ not json")).toEqual(EMPTY_IGNORE_STORE);
    expect(parseIgnoreStore('{"entries":"nope"}')).toEqual(EMPTY_IGNORE_STORE);
    expect(parseIgnoreStore('{"entries":[{"bad":1}]}')).toEqual(EMPTY_IGNORE_STORE);
  });
});
