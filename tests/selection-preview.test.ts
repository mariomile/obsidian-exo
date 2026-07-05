import { describe, it, expect } from "vitest";
import { selectionPreview } from "../src/core/selection-preview";

describe("selectionPreview — label", () => {
  it("short single line → verbatim label", () => {
    expect(selectionPreview("hello world").label).toBe("hello world");
  });
  it("first non-empty line only", () => {
    expect(selectionPreview("\n\n  first line\nsecond").label).toBe("first line");
  });
  it("collapses internal whitespace and trims", () => {
    expect(selectionPreview("\tfoo   bar\t\tbaz  ").label).toBe("foo bar baz");
  });
  it("truncates a long line with an ellipsis at maxLabel", () => {
    const p = selectionPreview("x".repeat(80));
    expect(p.label).toBe("x".repeat(50) + "…");
    expect(p.label.length).toBe(51); // 50 chars + ellipsis
  });
  it("does not truncate at exactly maxLabel", () => {
    expect(selectionPreview("y".repeat(50)).label).toBe("y".repeat(50));
  });
  it("honors a custom maxLabel", () => {
    expect(selectionPreview("abcdefghij", 4).label).toBe("abcd…");
  });
  it("blank / whitespace-only selection → empty label", () => {
    expect(selectionPreview("   \n\t\n  ").label).toBe("");
  });
  it("normalizes CRLF before picking the first line", () => {
    expect(selectionPreview("\r\n\r\nreal\r\nmore").label).toBe("real");
  });
});

describe("selectionPreview — count", () => {
  it("single line reports characters (singular)", () => {
    expect(selectionPreview("a").count).toBe("1 char");
  });
  it("single line reports characters (plural)", () => {
    expect(selectionPreview("hello").count).toBe("5 chars");
  });
  it("multi-line reports line count", () => {
    expect(selectionPreview("one\ntwo\nthree").count).toBe("3 lines");
  });
  it("two lines is plural lines", () => {
    expect(selectionPreview("one\ntwo").count).toBe("2 lines");
  });
  it("char count excludes newlines but a trailing newline still counts a line", () => {
    // "ab\n" → 2 lines (block + empty), so it reports lines
    expect(selectionPreview("ab\n").count).toBe("2 lines");
  });
  it("CRLF counted as a single line break", () => {
    expect(selectionPreview("a\r\nb").count).toBe("2 lines");
  });
});
