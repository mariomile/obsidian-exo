import { describe, it, expect } from "vitest";
import {
  SNAPSHOT_SCRIPT,
  STATUS_SCRIPT,
  READ_PAGE_SCRIPT,
  clickScript,
  typeIntoScript,
  scrollScript,
} from "../src/core/browser-inject";

const parses = (src: string) => expect(() => new Function(`return ${src}`), src.slice(0, 80)).not.toThrow();

/**
 * The escaping tests RUN the scripts against a stub page rather than
 * grepping their source. Substring checks cannot prove escaping here:
 * JSON.stringify('"]; window.close()') keeps a real `"` (behind a backslash)
 * right before the `]`, so the hostile sequence is a substring of the SAFE
 * output too. Executing is the only honest gate: if a parameter ever escaped
 * its string literal, `window.close()` would fire and `closed` would flip.
 */
class FakeEvent {
  constructor(
    public type: string,
    public init?: unknown,
  ) {}
}
class FakeTextArea {}
class FakeInput {
  value = "";
  isContentEditable = false;
  focused = false;
  events: string[] = [];
  focus() {
    this.focused = true;
  }
  dispatchEvent(e: FakeEvent) {
    this.events.push(e.type);
    return true;
  }
  closest() {
    return null;
  }
}

function runInFakePage(src: string, element: unknown = null) {
  const seen: { selectors: string[]; closed: boolean } = { selectors: [], closed: false };
  const doc = {
    querySelector: (s: string) => {
      seen.selectors.push(s);
      return element;
    },
  };
  const win = {
    close: () => {
      seen.closed = true;
    },
  };
  const fn = new Function(
    "document",
    "window",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "Event",
    "InputEvent",
    "KeyboardEvent",
    `return ${src}`,
  );
  const out = fn(doc, win, FakeInput, FakeTextArea, FakeEvent, FakeEvent, FakeEvent) as string;
  return { seen, result: JSON.parse(out) as { ok: boolean; reason?: string } };
}

describe("static scripts parse", () => {
  it("snapshot, status and read-page scripts are valid JS", () => {
    parses(SNAPSHOT_SCRIPT);
    parses(STATUS_SCRIPT);
    parses(READ_PAGE_SCRIPT);
  });
});

describe("parameter escaping", () => {
  const hostile = `"]; window.close(); //`;

  it("clickScript embeds hostile selectors as inert string literals", () => {
    const src = clickScript({ selector: hostile });
    parses(src);
    expect(src).toContain(JSON.stringify(hostile));
    const { seen, result } = runInFakePage(src);
    expect(seen.selectors).toEqual([hostile]);
    expect(seen.closed).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("clickScript targets a ref via data-exo-ref", () => {
    const src = clickScript({ ref: "e7" });
    parses(src);
    expect(src).toContain("data-exo-ref");
    expect(src).toContain("e7");
    expect(runInFakePage(src).seen.selectors).toEqual(['[data-exo-ref="e7"]']);
  });

  it("clickScript refuses a ref that itself carries a quote, without escaping", () => {
    const src = clickScript({ ref: `e1"]; window.close(); //` });
    parses(src);
    const { seen } = runInFakePage(src);
    expect(seen.closed).toBe(false);
    expect(seen.selectors).toEqual([`[data-exo-ref="e1\\"]; window.close(); //"]`]);
  });

  it("typeIntoScript embeds hostile text and selector safely", () => {
    const payload = 'pay"load\n`${x}`';
    const src = typeIntoScript({ selector: hostile }, payload, { clear: true, submit: true });
    parses(src);
    expect(src).toContain(JSON.stringify(payload));
    const { seen } = runInFakePage(src);
    expect(seen.selectors).toEqual([hostile]);
    expect(seen.closed).toBe(false);
  });

  it("typeIntoScript writes the exact payload into the element, as data", () => {
    const payload = 'pay"load\n`${x}`';
    const el = new FakeInput();
    const { seen, result } = runInFakePage(typeIntoScript({ ref: "e1" }, payload, { clear: true }), el);
    expect(result.ok).toBe(true);
    expect(el.value).toBe(payload);
    expect(el.focused).toBe(true);
    expect(el.events).toEqual(["input", "change"]);
    expect(seen.closed).toBe(false);
  });

  it("typeIntoScript dispatches input events and honors submit", () => {
    const src = typeIntoScript({ ref: "e1" }, "hi", { submit: true });
    expect(src).toContain('"input"');
    expect(src).toContain("Enter");
    const noSubmit = typeIntoScript({ ref: "e1" }, "hi");
    expect(noSubmit).not.toContain("Enter");
  });

  it("scrollScript coerces pages to a finite number", () => {
    parses(scrollScript({ pages: 2 }));
    parses(scrollScript({ to: "bottom" }));
    const src = scrollScript({ pages: Number.NaN });
    parses(src);
    expect(src).not.toContain("NaN");
  });
});
