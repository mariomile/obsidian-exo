import { describe, it, expect } from "vitest";
import { frontmatterDescription, firstBodyLine } from "../src/core/capability-desc";

const fm = (body: string) => `---\n${body}\n---\n\n# Heading\n`;

describe("frontmatterDescription", () => {
  it("reads a single-line description", () => {
    expect(frontmatterDescription(fm("name: foo\ndescription: Does the thing"))).toBe("Does the thing");
  });

  it("strips surrounding quotes", () => {
    expect(frontmatterDescription(fm('description: "Quoted value"'))).toBe("Quoted value");
    expect(frontmatterDescription(fm("description: 'Single quoted'"))).toBe("Single quoted");
  });

  it("joins block-scalar continuation lines (>-, |)", () => {
    expect(frontmatterDescription(fm("description: >-\n  First line\n  second line\nname: foo"))).toBe(
      "First line second line"
    );
    expect(frontmatterDescription(fm("description: |\n  Alpha\n  beta"))).toBe("Alpha beta");
  });

  it("joins indented lines after an empty value", () => {
    expect(frontmatterDescription(fm("description:\n  Wrapped onto\n  the next lines"))).toBe(
      "Wrapped onto the next lines"
    );
  });

  it("returns undefined when the key or frontmatter is missing", () => {
    expect(frontmatterDescription(fm("name: foo"))).toBeUndefined();
    expect(frontmatterDescription("# Just markdown\ndescription: not frontmatter")).toBeUndefined();
    expect(frontmatterDescription(fm("description:"))).toBeUndefined();
  });

  it("tolerates CRLF line endings", () => {
    expect(frontmatterDescription("---\r\ndescription: Windows file\r\n---\r\n")).toBe("Windows file");
  });

  it("ignores an indented (nested) description key", () => {
    expect(frontmatterDescription(fm("meta:\n  description: nested"))).toBeUndefined();
  });
});

describe("firstBodyLine", () => {
  it("returns the first non-empty line of a frontmatter-less file", () => {
    expect(firstBodyLine("Esegui il protocollo di triage.\n\n## Target")).toBe("Esegui il protocollo di triage.");
  });

  it("skips frontmatter and blank lines", () => {
    expect(firstBodyLine("---\nname: x\n---\n\n\nLa prima riga utile.")).toBe("La prima riga utile.");
  });

  it("strips heading and blockquote markers", () => {
    expect(firstBodyLine("# Titolo nota\ncorpo")).toBe("Titolo nota");
    expect(firstBodyLine("> citazione iniziale")).toBe("citazione iniziale");
  });

  it("returns undefined for an empty body", () => {
    expect(firstBodyLine("---\nname: x\n---\n\n  \n")).toBeUndefined();
  });
});
