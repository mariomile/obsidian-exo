import { describe, expect, it } from "vitest";
import type { Editor, EditorPosition } from "obsidian";
import { applyWrapToggle, isWrapActive } from "../src/editor/format/wrap";
import { applyLinePrefixToggle } from "../src/editor/format/line";
import { applyComment } from "../src/editor/format/block";
import { applyClearFormatting, applyLink } from "../src/editor/format/insert";

/** Minimal Editor stand-in: line/offset math + the mutators wrap/line/block use. */
class MockEditor {
  lines: string[];
  from: EditorPosition;
  to: EditorPosition;
  cursor: EditorPosition;

  constructor(text: string, selFrom = 0, selTo?: number) {
    this.lines = text.split("\n");
    const end = selTo ?? selFrom;
    this.from = this.offsetToPos(selFrom);
    this.to = this.offsetToPos(end);
    this.cursor = this.to;
  }

  getValue(): string {
    return this.lines.join("\n");
  }

  posToOffset(p: EditorPosition): number {
    let off = 0;
    for (let i = 0; i < p.line; i++) off += this.lines[i].length + 1;
    return off + p.ch;
  }

  offsetToPos(off: number): EditorPosition {
    let rest = Math.max(0, off);
    for (let i = 0; i < this.lines.length; i++) {
      const len = this.lines[i].length;
      if (rest <= len) return { line: i, ch: rest };
      rest -= len + 1;
    }
    const last = Math.max(0, this.lines.length - 1);
    return { line: last, ch: this.lines[last]?.length ?? 0 };
  }

  getCursor(bound?: "from" | "to" | "head" | "anchor"): EditorPosition {
    if (bound === "from" || bound === "anchor") return { ...this.from };
    if (bound === "to" || bound === "head") return { ...this.to };
    return { ...this.cursor };
  }

  setCursor(pos: EditorPosition): void {
    this.cursor = { ...pos };
    this.from = { ...pos };
    this.to = { ...pos };
  }

  setSelection(from: EditorPosition, to?: EditorPosition): void {
    this.from = { ...from };
    this.to = { ...(to ?? from) };
    this.cursor = { ...this.to };
  }

  getSelection(): string {
    return this.getRange(this.from, this.to);
  }

  getRange(from: EditorPosition, to: EditorPosition): string {
    const a = this.posToOffset(from);
    const b = this.posToOffset(to);
    return this.getValue().slice(Math.min(a, b), Math.max(a, b));
  }

  getLine(n: number): string {
    return this.lines[n] ?? "";
  }

  replaceSelection(replacement: string): void {
    this.replaceRange(replacement, this.from, this.to);
  }

  replaceRange(replacement: string, from: EditorPosition, to?: EditorPosition): void {
    const start = this.posToOffset(from);
    const end = this.posToOffset(to ?? from);
    const next = this.getValue().slice(0, start) + replacement + this.getValue().slice(end);
    this.lines = next.split("\n");
    const head = this.offsetToPos(start + replacement.length);
    this.from = this.offsetToPos(start);
    this.to = head;
    this.cursor = head;
  }

  somethingSelected(): boolean {
    return this.posToOffset(this.from) !== this.posToOffset(this.to);
  }
}

function ed(text: string, from: number, to?: number): Editor {
  return new MockEditor(text, from, to) as unknown as Editor;
}

describe("applyWrapToggle", () => {
  it("wraps a bare selection", () => {
    const e = ed("hello world", 0, 5);
    applyWrapToggle(e, "**");
    expect((e as unknown as MockEditor).getValue()).toBe("**hello** world");
    expect(e.getSelection()).toBe("hello");
  });

  it("unwraps markers inside the selection", () => {
    const e = ed("**hello** world", 0, 9);
    applyWrapToggle(e, "**");
    expect((e as unknown as MockEditor).getValue()).toBe("hello world");
    expect(e.getSelection()).toBe("hello");
  });

  it("unwraps markers sitting just outside the selection", () => {
    const e = ed("**hello** world", 2, 7);
    applyWrapToggle(e, "**");
    expect((e as unknown as MockEditor).getValue()).toBe("hello world");
    expect(e.getSelection()).toBe("hello");
  });

  it("inserts a pair around an empty caret", () => {
    const e = ed("ab", 1, 1);
    applyWrapToggle(e, "`");
    expect((e as unknown as MockEditor).getValue()).toBe("a``b");
  });
});

describe("isWrapActive", () => {
  it("is true when the selection contains the markers", () => {
    expect(isWrapActive(ed("**hi**", 0, 6), "**")).toBe(true);
  });
  it("is true when the markers flank the selection", () => {
    expect(isWrapActive(ed("**hi**", 2, 4), "**")).toBe(true);
  });
  it("is false for unmarked text", () => {
    expect(isWrapActive(ed("hello", 0, 5), "**")).toBe(false);
  });
});

describe("applyLinePrefixToggle", () => {
  it("adds a heading prefix and keeps the line selected", () => {
    const e = ed("Title", 0, 5);
    applyLinePrefixToggle(e, { match: /^#{1,6}\s/, prefix: "# ", exclusive: true });
    expect((e as unknown as MockEditor).getValue()).toBe("# Title");
  });

  it("strips the prefix when already present", () => {
    const e = ed("# Title", 0, 7);
    applyLinePrefixToggle(e, { match: /^#{1,6}\s/, prefix: "# ", exclusive: true });
    expect((e as unknown as MockEditor).getValue()).toBe("Title");
  });

  it("replaces a competing exclusive prefix", () => {
    const e = ed("> Title", 0, 7);
    applyLinePrefixToggle(e, { match: /^#{1,6}\s/, prefix: "## ", exclusive: true });
    expect((e as unknown as MockEditor).getValue()).toBe("## Title");
  });
});

describe("applyComment", () => {
  it("wraps then unwraps", () => {
    const e = ed("note", 0, 4);
    applyComment(e);
    expect((e as unknown as MockEditor).getValue()).toBe("%% note %%");
    applyComment(e);
    expect((e as unknown as MockEditor).getValue()).toBe("note");
  });
});

describe("applyLink", () => {
  it("wraps as markdown link and selects the url placeholder", () => {
    const e = ed("docs", 0, 4);
    applyLink(e);
    expect((e as unknown as MockEditor).getValue()).toBe("[docs](url)");
    expect(e.getSelection()).toBe("url");
  });
});

describe("applyClearFormatting", () => {
  it("strips wrap markers and a heading prefix", () => {
    const e = ed("# **hello**", 0, 11);
    applyClearFormatting(e);
    expect((e as unknown as MockEditor).getValue()).toBe("hello");
  });
});
