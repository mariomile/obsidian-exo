import { describe, it, expect } from "vitest";
import {
  isAllowedUrl,
  formatStatus,
  formatSnapshot,
  capPageText,
  PAGE_TEXT_CAP,
  SNAPSHOT_ELEMENT_CAP,
  type BrowserPageStatus,
  type PageElement,
} from "../src/core/browser-page";

const status: BrowserPageStatus = {
  url: "https://example.com/pricing",
  title: "Pricing: Example",
  loading: false,
  scrollY: 0,
  scrollHeight: 4000,
  viewportHeight: 900,
};

describe("isAllowedUrl", () => {
  it("accepts https and http", () => {
    expect(isAllowedUrl("https://example.com")).toEqual({ ok: true, url: "https://example.com/" });
    expect(isAllowedUrl("http://example.com/a?b=1")).toEqual({ ok: true, url: "http://example.com/a?b=1" });
  });

  it("prefixes https:// for scheme-less input", () => {
    const res = isAllowedUrl("example.com/docs");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.url).toBe("https://example.com/docs");
  });

  it("refuses non-http(s) schemes, naming the scheme", () => {
    for (const bad of ["file:///etc/passwd", "obsidian://open?vault=x", "javascript:alert(1)", "app://local/x"]) {
      const res = isAllowedUrl(bad);
      expect(res.ok, bad).toBe(false);
    }
  });

  it("refuses embedded credentials and garbage", () => {
    expect(isAllowedUrl("https://user:pass@example.com").ok).toBe(false);
    expect(isAllowedUrl("not a url at all %%%").ok).toBe(false);
  });
});

describe("formatStatus", () => {
  it("names url, title, and scroll position", () => {
    const out = formatStatus(status);
    expect(out).toContain("https://example.com/pricing");
    expect(out).toContain("Pricing: Example");
    expect(out).toMatch(/scroll/i);
  });

  it("marks a still-loading page", () => {
    expect(formatStatus({ ...status, loading: true })).toMatch(/loading/i);
  });
});

describe("formatSnapshot", () => {
  const el = (over: Partial<PageElement> & { ref: string }): PageElement => ({
    role: "link",
    text: "t",
    ...over,
  });

  it("renders refs, roles, text, and link targets", () => {
    const out = formatSnapshot(status, [
      el({ ref: "e1", role: "heading", text: "Plans", level: 1 }),
      el({ ref: "e2", role: "link", text: "Contact", href: "https://example.com/contact" }),
      el({ ref: "e3", role: "input", text: "Email", value: "x@y.z" }),
      el({ ref: "e4", role: "button", text: "Buy", disabled: true }),
    ]);
    expect(out).toContain("e1");
    expect(out).toContain("Plans");
    expect(out).toContain("https://example.com/contact");
    expect(out).toContain("x@y.z");
    expect(out).toMatch(/disabled/);
  });

  it("caps the element list and says how many were cut", () => {
    const many = Array.from({ length: SNAPSHOT_ELEMENT_CAP + 30 }, (_, i) =>
      el({ ref: `e${i + 1}`, text: `link ${i + 1}` }),
    );
    const out = formatSnapshot(status, many);
    expect(out).not.toContain(`e${SNAPSHOT_ELEMENT_CAP + 1} `);
    expect(out).toContain("30 more");
  });

  it("says so when the page exposed no interactive elements", () => {
    expect(formatSnapshot(status, [])).toMatch(/no interactive elements/i);
  });
});

describe("capPageText", () => {
  it("returns short text unchanged", () => {
    expect(capPageText("hello", 5)).toBe("hello");
  });

  it("caps long text and names the shown/total sizes", () => {
    const out = capPageText("x".repeat(PAGE_TEXT_CAP + 5000), PAGE_TEXT_CAP + 5000);
    expect(out.length).toBeLessThanOrEqual(PAGE_TEXT_CAP + 120);
    expect(out).toContain(String(PAGE_TEXT_CAP));
  });
});
