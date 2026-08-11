import { describe, it, expect } from "vitest";
import {
  buildBrowserTools,
  BROWSER_READ_TOOLS,
  BrowserToolRefused,
  type BrowserBridge,
  type BrowserStatus,
} from "../src/obsidian/browser-tools";

const status: BrowserStatus = {
  url: "https://example.com/",
  title: "Example",
  loading: false,
  scrollY: 0,
  scrollHeight: 2000,
  viewportHeight: 800,
  ownerConvoId: "convo-a",
};

function fakeBridge(over: Partial<BrowserBridge> = {}): BrowserBridge {
  return {
    open: async () => status,
    navigate: async () => status,
    snapshot: async () => ({
      status,
      elements: [{ ref: "e1", role: "link", text: "Docs", href: "https://example.com/docs" }],
    }),
    readPage: async () => ({ status, text: "Example body text", total: 17 }),
    screenshot: async () => ({ status, pngB64: "aGVsbG8=" }),
    click: async () => status,
    type: async () => status,
    scroll: async () => status,
    ...over,
  };
}

type Handler = (
  args: unknown,
  extra: unknown,
) => Promise<{
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  isError?: boolean;
}>;
const handlerOf = (bridge: BrowserBridge, name: string): Handler => {
  const t = buildBrowserTools(bridge).find((x) => x.name === name);
  expect(t, name).toBeTruthy();
  return t!.handler as Handler;
};

describe("registration surface", () => {
  it("registers exactly the eight v1 tools", () => {
    expect(
      buildBrowserTools(fakeBridge())
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      "browser_click",
      "browser_navigate",
      "browser_open",
      "browser_read_page",
      "browser_screenshot",
      "browser_scroll",
      "browser_snapshot",
      "browser_type",
    ]);
  });

  it("classifies exactly the three observing tools as read-only", () => {
    expect([...BROWSER_READ_TOOLS].sort()).toEqual([
      "mcp__obsidian__browser_read_page",
      "mcp__obsidian__browser_screenshot",
      "mcp__obsidian__browser_snapshot",
    ]);
  });
});

describe("happy paths", () => {
  it("browser_open returns the status block", async () => {
    const res = await handlerOf(fakeBridge(), "browser_open")({ url: "https://example.com" }, {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("https://example.com/");
  });

  it("browser_snapshot renders the element outline", async () => {
    const res = await handlerOf(fakeBridge(), "browser_snapshot")({}, {});
    expect(res.content[0].text).toContain("e1");
    expect(res.content[0].text).toContain("Docs");
  });

  it("browser_read_page caps and returns the page text under the status", async () => {
    const res = await handlerOf(fakeBridge(), "browser_read_page")({}, {});
    expect(res.content[0].text).toContain("Example body text");
    expect(res.content[0].text).toContain("https://example.com/");
  });

  it("browser_screenshot returns an image block plus a text status", async () => {
    const res = await handlerOf(fakeBridge(), "browser_screenshot")({}, {});
    const [img, txt] = res.content;
    expect(img.type).toBe("image");
    expect(img.data).toBe("aGVsbG8=");
    expect(img.mimeType).toBe("image/png");
    expect(txt.type).toBe("text");
    expect(txt.text).toContain("https://example.com/");
  });

  it("browser_click requires exactly one of ref/selector", async () => {
    const click = handlerOf(fakeBridge(), "browser_click");
    const none = await click({}, {});
    expect(none.isError).toBe(true);
    const both = await click({ ref: "e1", selector: "a" }, {});
    expect(both.isError).toBe(true);
  });

  it("browser_type forwards the target, text and options to the bridge", async () => {
    const seen: unknown[] = [];
    const bridge = fakeBridge({
      type: async (target, text, opts) => {
        seen.push({ target, text, opts });
        return status;
      },
    });
    await handlerOf(bridge, "browser_type")({ ref: "e2", text: "hello", submit: true }, {});
    expect(seen).toEqual([{ target: { ref: "e2" }, text: "hello", opts: { submit: true } }]);
  });

  it("browser_scroll forwards only the options actually passed", async () => {
    const seen: unknown[] = [];
    const bridge = fakeBridge({
      scroll: async (op) => {
        seen.push(op);
        return status;
      },
    });
    await handlerOf(bridge, "browser_scroll")({ to: "bottom" }, {});
    await handlerOf(bridge, "browser_scroll")({ pages: -2 }, {});
    expect(seen).toEqual([{ to: "bottom" }, { pages: -2 }]);
  });
});

describe("refusals are answers, not errors", () => {
  it("a BrowserToolRefused from the bridge becomes a plain ok() message", async () => {
    const bridge = fakeBridge({
      navigate: async () => {
        throw new BrowserToolRefused(
          "The shared browser tab is currently driven by another conversation (convo-x). Call browser_open to take it over.",
        );
      },
    });
    const res = await handlerOf(bridge, "browser_navigate")({ url: "https://example.com" }, {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("convo-x");
  });

  it("an unexpected bridge crash becomes isError", async () => {
    const bridge = fakeBridge({
      snapshot: async () => {
        throw new Error("webview gone");
      },
    });
    const res = await handlerOf(bridge, "browser_snapshot")({}, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("webview gone");
  });

  it("a refusal on the screenshot path degrades to text, never a half image block", async () => {
    const bridge = fakeBridge({
      screenshot: async () => {
        throw new BrowserToolRefused("the browser tab is not visible");
      },
    });
    const res = await handlerOf(bridge, "browser_screenshot")({}, {});
    expect(res.isError).toBeFalsy();
    expect(res.content.map((c) => c.type)).toEqual(["text"]);
    expect(res.content[0].text).toContain("not visible");
  });
});
