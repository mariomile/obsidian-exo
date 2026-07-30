import { describe, it, expect } from "vitest";
import { assembleContext, formatContextDebug } from "./context-assembly";

describe("assembleContext", () => {
  it("returns an empty block when there is no context", () => {
    const r = assembleContext({ paths: [], selection: null, injectContent: false });
    expect(r.block).toBe("");
    expect(r.includedPaths).toEqual([]);
    expect(r.includedSelection).toBe(false);
    expect(r.injectedContentPaths).toEqual([]);
  });

  it("prepends attached notes as a bare-path list (legacy behaviour)", () => {
    const r = assembleContext({ paths: ["A.md", "sub/B.md"], selection: null, injectContent: false });
    expect(r.block).toBe("Context notes:\n- A.md\n- sub/B.md");
    expect(r.includedPaths).toEqual(["A.md", "sub/B.md"]);
    expect(r.injectedContentPaths).toEqual([]);
  });

  // FIX #2: the ambient selection MUST be serialized, not just shown in the UI.
  it("includes the ambient selection as a quoted block", () => {
    const r = assembleContext({
      paths: [],
      selection: { text: "line one\nline two", path: "Notes/Deep.md" },
      injectContent: false,
    });
    expect(r.includedSelection).toBe(true);
    expect(r.selectionChars).toBe("line one\nline two".length);
    // Quoted, attributed to the source note by basename.
    expect(r.block).toContain('Selected text (from "Deep.md"):');
    expect(r.block).toContain("> line one");
    expect(r.block).toContain("> line two");
  });

  it("ignores a whitespace-only selection", () => {
    const r = assembleContext({
      paths: [],
      selection: { text: "   \n  ", path: "X.md" },
      injectContent: false,
    });
    expect(r.includedSelection).toBe(false);
    expect(r.block).toBe("");
  });

  it("combines notes and selection, notes first", () => {
    const r = assembleContext({
      paths: ["A.md"],
      selection: { text: "hi", path: "A.md" },
      injectContent: false,
    });
    const notesIdx = r.block.indexOf("Context notes:");
    const selIdx = r.block.indexOf("Selected text");
    expect(notesIdx).toBeGreaterThanOrEqual(0);
    expect(selIdx).toBeGreaterThan(notesIdx);
  });

  // FIX #1: when injectContent is on, ship the actual note body, not just a path
  // the model has to remember to read.
  it("injects note content when enabled and content is provided", () => {
    const r = assembleContext({
      paths: ["A.md"],
      selection: null,
      injectContent: true,
      contents: { "A.md": "# Title\nbody text" },
    });
    expect(r.injectedContentPaths).toEqual(["A.md"]);
    expect(r.block).toContain('Context note "A.md":');
    expect(r.block).toContain("body text");
    // No bare-path list header when content is inlined.
    expect(r.block).not.toContain("Context notes:\n- A.md");
  });

  it("falls back to a bare path when content is missing for a path", () => {
    const r = assembleContext({
      paths: ["A.md", "B.md"],
      selection: null,
      injectContent: true,
      contents: { "A.md": "body A" },
    });
    expect(r.injectedContentPaths).toEqual(["A.md"]);
    expect(r.block).toContain("body A");
    expect(r.block).toContain("- B.md");
  });
});

describe("formatContextDebug", () => {
  it("renders a structured line showing chips vs what was serialized", () => {
    const assembled = assembleContext({
      paths: ["Nota.md"],
      selection: { text: "lorem ipsum dolor", path: "Nota.md" },
      injectContent: false,
    });
    const out = formatContextDebug({
      turnLabel: "turn#42",
      chips: { doc: "Nota.md", manual: [], selectionChars: 17 },
      assembled,
      outboundBytes: 1204,
    });
    expect(out).toContain("[Exo][ctx] turn#42");
    expect(out).toContain("doc=Nota.md");
    expect(out).toContain("selection");
    expect(out).toContain("SERIALIZED");
    expect(out).toContain("outbound bytes: 1204");
    // The disconnect signal: when the chip shows a selection AND it was
    // serialized, the debug must say so affirmatively.
    expect(out).toMatch(/selection included: yes/i);
  });

  it("flags the disconnect when a chip selection was NOT serialized", () => {
    // Simulate the pre-fix state: chip shows a selection but assembled dropped it.
    const assembled = assembleContext({ paths: ["Nota.md"], selection: null, injectContent: false });
    const out = formatContextDebug({
      turnLabel: "turn#1",
      chips: { doc: "Nota.md", manual: [], selectionChars: 214 },
      assembled,
      outboundBytes: 100,
    });
    expect(out).toMatch(/selection NOT included|selection included: no/i);
  });
});
