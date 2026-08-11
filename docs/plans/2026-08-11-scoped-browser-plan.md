# Agent Browser: Shared, Session-Scoped Browser Tab (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Exo agent a real, visible browser tab inside the Obsidian workspace: a `<webview>` leaf the user and the agent share. The agent can open a source in front of Mario, read it, click, type, scroll and screenshot it, instead of a blind WebFetch. Research-first: evidence value is that Mario sees what the agent saw.

**Architecture:** Modeled on T3 Code's collaborative browser tab, adapted to Exo's no-server world: everything runs in the Obsidian renderer. One global workspace leaf (`exo-browser`) hosts one Electron `<webview>` on a persistent partition. A plugin-level controller owns a conversation **lease** (T3's host-assignment idea, radically simplified): mutating tools require the lease, reading tools do not, and takeover happens only through `browser_open`, which the human ratifies via its permission card. Eight `browser_*` tools ride the existing per-convo `obsidian` MCP server through a `BrowserBridge` closure, exactly like `askBridge`/`rethinkBridge`. All new logic lives in pure `src/core/` modules with unit tests; `view.ts`/`main.ts` get wiring only (and `main.ts` gets **zero** lines, by design, because it is at its ratchet ceiling).

**Tech Stack:** TypeScript, Obsidian plugin API, Electron `<webview>` tag (renderer-side, no main-process access beyond best-effort `require("electron").remote`), `@anthropic-ai/claude-agent-sdk` (`tool` + `createSdkMcpServer`), zod, vitest.

## Design decisions (each final, with rationale)

- **Surface: one global leaf + a conversation lease, not one leaf per conversation.** The user is one human who can watch one tab; N parallel visible browsers multiply workspace clutter and fragment logins across partitions for zero research value. T3 needed multi-tab because multiple remote threads drive one desktop; Exo's conversations all live in front of the same person. The lease (owner convo id, in memory, no clock; T3 learned the hard way that expiring leases migrate live flows) prevents two conversations interleaving a multi-step interaction. View type string is `exo-browser` and, like `exo-connections`, **never changes** once shipped (workspace-persistent).
- **Tool set v1: 8 tools, research-first.** `browser_open`, `browser_navigate`, `browser_snapshot`, `browser_read_page`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_scroll`. Deliberately absent vs T3's 14: `evaluate` (arbitrary JS in the page is the single riskiest tool and research does not need it), `press` (folded into `browser_type`'s `submit`), `wait_for` (navigate/click already settle-wait; a re-snapshot covers dynamic content), `resize`/`set_appearance`/`recording` (dev-preview features, out of scope per YAGNI), `status` (every tool already returns status).
- **Scoping: per-convo bridge closure on the existing tool server.** `browserBridgeFor(plugin, convoId)` returns a `BrowserBridge` bound to the conversation (or `undefined` when the feature is off or on mobile, which unregisters the tools entirely). Mutations check the lease and refuse with an explanatory message naming the owner; reads never need the lease (looking at the shared tab disturbs nobody). Headless runs get no bridge: a non-interactive run must not drive a surface whose whole point is that Mario watches it.
- **Permission posture:** `browser_snapshot`, `browser_read_page`, `browser_screenshot` go into `OBSIDIAN_READ_TOOLS` (auto-allowed under `autoAllowRead`, same reasoning as `list_tasks`: they write nothing and observe only). `browser_open`, `browser_navigate`, `browser_click`, `browser_type`, `browser_scroll` stay out: each raises the standard permission card whose input (URL, selector, text) **is** the evidence trail, and per-convo "always allow" covers a research session after the first approval.
- **Security (the riskiest part, so explicit):** single persistent partition `persist:exo-agent-browser` (logins survive restarts, useful for paywalled sources; per-convo partitions buy nothing when the tab is shared). Webview created with `partition` set **before** DOM attach, `webpreferences="contextIsolation=yes,sandbox=yes"`, no `nodeintegration`, no `allowpopups` (so `window.open` is inert). Best-effort main-session hardening via `require("electron").remote`: deny-all permission request+check handlers (Electron's default with NO handler is **grant**), and `will-download` → `preventDefault()` (no downloads, v1). URL gate: http/https only, no embedded credentials, enforced in a pure function before every navigation. `executeJavaScript` results are capped at 64 KB (T3's number) and every injected script embeds parameters exclusively via `JSON.stringify`. No tool evaluates agent-supplied JS.
- **Screenshot return path:** MCP image content block. The vendored `@modelcontextprotocol/sdk` `CallToolResult` accepts `{ type: "image", data: <base64>, mimeType }` (verified in `node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts`, `ImageContentSchema`), and Exo's UI-side `stringifyToolResult` (`src/providers/claude.ts:754`) maps non-text blocks to `""` so the tool card shows only the text part, safe. Image is downscaled to ≤1024 px width before PNG-encoding to bound tokens. Whether the Claude Code CLI forwards MCP image blocks to the model is a flagged seam with a defined fallback (see Known unverified seams).
- **Gating:** new setting `browserEnabled`, default **OFF** (same contract as `orchestrationEnabled`): when false, the tool list sent to sessions is **byte-identical** to before this feature existed, enforced by test. The session signature (`sessionSigOf`) includes the flag so flipping it respawns tools correctly.

## Global Constraints

- Test runner: `pnpm test` (vitest). Typecheck: `pnpm typecheck`. Lint: `pnpm lint`. Full gate: `pnpm release:check`.
- ⚠️ `pnpm build` **deploys `main.js` into Mario's live vault** (`.obsidian-plugin-dir`) and `release:check` includes it. Run neither until the final verification task, and never reload the plugin while a turn is in flight.
- New logic goes in pure modules under `src/core/` with **no Obsidian imports**. `src/view.ts` and `src/main.ts` get thin wiring only.
- Size ratchets (`tests/size-contract.test.ts`), verified 2026-08-11: `view.ts` **6600/6600** (zero headroom), `main.ts` **3480/3480** (zero headroom), `settings.ts` 1338/1340 (2 lines). Consequences baked into this plan: `main.ts` receives **zero new lines** (controller uses a WeakMap accessor; view registration goes through the un-ratcheted `ui/view-registry.ts`); `settings.ts` does the extraction its own ratchet comment sanctions (schema → new file) in Task 6; `view.ts` wiring is paid for by the `formatDate`/`formatRelative` extraction in Task 10. **Never raise a ceiling.** Re-verify counts with `wc -l` before editing; they may have moved since this plan was written.
- Style contract (`src/style-contract.test.ts`): no `!important`, no raw hex outside tokens; new classes use the `mva-browser-` prefix; controls are the house `mv-*`/`mva-*` primitives (divs, never bare `<button>` for chips/icon buttons); **no emoji** anywhere in UI or tool text.
- The webview partition string `persist:exo-agent-browser` and the view type `exo-browser` are workspace/disk-persistent: fix them now, never rename.
- Injected page scripts embed every parameter via `JSON.stringify`; no string concatenation of raw agent input into JS.
- Commit after each task, staging explicit paths only. `docs/` plans are gitignored: stage them with `git add -f`.

---

### Task 1: Browser lease (pure)

**Files:**
- Create: `src/core/browser-lease.ts`
- Test: `tests/browser-lease.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `interface BrowserLease { ownerConvoId: string; acquiredAt: number }`
  - `acquireLease(current: BrowserLease | null, convoId: string, now: number): { lease: BrowserLease; tookOverFrom?: string }`
  - `checkLease(current: BrowserLease | null, convoId: string): { ok: true } | { ok: false; reason: string }`
  - `releaseLease(current: BrowserLease | null, convoId: string): BrowserLease | null`

- [ ] **Step 1: Write the failing test**

Create `tests/browser-lease.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { acquireLease, checkLease, releaseLease, type BrowserLease } from "../src/core/browser-lease";

describe("acquireLease", () => {
  it("grants a fresh lease when nobody holds one", () => {
    const { lease, tookOverFrom } = acquireLease(null, "convo-a", 1000);
    expect(lease).toEqual({ ownerConvoId: "convo-a", acquiredAt: 1000 });
    expect(tookOverFrom).toBeUndefined();
  });

  it("re-acquiring your own lease refreshes it without a takeover", () => {
    const current: BrowserLease = { ownerConvoId: "convo-a", acquiredAt: 1000 };
    const { lease, tookOverFrom } = acquireLease(current, "convo-a", 2000);
    expect(lease.acquiredAt).toBe(2000);
    expect(tookOverFrom).toBeUndefined();
  });

  it("takes over another conversation's lease and names it", () => {
    const current: BrowserLease = { ownerConvoId: "convo-a", acquiredAt: 1000 };
    const { lease, tookOverFrom } = acquireLease(current, "convo-b", 2000);
    expect(lease.ownerConvoId).toBe("convo-b");
    expect(tookOverFrom).toBe("convo-a");
  });
});

describe("checkLease", () => {
  it("refuses when nobody holds the lease, pointing at browser_open", () => {
    const res = checkLease(null, "convo-a");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("browser_open");
  });

  it("allows the owner", () => {
    expect(checkLease({ ownerConvoId: "convo-a", acquiredAt: 1 }, "convo-a")).toEqual({ ok: true });
  });

  it("refuses a non-owner, naming the owner and the takeover path", () => {
    const res = checkLease({ ownerConvoId: "convo-a", acquiredAt: 1 }, "convo-b");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("convo-a");
      expect(res.reason).toContain("browser_open");
    }
  });
});

describe("releaseLease", () => {
  it("clears the lease for its owner and is a no-op for anyone else", () => {
    const lease: BrowserLease = { ownerConvoId: "convo-a", acquiredAt: 1 };
    expect(releaseLease(lease, "convo-a")).toBeNull();
    expect(releaseLease(lease, "convo-b")).toBe(lease);
    expect(releaseLease(null, "convo-a")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/browser-lease.test.ts`
Expected: FAIL (cannot resolve `../src/core/browser-lease`).

- [ ] **Step 3: Write minimal implementation**

Create `src/core/browser-lease.ts`:

```typescript
/**
 * Browser lease: the pure ownership rule for the shared agent-browser tab
 * (no Obsidian imports).
 *
 * One visible tab, many conversations: without a lease, two convos driving it
 * concurrently would interleave multi-step interactions (T3 Code solved the
 * same problem with a host-assignment lease). Exo's version is deliberately
 * minimal: the lease is in-memory, has NO expiry clock (an expiring lease can
 * migrate a live flow mid-interaction), and changes hands ONLY through
 * `browser_open`, which raises a permission card, so the human ratifies every
 * takeover. Reads never need the lease; only mutations do.
 */

export interface BrowserLease {
  ownerConvoId: string;
  acquiredAt: number;
}

/** Grant (or refresh) the lease for `convoId`. Taking it from another
 *  conversation is allowed by design: `tookOverFrom` lets the caller say so. */
export function acquireLease(
  current: BrowserLease | null,
  convoId: string,
  now: number
): { lease: BrowserLease; tookOverFrom?: string } {
  const tookOverFrom =
    current && current.ownerConvoId !== convoId ? current.ownerConvoId : undefined;
  return {
    lease: { ownerConvoId: convoId, acquiredAt: now },
    ...(tookOverFrom ? { tookOverFrom } : {}),
  };
}

/** Whether `convoId` may MUTATE the shared tab right now. The refusal reason is
 *  written for the model: it is an answer, not an error to retry. */
export function checkLease(
  current: BrowserLease | null,
  convoId: string
): { ok: true } | { ok: false; reason: string } {
  if (!current) {
    return {
      ok: false,
      reason:
        "No browser session is open for this conversation yet. Call browser_open first.",
    };
  }
  if (current.ownerConvoId === convoId) return { ok: true };
  return {
    ok: false,
    reason:
      `The shared browser tab is currently driven by another conversation (${current.ownerConvoId}). ` +
      "Call browser_open to take it over; the tab is shared, so taking over interrupts that conversation's flow. " +
      "Reading tools (browser_snapshot, browser_read_page, browser_screenshot) work without taking over.",
  };
}

/** Drop the lease if `convoId` owns it; anyone else's release is a no-op. */
export function releaseLease(current: BrowserLease | null, convoId: string): BrowserLease | null {
  if (current && current.ownerConvoId === convoId) return null;
  return current;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/browser-lease.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/browser-lease.ts tests/browser-lease.test.ts
git commit -m "feat(browser): pure conversation lease for the shared browser tab"
```

---

### Task 2: Page model, URL gate, status and snapshot formatting (pure)

**Files:**
- Create: `src/core/browser-page.ts`
- Test: `tests/browser-page.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface BrowserPageStatus { url: string; title: string; loading: boolean; scrollY: number; scrollHeight: number; viewportHeight: number }`
  - `interface PageElement { ref: string; role: string; text: string; href?: string; value?: string; level?: number; disabled?: boolean }`
  - `PAGE_TEXT_CAP = 20_000`, `SNAPSHOT_ELEMENT_CAP = 120`
  - `isAllowedUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string }`
  - `formatStatus(s: BrowserPageStatus): string`
  - `formatSnapshot(status: BrowserPageStatus, elements: PageElement[]): string`
  - `capPageText(text: string, totalLen: number): string`

- [ ] **Step 1: Write the failing test**

Create `tests/browser-page.test.ts`:

```typescript
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
      el({ ref: `e${i + 1}`, text: `link ${i + 1}` })
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/browser-page.test.ts`
Expected: FAIL (cannot resolve `../src/core/browser-page`).

- [ ] **Step 3: Write minimal implementation**

Create `src/core/browser-page.ts`:

```typescript
/**
 * Browser page model: pure formatting and validation for the agent browser
 * (no Obsidian imports, no DOM).
 *
 * The impure host executes scripts inside the webview and hands raw records
 * back; THIS module decides what a status line says, how a snapshot outline
 * reads to the model, how page text is capped, and which URLs are allowed at
 * all. Keeping it pure is what makes the riskiest feature in the plugin
 * testable without a browser.
 */

export interface BrowserPageStatus {
  url: string;
  title: string;
  loading: boolean;
  scrollY: number;
  scrollHeight: number;
  viewportHeight: number;
}

/** One interactive/semantic element surfaced by the snapshot script. `ref` is
 *  the `data-exo-ref` stamped on the live element: valid until the next
 *  navigation or snapshot re-stamp. */
export interface PageElement {
  ref: string;
  role: string;
  text: string;
  href?: string;
  value?: string;
  level?: number;
  disabled?: boolean;
}

/** Longest extracted page text handed to the model. */
export const PAGE_TEXT_CAP = 20_000;
/** Max elements rendered in one snapshot outline. */
export const SNAPSHOT_ELEMENT_CAP = 120;

/**
 * The one URL gate for every navigation. http/https only: file://, obsidian://,
 * app:// and javascript: would let web-driving reach local files or the app
 * itself. Scheme-less input gets https:// prefixed (agent convenience);
 * embedded credentials are refused outright.
 */
export function isAllowedUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return { ok: false, reason: `Not a valid URL: ${raw}` };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return {
      ok: false,
      reason: `Only http(s) pages can be opened in the agent browser (got ${u.protocol.replace(/:$/, "")}).`,
    };
  }
  if (u.username || u.password) {
    return { ok: false, reason: "URLs with embedded credentials are refused." };
  }
  if (!u.hostname) return { ok: false, reason: `Not a valid URL: ${raw}` };
  return { ok: true, url: u.toString() };
}

/** Human/model-readable status block, returned by every browser tool. */
export function formatStatus(s: BrowserPageStatus): string {
  const bottom = Math.min(s.scrollY + s.viewportHeight, s.scrollHeight);
  const pct = s.scrollHeight > 0 ? Math.round((bottom / s.scrollHeight) * 100) : 100;
  return [
    `url: ${s.url}`,
    `title: ${s.title || "(untitled)"}`,
    ...(s.loading ? ["(still loading: snapshot again if content looks incomplete)"] : []),
    `scroll: ${Math.round(s.scrollY)}–${Math.round(bottom)} of ${Math.round(s.scrollHeight)}px (${pct}% seen)`,
  ].join("\n");
}

function elementLine(e: PageElement): string {
  const role = e.role === "heading" && e.level ? `heading#${e.level}` : e.role;
  const bits = [`- ${e.ref} [${role}] "${e.text}"`];
  if (e.value) bits.push(`value="${e.value}"`);
  if (e.href) bits.push(`→ ${e.href}`);
  if (e.disabled) bits.push("(disabled)");
  return bits.join(" ");
}

/** Snapshot outline: status header + one line per element, capped. Refs are the
 *  handles browser_click / browser_type accept. */
export function formatSnapshot(status: BrowserPageStatus, elements: PageElement[]): string {
  const head = formatStatus(status);
  if (!elements.length) {
    return `${head}\n\nNo interactive elements found on the visible page. Use browser_read_page for the text, or browser_scroll and snapshot again.`;
  }
  const shown = elements.slice(0, SNAPSHOT_ELEMENT_CAP);
  const cut = elements.length - shown.length;
  const tail = cut > 0 ? `\n(+${cut} more elements not shown: scroll or narrow the page first)` : "";
  return `${head}\n\nElements (use ref with browser_click / browser_type):\n${shown.map(elementLine).join("\n")}${tail}`;
}

/** Cap extracted page text for the model, naming what was cut. */
export function capPageText(text: string, totalLen: number): string {
  if (text.length <= PAGE_TEXT_CAP) return text;
  return (
    text.slice(0, PAGE_TEXT_CAP) +
    `\n… [truncated: showing ${PAGE_TEXT_CAP} of ${totalLen} chars: the page is long; use browser_snapshot to find anchors, or ask for a specific section]`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/browser-page.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/browser-page.ts tests/browser-page.test.ts
git commit -m "feat(browser): pure URL gate, status and snapshot formatting"
```

---

### Task 3: Injected page scripts (pure builders)

**Files:**
- Create: `src/core/browser-inject.ts`
- Test: `tests/browser-inject.test.ts`

**Interfaces:**
- Consumes: `SNAPSHOT_ELEMENT_CAP` idea only (its own in-page cap is separate).
- Produces:
  - `interface ElementTarget { ref?: string; selector?: string }`
  - `SNAPSHOT_SCRIPT: string`, `STATUS_SCRIPT: string`, `READ_PAGE_SCRIPT: string`
  - `clickScript(target: ElementTarget): string`
  - `typeIntoScript(target: ElementTarget, text: string, opts?: { clear?: boolean; submit?: boolean }): string`
  - `scrollScript(op: { to?: "top" | "bottom"; pages?: number }): string`
  - Every script is a self-contained IIFE returning a **JSON string**; action scripts return `{ ok: boolean; reason?: string }`.

- [ ] **Step 1: Write the failing test**

Create `tests/browser-inject.test.ts`. The tests assert two things that actually break in production: the scripts are syntactically valid JS (checked with `new Function`, which parses without executing), and adversarial parameters cannot escape their string literals.

```typescript
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
    expect(src).not.toContain('"]; window.close()');
  });

  it("clickScript targets a ref via data-exo-ref", () => {
    const src = clickScript({ ref: "e7" });
    parses(src);
    expect(src).toContain("data-exo-ref");
    expect(src).toContain("e7");
  });

  it("typeIntoScript embeds hostile text and selector safely", () => {
    const src = typeIntoScript({ selector: hostile }, 'pay"load\n`${x}`', { clear: true, submit: true });
    parses(src);
    expect(src).toContain(JSON.stringify('pay"load\n`${x}`'));
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/browser-inject.test.ts`
Expected: FAIL (cannot resolve `../src/core/browser-inject`).

- [ ] **Step 3: Write minimal implementation**

Create `src/core/browser-inject.ts`:

```typescript
/**
 * Injected page scripts: the strings the browser host runs inside the
 * webview's page world via `executeJavaScript` (no Obsidian imports).
 *
 * Contract: every script is a self-contained IIFE that returns a JSON STRING
 * (never an object; structured-clone quirks across the guest boundary are not
 * our problem if only strings cross it). Action scripts return
 * `{ ok, reason? }`. Every parameter is embedded via JSON.stringify: agent
 * input can never escape a string literal, which the escaping tests pin down.
 */

export interface ElementTarget {
  ref?: string;
  selector?: string;
}

/** In-page element cap: the pure formatter caps again at SNAPSHOT_ELEMENT_CAP. */
const IN_PAGE_MAX = 200;

/** JS expression resolving the target element (or null). */
function findExpr(t: ElementTarget): string {
  const selector = t.ref ? `[data-exo-ref=${JSON.stringify(t.ref)}]` : (t.selector ?? "");
  return `document.querySelector(${JSON.stringify(selector)})`;
}

export const STATUS_SCRIPT = `(() => JSON.stringify({
  scrollY: Math.round(window.scrollY),
  scrollHeight: Math.round(document.documentElement.scrollHeight),
  viewportHeight: Math.round(window.innerHeight),
}))()`;

export const SNAPSHOT_SCRIPT = `(() => {
  const out = [];
  let n = 0;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = window.getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const label = (el) => {
    const t = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.title || "").trim();
    return t.replace(/\\s+/g, " ").slice(0, 80);
  };
  const roleOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textarea";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return t === "checkbox" || t === "radio" ? t : "input";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    return el.getAttribute("role") || "other";
  };
  const els = document.querySelectorAll(
    'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="menuitem"], h1, h2, h3'
  );
  for (const el of els) {
    if (n >= ${IN_PAGE_MAX}) break;
    if (!visible(el)) continue;
    const text = label(el);
    const role = roleOf(el);
    if (!text && role !== "input" && role !== "textarea" && role !== "select") continue;
    const ref = "e" + (++n);
    el.setAttribute("data-exo-ref", ref);
    const rec = { ref, role, text };
    if (role === "link" && el.href) rec.href = String(el.href).slice(0, 200);
    if (role === "heading") rec.level = Number(el.tagName[1]);
    if (el.disabled) rec.disabled = true;
    if ((role === "input" || role === "textarea") && el.value) rec.value = String(el.value).slice(0, 80);
    out.push(rec);
  }
  return JSON.stringify(out);
})()`;

export const READ_PAGE_SCRIPT = `(() => {
  const main = document.querySelector("main, article, [role='main']") || document.body;
  const all = (main && main.innerText) || "";
  return JSON.stringify({ text: all.slice(0, 60000), total: all.length });
})()`;

export function clickScript(target: ElementTarget): string {
  return `(() => {
  try {
    const el = ${findExpr(target)};
    if (!el) return JSON.stringify({ ok: false, reason: "no element matched: take a fresh browser_snapshot" });
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.click();
    return JSON.stringify({ ok: true });
  } catch (e) {
    return JSON.stringify({ ok: false, reason: String((e && e.message) || e) });
  }
})()`;
}

export function typeIntoScript(
  target: ElementTarget,
  text: string,
  opts: { clear?: boolean; submit?: boolean } = {}
): string {
  const submitBlock = opts.submit
    ? `
    const key = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13 };
    el.dispatchEvent(new KeyboardEvent("keydown", key));
    el.dispatchEvent(new KeyboardEvent("keyup", key));
    const form = el.closest && el.closest("form");
    if (form && typeof form.requestSubmit === "function") form.requestSubmit();`
    : "";
  return `(() => {
  try {
    const el = ${findExpr(target)};
    if (!el) return JSON.stringify({ ok: false, reason: "no element matched: take a fresh browser_snapshot" });
    el.focus();
    const text = ${JSON.stringify(text)};
    const clear = ${JSON.stringify(!!opts.clear)};
    if (el.isContentEditable) {
      if (clear) el.textContent = "";
      el.textContent += text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      const next = clear ? text : (el.value || "") + text;
      if (desc && desc.set) desc.set.call(el, next); else el.value = next;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }${submitBlock}
    return JSON.stringify({ ok: true });
  } catch (e) {
    return JSON.stringify({ ok: false, reason: String((e && e.message) || e) });
  }
})()`;
}

export function scrollScript(op: { to?: "top" | "bottom"; pages?: number }): string {
  const pages = Number.isFinite(op.pages) ? Number(op.pages) : 1;
  return `(() => {
  const to = ${JSON.stringify(op.to ?? null)};
  if (to === "top") window.scrollTo(0, 0);
  else if (to === "bottom") window.scrollTo(0, document.documentElement.scrollHeight);
  else window.scrollBy(0, Math.round(window.innerHeight * 0.85 * ${pages}));
  return JSON.stringify({ ok: true });
})()`;
}
```

Note: inside the template literals, `\\s` is intentional: it must reach the page as `\s`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/browser-inject.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/browser-inject.ts tests/browser-inject.test.ts
git commit -m "feat(browser): injected page scripts with JSON-escaped parameters"
```

---

### Task 4: The eight `browser_*` tools against a `BrowserBridge`

**Files:**
- Create: `src/obsidian/browser-tools.ts`
- Test: `tests/browser-tools.test.ts`

**Interfaces:**
- Consumes: `formatStatus`, `formatSnapshot`, `capPageText`, `isAllowedUrl`, `PageElement`, `BrowserPageStatus` (Task 2); `ElementTarget` (Task 3, type only).
- Produces:
  - `interface BrowserStatus extends BrowserPageStatus { ownerConvoId: string | null }`
  - `class BrowserToolRefused extends Error`: expected-traffic refusals (lease, unsupported platform, invalid URL); tools surface `e.message` as a normal `ok()` result so the model reads an answer, not a retryable failure (same pattern as `ChildTaskRefused`).
  - `interface BrowserBridge` with methods `open(url?)`, `navigate(url)`, `snapshot()`, `readPage()`, `screenshot()`, `click(target)`, `type(target, text, opts)`, `scroll(op)` (exact signatures in the code below).
  - `buildBrowserTools(bridge: BrowserBridge): SdkMcpToolDefinition<any>[]` (the 8 tools).
  - `BROWSER_READ_TOOLS: Set<string>` (full `mcp__obsidian__` names of the 3 read tools).

- [ ] **Step 1: Write the failing test**

Create `tests/browser-tools.test.ts`:

```typescript
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
    snapshot: async () => ({ status, elements: [{ ref: "e1", role: "link", text: "Docs", href: "https://example.com/docs" }] }),
    readPage: async () => ({ status, text: "Example body text", total: 17 }),
    screenshot: async () => ({ status, pngB64: "aGVsbG8=" }),
    click: async () => status,
    type: async () => status,
    scroll: async () => status,
    ...over,
  };
}

type Handler = (args: unknown, extra: unknown) => Promise<{ content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean }>;
const handlerOf = (bridge: BrowserBridge, name: string): Handler => {
  const t = buildBrowserTools(bridge).find((x) => x.name === name);
  expect(t, name).toBeTruthy();
  return t!.handler as Handler;
};

describe("registration surface", () => {
  it("registers exactly the eight v1 tools", () => {
    expect(buildBrowserTools(fakeBridge()).map((t) => t.name).sort()).toEqual([
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
});

describe("refusals are answers, not errors", () => {
  it("a BrowserToolRefused from the bridge becomes a plain ok() message", async () => {
    const bridge = fakeBridge({
      navigate: async () => {
        throw new BrowserToolRefused("The shared browser tab is currently driven by another conversation (convo-x). Call browser_open to take it over.");
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/browser-tools.test.ts`
Expected: FAIL (cannot resolve `../src/obsidian/browser-tools`).

- [ ] **Step 3: Write minimal implementation**

Create `src/obsidian/browser-tools.ts`:

```typescript
/**
 * Agent-browser tools: the eight `browser_*` tool definitions for the shared,
 * visible browser tab (see docs/plans/2026-08-11-scoped-browser-plan.md).
 *
 * This module is deliberately Obsidian-free at runtime: it depends only on the
 * `BrowserBridge` interface, which the plugin's browser controller implements
 * per conversation (`browserBridgeFor`). That keeps the tool surface testable
 * with a fake bridge and mirrors the askBridge/rethinkBridge pattern:
 * tools.ts must never import view or controller code.
 */
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { ok, err } from "./tool-kit";
import {
  capPageText,
  formatSnapshot,
  formatStatus,
  type BrowserPageStatus,
  type PageElement,
} from "../core/browser-page";
import type { ElementTarget } from "../core/browser-inject";

/** Bridge-level status: page state plus who holds the lease. */
export interface BrowserStatus extends BrowserPageStatus {
  ownerConvoId: string | null;
}

/** Expected-traffic refusal (lease held elsewhere, feature unsupported here,
 *  URL rejected). Tools surface the message as a normal result so the model
 *  reads an answer instead of retrying, same contract as ChildTaskRefused. */
export class BrowserToolRefused extends Error {}

/** What the plugin-side controller implements, curried per conversation. */
export interface BrowserBridge {
  open(url?: string): Promise<BrowserStatus>;
  navigate(url: string): Promise<BrowserStatus>;
  snapshot(): Promise<{ status: BrowserStatus; elements: PageElement[] }>;
  readPage(): Promise<{ status: BrowserStatus; text: string; total: number }>;
  screenshot(): Promise<{ status: BrowserStatus; pngB64: string }>;
  click(target: ElementTarget): Promise<BrowserStatus>;
  type(target: ElementTarget, text: string, opts: { clear?: boolean; submit?: boolean }): Promise<BrowserStatus>;
  scroll(op: { to?: "top" | "bottom"; pages?: number }): Promise<BrowserStatus>;
}

/** Route bridge failures: refusals read as answers, crashes read as errors. */
async function run(fn: () => Promise<ReturnType<typeof ok>>): Promise<ReturnType<typeof ok>> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BrowserToolRefused) return ok(e.message);
    return err(e instanceof Error ? e.message : String(e));
  }
}

/** Exactly one of ref/selector, as an ElementTarget, or an error string. */
function targetOf(args: { ref?: string; selector?: string }): ElementTarget | string {
  if (!!args.ref === !!args.selector) {
    return "Pass exactly one of `ref` (from browser_snapshot) or `selector` (CSS).";
  }
  return args.ref ? { ref: args.ref } : { selector: args.selector! };
}

export function buildBrowserTools(bridge: BrowserBridge): SdkMcpToolDefinition<any>[] {
  const browserOpen = tool(
    "browser_open",
    "Open the shared agent-browser tab in the workspace (creating it if needed) and take control of it for this conversation. Use it to research a source IN FRONT of Mario; he sees the same page you read, which beats a blind web fetch whenever the source matters. Optionally pass a url to navigate immediately. If another conversation was driving the tab, this takes over (say so).",
    { url: z.string().optional().describe("http(s) URL to open right away.") },
    async (args) =>
      run(async () => {
        const status = await bridge.open(args.url);
        return ok(formatStatus(status));
      })
  );

  const browserNavigate = tool(
    "browser_navigate",
    "Navigate the shared browser tab to a URL (http/https only) and wait for the page to settle. Requires having called browser_open in this conversation first.",
    { url: z.string() },
    async (args) =>
      run(async () => {
        const status = await bridge.navigate(args.url);
        return ok(formatStatus(status));
      })
  );

  const browserSnapshot = tool(
    "browser_snapshot",
    "Inspect the current page before interacting: returns URL, title, scroll position, and an outline of visible interactive elements (links, buttons, inputs, headings), each with a ref you can pass to browser_click / browser_type. Refs go stale on navigation: snapshot again after the page changes.",
    {},
    async () =>
      run(async () => {
        const { status, elements } = await bridge.snapshot();
        return ok(formatSnapshot(status, elements));
      })
  );

  const browserReadPage = tool(
    "browser_read_page",
    "Read the current page's visible text (main content when the page marks one, else the whole body), capped for length. This is the workhorse for research: navigate, then read.",
    {},
    async () =>
      run(async () => {
        const { status, text, total } = await bridge.readPage();
        return ok(`${formatStatus(status)}\n\n---\n${capPageText(text, total)}`);
      })
  );

  const browserScreenshot = tool(
    "browser_screenshot",
    "Capture the visible page as an image, so you can see the page exactly as Mario does (layout, figures, charts). Use it when the visual matters or the text extraction looks wrong.",
    {},
    async () =>
      run(async () => {
        const { status, pngB64 } = await bridge.screenshot();
        return {
          content: [
            { type: "image" as const, data: pngB64, mimeType: "image/png" as const },
            { type: "text" as const, text: formatStatus(status) },
          ],
        };
      })
  );

  const browserClick = tool(
    "browser_click",
    "Click one element in the shared browser tab, by ref (preferred, from browser_snapshot) or CSS selector. Requires the browser lease (browser_open).",
    { ref: z.string().optional(), selector: z.string().optional() },
    async (args) =>
      run(async () => {
        const target = targetOf(args);
        if (typeof target === "string") return err(target);
        const status = await bridge.click(target);
        return ok(formatStatus(status));
      })
  );

  const browserType = tool(
    "browser_type",
    "Type text into one input/textarea/contenteditable in the shared browser tab, by ref or CSS selector. `clear` replaces existing content; `submit` presses Enter and submits the enclosing form (search boxes). Requires the browser lease.",
    {
      ref: z.string().optional(),
      selector: z.string().optional(),
      text: z.string(),
      clear: z.boolean().optional(),
      submit: z.boolean().optional(),
    },
    async (args) =>
      run(async () => {
        const target = targetOf(args);
        if (typeof target === "string") return err(target);
        const status = await bridge.type(target, args.text, {
          ...(args.clear !== undefined ? { clear: args.clear } : {}),
          ...(args.submit !== undefined ? { submit: args.submit } : {}),
        });
        return ok(formatStatus(status));
      })
  );

  const browserScroll = tool(
    "browser_scroll",
    "Scroll the shared browser tab: `to` top/bottom, or `pages` viewport-heights down (negative scrolls up; default 1). Requires the browser lease.",
    {
      to: z.enum(["top", "bottom"]).optional(),
      pages: z.number().optional(),
    },
    async (args) =>
      run(async () => {
        const status = await bridge.scroll({
          ...(args.to ? { to: args.to } : {}),
          ...(args.pages !== undefined ? { pages: args.pages } : {}),
        });
        return ok(formatStatus(status));
      })
  );

  return [
    browserOpen,
    browserNavigate,
    browserSnapshot,
    browserReadPage,
    browserScreenshot,
    browserClick,
    browserType,
    browserScroll,
  ];
}

/** The observing tools: they change nothing Mario sees and write nothing, so
 *  they ride the same auto-allow rail as list_tasks. Everything else raises a
 *  permission card whose input (URL, selector, text) is the evidence trail. */
export const BROWSER_READ_TOOLS = new Set([
  "mcp__obsidian__browser_snapshot",
  "mcp__obsidian__browser_read_page",
  "mcp__obsidian__browser_screenshot",
]);
```

Note: the screenshot handler returns a `CallToolResult` literal (image + text blocks) rather than the text-only `Result` from `tool-kit.ts`; the SDK's `tool()` handler type accepts any `CallToolResult`, so no widening of the shared kit. If `run`'s return type fights the image literal, type `run` as `Promise<CallToolResult>` (import the type from `@modelcontextprotocol/sdk/types.js` via the same path `sdk.d.ts` uses): do not loosen `tool-kit.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/browser-tools.test.ts && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/obsidian/browser-tools.ts tests/browser-tools.test.ts
git commit -m "feat(browser): eight browser_* tools against the BrowserBridge seam"
```

---

### Task 5: Registration in tools.ts, read-set, byte-identical gating

**Files:**
- Modify: `src/obsidian/tools.ts` (`ObsidianToolOpts.browserBridge`, registration spread, `createObsidianToolServer` trailing param, `OBSIDIAN_READ_TOOLS` additions)
- Modify: `tests/obsidian-tools-registry.test.ts` (gating), `tests/tool-registries.test.ts` (classifier sync)

**Interfaces:**
- Consumes: `buildBrowserTools`, `BROWSER_READ_TOOLS`, `BrowserBridge` (Task 4).
- Produces: `ObsidianToolOpts.browserBridge?: BrowserBridge`; `createObsidianToolServer(..., parentConvoId?, browserBridge?)`; browser names inside `OBSIDIAN_READ_TOOLS`.

- [ ] **Step 1: Write the failing tests**

In `tests/obsidian-tools-registry.test.ts`, add (reusing the file's `names` helper and a minimal fake bridge):

```typescript
  it("browser tools register only when a bridge is present, byte-identical otherwise", () => {
    const off = names({});
    for (const t of ["browser_open", "browser_navigate", "browser_snapshot", "browser_read_page", "browser_screenshot", "browser_click", "browser_type", "browser_scroll"]) {
      expect(off, t).not.toContain(t);
    }
    // Pre-feature call shape vs post-feature with no bridge: identical lists.
    expect(names({})).toEqual(names({ browserBridge: undefined }));
    const bridge = {
      open: async () => fakeStatus, navigate: async () => fakeStatus,
      snapshot: async () => ({ status: fakeStatus, elements: [] }),
      readPage: async () => ({ status: fakeStatus, text: "", total: 0 }),
      screenshot: async () => ({ status: fakeStatus, pngB64: "" }),
      click: async () => fakeStatus, type: async () => fakeStatus, scroll: async () => fakeStatus,
    };
    const on = names({ browserBridge: bridge });
    for (const t of ["browser_open", "browser_snapshot", "browser_screenshot"]) expect(on).toContain(t);
  });
```

with, near the top of the file:

```typescript
const fakeStatus = { url: "u", title: "t", loading: false, scrollY: 0, scrollHeight: 0, viewportHeight: 0, ownerConvoId: null };
```

In `tests/tool-registries.test.ts`, the sync test asserts every name in the classifier Sets is actually registered, so `registeredBareNames()` must now build the fullest surface **including** a browser bridge. Add a fake bridge (same literal as above) and pass it as the new trailing argument of the `createObsidianToolServer` call in that helper. Do NOT weaken the assertion direction.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/obsidian-tools-registry.test.ts tests/tool-registries.test.ts`
Expected: FAIL (`browserBridge` not a known option; browser names absent).

- [ ] **Step 3: Write minimal implementation**

In `src/obsidian/tools.ts`:

1. Import at the top:

```typescript
import { buildBrowserTools, type BrowserBridge } from "./browser-tools";
```

2. Add to `ObsidianToolOpts` (after `parentConvoId`):

```typescript
  /** Per-convo bridge to the shared agent-browser tab. Absent → the browser_*
   *  tools are not registered at all (feature off, mobile, or headless run):
   *  the tool list must stay byte-identical to before the feature existed. */
  browserBridge?: BrowserBridge;
```

3. Destructure it in `buildObsidianTools` beside `parentConvoId` (`browserBridge,`; no default).

4. Extend the registration return, after the orchestration spreads:

```typescript
    ...(browserBridge ? buildBrowserTools(browserBridge) : []),
```

5. Append the trailing positional param to `createObsidianToolServer` (after `parentConvoId`, same trailing-param convention documented there) and thread it into the `buildObsidianTools` opts:

```typescript
  parentConvoId?: string,
  // Shared agent-browser bridge: trailing for the same reason as parentConvoId.
  browserBridge?: BrowserBridge
```

and inside the `tools:` opts object: `browserBridge,`.

6. Extend `OBSIDIAN_READ_TOOLS` (before the `...CAPABILITY_READ_TOOLS` spread):

```typescript
  // Browser observers: they change nothing on the page or in the vault. The
  // interacting tools (open/navigate/click/type/scroll) are deliberately NOT
  // here: their permission card, showing the URL/selector, is the evidence
  // trail for what the agent did in a shared, visible surface.
  ...BROWSER_READ_TOOLS,
```

adding `BROWSER_READ_TOOLS` to the import from `./browser-tools`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/obsidian-tools-registry.test.ts tests/tool-registries.test.ts tests/tools-add-task.test.ts tests/tools-annotations.test.ts && pnpm typecheck`
Expected: PASS (the existing positional call sites are unaffected; the new param is optional and trailing).

- [ ] **Step 5: Commit**

```bash
git add src/obsidian/tools.ts tests/obsidian-tools-registry.test.ts tests/tool-registries.test.ts
git commit -m "feat(tools): register browser_* behind the bridge, classify the read set"
```

---

### Task 6: `browserEnabled` setting (schema extraction first)

`settings.ts` is 2 lines under its ratchet, and its own ceiling comment names the sanctioned move: extract the schema. Do that first, then add the flag.

**Files:**
- Create: `src/settings-schema.ts` (moved `MVASettings` + `DEFAULT_SETTINGS`)
- Modify: `src/settings.ts` (imports/re-exports; new toggle in the tab that hosts the Orchestration Board section)
- Modify: `tests/size-contract.test.ts` (LOWER the `settings.ts` ceiling to the new count + ~8)

**Interfaces:**
- Consumes: nothing new.
- Produces: `MVASettings.browserEnabled: boolean` (default `false`), re-exported from `./settings` so the ~6 existing importers (`main.ts`, `headless.ts`, `queue.ts`, `session-caps-cache.ts`, …) do not change.

- [ ] **Step 1: Extract the schema (mechanical, no behavior change)**

Move the block from `src/settings.ts` (the `LEGACY_QUEUE_FOLDER` const, the whole `export interface MVASettings { … }` and the whole `export const DEFAULT_SETTINGS: MVASettings = { … }` (currently ~lines 14–327)) into a new `src/settings-schema.ts`, carrying exactly the imports that block needs (verify by typecheck; expected: `ProviderId`/`PermissionMode` from `./providers/types`, `AutomationConfig` from `./core/automations`, `initialDailyPulseReviewState`/`DailyPulseReviewState` from `./core/daily-pulse`, `exoPaths`/`LEGACY_MEMORY_ROOT` from `./core/paths`). Header comment for the new file:

```typescript
/**
 * Exo settings schema: the MVASettings shape and its defaults, extracted from
 * settings.ts per its size-ratchet plan (the tab renders settings; the schema
 * IS settings). settings.ts re-exports both so external importers keep their
 * `from "./settings"` path.
 */
```

In `src/settings.ts`, replace the moved block with:

```typescript
import { DEFAULT_SETTINGS, type MVASettings } from "./settings-schema";
export { DEFAULT_SETTINGS, type MVASettings };
```

and delete the imports the tab no longer uses (typecheck + lint tell you which).

- [ ] **Step 2: Verify no behavior change, then ratchet down**

Run: `pnpm typecheck && pnpm vitest run`
Expected: all green with zero test edits. Then `wc -l src/settings.ts`, and in `tests/size-contract.test.ts` lower the `"src/settings.ts"` ceiling to that count + 8, with a comment dated 2026-08-11 explaining the extraction (mirror the tone of the existing entries; the +8 is declared margin, not regrowth permission). Run `pnpm vitest run tests/size-contract.test.ts`: green.

- [ ] **Step 3: Add the flag and its toggle**

In `src/settings-schema.ts`, add to `MVASettings` after `agentsEnabled`:

```typescript
  /** Agent browser master flag, default OFF, desktop only. Gates the eight
   *  `browser_*` tools and the exo-browser leaf's live mode. When false the
   *  session tool list is byte-identical to before the feature existed. */
  browserEnabled: boolean;
```

and to `DEFAULT_SETTINGS`: `browserEnabled: false,`.

In `src/settings.ts`, after the Orchestration Board block (anchor: the `this.toggleSetting(el, "Enable orchestration", …, "orchestrationEnabled")` call and its following "Max concurrent tasks" Setting), add:

```typescript
    new Setting(el).setName("Agent browser").setHeading();
    this.toggleSetting(
      el,
      "Enable agent browser",
      "Gives the agent a real, visible browser tab inside Obsidian (desktop only): it can open a page in front of you, read it, click, type, scroll and screenshot it, a tab you both share, instead of a blind web fetch. Off by default. Opening, navigating and interacting always ask through the standard permission card; only looking (snapshot, read, screenshot) rides the auto-allowed read tools.",
      "browserEnabled"
    );
```

- [ ] **Step 4: Run the suite**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint`
Expected: PASS, including `size-contract` with the lowered ceiling.

- [ ] **Step 5: Commit**

```bash
git add src/settings-schema.ts src/settings.ts tests/size-contract.test.ts
git commit -m "feat(settings): extract schema per ratchet plan; add browserEnabled (default off)"
```

---

### Task 7: Webview host (`browser-host.ts`), probe first, then build

**Files:**
- Create: `src/obsidian/browser-host.ts`
- Test: `tests/browser-host.test.ts` (the pure surface only: attrs map and result capping)

**Interfaces:**
- Consumes: scripts from Task 3.
- Produces:
  - `BROWSER_PARTITION = "persist:exo-agent-browser"`
  - `WEBVIEW_ATTRS: Record<string, string>` (pure, tested)
  - `EXEC_RESULT_CAP = 64_000`, `capExecResult(raw: unknown): string` (pure, tested)
  - `class BrowserHost { constructor(container: HTMLElement); attach(): boolean; get supported(): boolean; get hardened(): boolean; async navigate(url: string, timeoutMs?: number): Promise<void>; async exec(script: string): Promise<string>; async capture(maxWidth?: number): Promise<string>; pageBasics(): { url: string; title: string; loading: boolean }; destroy(): void }`

- [ ] **Step 1: Probe the live seams (read-only, no code yet)**

The two facts this task rests on were not verifiable from the repo. Verify them NOW against the running Obsidian (this is Mario's live vault: these probes only create and remove a 1px hidden element):

```bash
obsidian-cli eval code="(() => { try { const e = require('electron'); return JSON.stringify({ hasRemote: !!e.remote, hasRemoteSession: !!(e.remote && e.remote.session) }); } catch (err) { return 'ERR ' + String(err && err.message); } })()"
```

```bash
obsidian-cli eval code="(async () => { const w = document.createElement('webview'); w.setAttribute('partition','persist:exo-probe'); w.setAttribute('src','about:blank'); w.style.cssText='position:fixed;left:-10px;top:-10px;width:1px;height:1px;'; document.body.appendChild(w); await new Promise(r => { w.addEventListener('dom-ready', r, { once: true }); setTimeout(r, 4000); }); const out = { loadURL: typeof w.loadURL, executeJavaScript: typeof w.executeJavaScript, capturePage: typeof w.capturePage, getURL: typeof w.getURL, getTitle: typeof w.getTitle, isLoading: typeof w.isLoading }; w.remove(); return JSON.stringify(out); })()"
```

Record both outputs verbatim in this plan file under a new `## Probe results` section (committed with this task). Expected: all method typeofs `"function"`. If `executeJavaScript`/`capturePage` are missing on the element, the fallback is `e.remote.webContents.fromId(w.getWebContentsId())`: adapt `BrowserHost` to route through that handle and note it in Probe results. If `hasRemote` is false, permission-handler hardening is impossible from the renderer: proceed, set `hardened = false`, and flag it in the header UI (Task 8) and in the final report: do NOT silently skip.

- [ ] **Step 2: Write the failing test (pure surface)**

Create `tests/browser-host.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { BROWSER_PARTITION, WEBVIEW_ATTRS, capExecResult, EXEC_RESULT_CAP } from "../src/obsidian/browser-host";

describe("webview security attributes", () => {
  it("pins the persistent partition", () => {
    expect(BROWSER_PARTITION).toBe("persist:exo-agent-browser");
    expect(WEBVIEW_ATTRS.partition).toBe(BROWSER_PARTITION);
  });

  it("enables contextIsolation and sandbox, and never popups or node", () => {
    expect(WEBVIEW_ATTRS.webpreferences).toContain("contextIsolation=yes");
    expect(WEBVIEW_ATTRS.webpreferences).toContain("sandbox=yes");
    expect(Object.keys(WEBVIEW_ATTRS)).not.toContain("allowpopups");
    expect(Object.keys(WEBVIEW_ATTRS)).not.toContain("nodeintegration");
  });
});

describe("capExecResult", () => {
  it("passes strings through and caps huge ones", () => {
    expect(capExecResult("ok")).toBe("ok");
    const huge = capExecResult("x".repeat(EXEC_RESULT_CAP + 100));
    expect(huge.length).toBeLessThanOrEqual(EXEC_RESULT_CAP);
  });

  it("stringifies non-strings defensively", () => {
    expect(capExecResult(null)).toBe("");
    expect(capExecResult(42)).toBe("42");
  });
});
```

- [ ] **Step 3: Run test to verify it fails, then implement**

Run: `pnpm vitest run tests/browser-host.test.ts` → FAIL (unresolvable module). Then create `src/obsidian/browser-host.ts`:

```typescript
/**
 * Browser host: the thin impure wrapper around one Electron `<webview>`
 * element (Obsidian desktop only; the tag does not exist on mobile).
 *
 * Security posture, decided in the plan and pinned by tests on WEBVIEW_ATTRS:
 * a dedicated persistent partition (logins survive restarts, isolated from
 * Obsidian's own sessions), contextIsolation + sandbox on, no node
 * integration, no popups (window.open is inert without `allowpopups`). On top
 * of that, best-effort MAIN-session hardening through the remote module.
 * Electron GRANTS permission requests by default when no handler is set, so
 * without remote access the posture is weaker and `hardened` says so.
 *
 * All page access goes through executeJavaScript with the Task-3 scripts
 * (JSON-string protocol, capped results). No API here takes raw agent input:
 * the controller passes scripts in; this host stays script-agnostic and has
 * no core imports at all.
 */
export const BROWSER_PARTITION = "persist:exo-agent-browser";
export const EXEC_RESULT_CAP = 64_000;
const NAV_TIMEOUT_MS = 15_000;
const SETTLE_EXTRA_MS = 300;

/** Attributes set on the webview BEFORE it enters the DOM: partition is
 *  immutable after attach. Pure and exported so a unit test pins the posture. */
export const WEBVIEW_ATTRS: Record<string, string> = {
  partition: BROWSER_PARTITION,
  webpreferences: "contextIsolation=yes,sandbox=yes",
  src: "about:blank",
};

/** The slice of the webview element this host uses (Electron types are not a
 *  dependency of this repo: declare only what we touch). */
interface WebviewEl extends HTMLElement {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  stop(): void;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  capturePage(): Promise<{
    resize(opts: { width: number }): { toPNG(): Uint8Array };
    toPNG(): Uint8Array;
    getSize(): { width: number; height: number };
  }>;
}

/** Cap + coerce an executeJavaScript return value to a bounded string. */
export function capExecResult(raw: unknown): string {
  const s = raw == null ? "" : typeof raw === "string" ? raw : String(raw);
  return s.length > EXEC_RESULT_CAP ? s.slice(0, EXEC_RESULT_CAP) : s;
}

export class BrowserHost {
  private webview: WebviewEl | null = null;
  private hardenedFlag = false;

  constructor(private readonly container: HTMLElement) {}

  get supported(): boolean {
    return this.webview !== null;
  }

  get hardened(): boolean {
    return this.hardenedFlag;
  }

  /** Create and mount the webview. Returns false when the environment has no
   *  usable webview tag (mobile, or a future Electron without it). */
  attach(): boolean {
    if (this.webview) return true;
    const el = document.createElement("webview") as WebviewEl;
    for (const [k, v] of Object.entries(WEBVIEW_ATTRS)) el.setAttribute(k, v);
    el.classList.add("mva-browser-webview");
    this.container.appendChild(el);
    if (typeof el.executeJavaScript !== "function" && typeof el.loadURL !== "function") {
      // Methods bind on attach; if they never appear this build has no webview.
      el.remove();
      return false;
    }
    this.webview = el;
    this.hardenedFlag = this.hardenSession();
    return true;
  }

  /** Best-effort main-session hardening: deny-all permissions, block downloads.
   *  Runs once per plugin load per partition; failure is reported, not fatal. */
  private hardenSession(): boolean {
    try {
      const electron = require("electron") as {
        remote?: { session?: { fromPartition(p: string): {
          setPermissionRequestHandler(h: ((wc: unknown, p: string, cb: (ok: boolean) => void) => void) | null): void;
          setPermissionCheckHandler(h: ((wc: unknown, p: string) => boolean) | null): void;
          on(ev: "will-download", h: (e: { preventDefault(): void }) => void): void;
        } } };
      };
      const session = electron.remote?.session?.fromPartition(BROWSER_PARTITION);
      if (!session) return false;
      session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
      session.setPermissionCheckHandler(() => false);
      session.on("will-download", (e) => e.preventDefault());
      return true;
    } catch {
      return false;
    }
  }

  private need(): WebviewEl {
    if (!this.webview) throw new Error("The agent browser is not attached.");
    return this.webview;
  }

  /** Navigate and wait for the load to settle (did-stop-loading, did-fail-load,
   *  or the timeout (whichever first) plus a short paint-settle delay). */
  async navigate(url: string, timeoutMs = NAV_TIMEOUT_MS): Promise<void> {
    const wv = this.need();
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        wv.removeEventListener("did-stop-loading", finish);
        wv.removeEventListener("did-fail-load", finish);
        resolve();
      };
      wv.addEventListener("did-stop-loading", finish);
      wv.addEventListener("did-fail-load", finish);
      setTimeout(finish, timeoutMs);
      void wv.loadURL(url).catch(() => finish());
    });
    await new Promise((r) => setTimeout(r, SETTLE_EXTRA_MS));
  }

  /** After a click that may have triggered navigation: wait for quiet. */
  async settleAfterAction(maxMs = 5_000): Promise<void> {
    const wv = this.need();
    const start = Date.now();
    await new Promise((r) => setTimeout(r, SETTLE_EXTRA_MS));
    while (wv.isLoading() && Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** Run one of the Task-3 scripts; returns the (capped) JSON string. */
  async exec(script: string): Promise<string> {
    return capExecResult(await this.need().executeJavaScript(script, false));
  }

  /** Capture the visible page, downscaled to bound tokens, as base64 PNG. */
  async capture(maxWidth = 1024): Promise<string> {
    const img = await this.need().capturePage();
    const { width } = img.getSize();
    const png = width > maxWidth ? img.resize({ width: maxWidth }).toPNG() : img.toPNG();
    return Buffer.from(png).toString("base64");
  }

  pageBasics(): { url: string; title: string; loading: boolean } {
    const wv = this.need();
    return { url: wv.getURL(), title: wv.getTitle(), loading: wv.isLoading() };
  }

  destroy(): void {
    this.webview?.remove();
    this.webview = null;
  }
}
```

Adapt `attach()`/method routing per the Step-1 probe results if the element surface differed.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/browser-host.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/obsidian/browser-host.ts tests/browser-host.test.ts docs/plans/2026-08-11-scoped-browser-plan.md
git commit -m "feat(browser): webview host with pinned security posture (probed live)"
```

---

### Task 8: The `exo-browser` leaf (`ui/browser-view.ts`) + registration + styles

**Files:**
- Create: `src/ui/browser-view.ts`
- Modify: `src/ui/view-registry.ts` (register the view; registration stays unconditional, BoardView pattern)
- Modify: `styles.css` (webview fill + header)

**Interfaces:**
- Consumes: `BrowserHost` (Task 7); `plugin.settings.browserEnabled` (Task 6).
- Produces: `EXO_BROWSER_VIEW_TYPE = "exo-browser"`; `class BrowserView extends ItemView { ensureHost(): BrowserHost | null; setStatus(url: string, title: string): void }`.

- [ ] **Step 1: Implement the view**

Create `src/ui/browser-view.ts`:

```typescript
/**
 * Agent browser view: the workspace leaf hosting the shared webview.
 *
 * Registered unconditionally (a leaf restored from a saved layout must render)
 * but gated at ENTRY, exactly like BoardView: with `browserEnabled` off, or on
 * mobile, or when the environment has no webview tag, it renders a placeholder
 * and never creates a webview. The view owns the DOM and the BrowserHost; the
 * plugin-level BrowserController owns the lease and drives the host: closing
 * the leaf drops the page, and the next browser_open simply recreates it.
 */
import { ItemView, Platform, WorkspaceLeaf } from "obsidian";
import type ExoPlugin from "../main";
import { BrowserHost } from "../obsidian/browser-host";

export const EXO_BROWSER_VIEW_TYPE = "exo-browser";
export const EXO_BROWSER_ICON = "globe";

export class BrowserView extends ItemView {
  private host: BrowserHost | null = null;
  private bodyEl!: HTMLElement;
  private urlEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ExoPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return EXO_BROWSER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Agent browser";
  }

  getIcon(): string {
    return EXO_BROWSER_ICON;
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("mva-browser");
    const header = root.createDiv({ cls: "mva-browser-header" });
    header.createSpan({ cls: "mva-browser-label", text: "Agent browser" });
    this.urlEl = header.createSpan({ cls: "mva-browser-url", text: "" });
    this.bodyEl = root.createDiv({ cls: "mva-browser-body" });
    this.renderGate();
  }

  private renderGate(): void {
    this.bodyEl.empty();
    if (!this.plugin.settings.browserEnabled) {
      this.bodyEl.createDiv({
        cls: "mva-browser-placeholder",
        text: "The agent browser is disabled. Turn it on in Exo settings (Agent browser) to let the agent open pages here.",
      });
      return;
    }
    if (Platform.isMobile) {
      this.bodyEl.createDiv({
        cls: "mva-browser-placeholder",
        text: "The agent browser is desktop-only: Obsidian mobile has no embedded browser.",
      });
    }
    // Desktop + enabled: the webview is created lazily by ensureHost() on the
    // first tool call, so a restored empty leaf costs nothing.
  }

  /** The controller's entry point. Null when gated or unsupported. */
  ensureHost(): BrowserHost | null {
    if (!this.plugin.settings.browserEnabled || Platform.isMobile) return null;
    if (this.host?.supported) return this.host;
    this.bodyEl.empty();
    const host = new BrowserHost(this.bodyEl);
    if (!host.attach()) {
      this.bodyEl.createDiv({
        cls: "mva-browser-placeholder",
        text: "This Obsidian build exposes no webview tag: the agent browser cannot run here.",
      });
      return null;
    }
    this.host = host;
    if (!host.hardened) {
      this.urlEl.setAttribute(
        "aria-label",
        "Session hardening unavailable (no remote module): web permission prompts fall back to Electron defaults."
      );
    }
    return host;
  }

  setStatus(url: string, title: string): void {
    this.urlEl.setText(url);
    this.urlEl.setAttribute("title", title);
  }

  async onClose(): Promise<void> {
    this.host?.destroy();
    this.host = null;
  }
}
```

- [ ] **Step 2: Register the view**

In `src/ui/view-registry.ts`, import and register (inside `registerExoViews`, one line, following the existing pattern):

```typescript
import { BrowserView, EXO_BROWSER_VIEW_TYPE } from "./browser-view";
```

```typescript
  plugin.registerView(EXO_BROWSER_VIEW_TYPE, (leaf) => new BrowserView(leaf, plugin));
```

- [ ] **Step 3: Styles**

In `styles.css`, beside the other `mva-` view blocks (match neighboring token usage, no raw hex, no `!important`):

```css
/* Agent browser leaf: the webview must fill the pane under a slim header. */
.mva-browser {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 0;
}
.mva-browser-header {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  padding: var(--size-4-1) var(--size-4-2);
  border-bottom: 1px solid var(--background-modifier-border);
  font-size: var(--font-ui-smaller);
  color: var(--text-muted);
}
.mva-browser-url {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-faint);
}
.mva-browser-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.mva-browser-webview {
  flex: 1;
  width: 100%;
  height: 100%;
}
.mva-browser-placeholder {
  margin: auto;
  max-width: 32em;
  text-align: center;
  color: var(--text-muted);
  padding: var(--size-4-4);
}
```

Verify the variable names against neighbouring rules in `styles.css` and match what the file actually uses rather than inventing new tokens.

- [ ] **Step 4: Gate checks**

Run: `pnpm typecheck && pnpm vitest run src/style-contract.test.ts tests/size-contract.test.ts && pnpm lint`
Expected: PASS (`view-registry.ts` is not ratcheted; no `!important`/hex added).

- [ ] **Step 5: Commit**

```bash
git add src/ui/browser-view.ts src/ui/view-registry.ts styles.css
git commit -m "feat(browser): exo-browser leaf with gated placeholder and webview mount"
```

---

### Task 9: Browser controller, lease + leaf orchestration + bridge factory

**Files:**
- Create: `src/obsidian/browser-controller.ts`
- Test: `tests/browser-controller.test.ts` (gating of `browserBridgeFor` only, the controller itself is impure by design; its logic lives in Tasks 1–3 modules)
- Modify: `tests/__mocks__/obsidian.ts` (add a `Platform` export, the mock's header allows adding exports a test genuinely needs)

**Interfaces:**
- Consumes: `acquireLease`/`checkLease` (Task 1), scripts (Task 3), `BrowserBridge`/`BrowserStatus`/`BrowserToolRefused` (Task 4), `BrowserHost` (Task 7), `BrowserView`/`EXO_BROWSER_VIEW_TYPE` (Task 8), `isAllowedUrl`/`PageElement` (Task 2).
- Produces: `browserBridgeFor(plugin: ExoPlugin, convoId: string): BrowserBridge | undefined`; `getBrowserController(plugin: ExoPlugin): BrowserController`.

- [ ] **Step 1: Write the failing test**

Add to `tests/__mocks__/obsidian.ts`:

```typescript
export const Platform = { isMobile: false, isDesktopApp: true };
```

Create `tests/browser-controller.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { browserBridgeFor } from "../src/obsidian/browser-controller";
import { Platform } from "obsidian";
import type ExoPlugin from "../src/main";

const plugin = (browserEnabled: boolean) =>
  ({ settings: { browserEnabled }, app: { workspace: {} } }) as unknown as ExoPlugin;

describe("browserBridgeFor gating", () => {
  it("returns undefined when the feature is off (byte-identical tool list)", () => {
    expect(browserBridgeFor(plugin(false), "convo-a")).toBeUndefined();
  });

  it("returns a full bridge when enabled on desktop", () => {
    const bridge = browserBridgeFor(plugin(true), "convo-a");
    expect(bridge).toBeTruthy();
    for (const m of ["open", "navigate", "snapshot", "readPage", "screenshot", "click", "type", "scroll"] as const) {
      expect(typeof bridge![m], m).toBe("function");
    }
  });

  it("returns undefined on mobile even when enabled", () => {
    (Platform as { isMobile: boolean }).isMobile = true;
    try {
      expect(browserBridgeFor(plugin(true), "convo-a")).toBeUndefined();
    } finally {
      (Platform as { isMobile: boolean }).isMobile = false;
    }
  });

  it("hands two conversations of one plugin the same controller (shared lease)", () => {
    const p = plugin(true);
    const a = browserBridgeFor(p, "convo-a");
    const b = browserBridgeFor(p, "convo-b");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b); // distinct per-convo closures over ONE controller
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/browser-controller.test.ts`
Expected: FAIL (cannot resolve `../src/obsidian/browser-controller`).

- [ ] **Step 3: Write the implementation**

Create `src/obsidian/browser-controller.ts`:

```typescript
/**
 * Browser controller: the plugin-level owner of the shared agent browser.
 *
 * One controller per plugin instance (WeakMap accessor, so main.ts carries
 * ZERO wiring lines for it: it is at its size-ratchet ceiling). It owns the
 * lease, finds-or-creates the exo-browser leaf, and translates BrowserBridge
 * calls into host operations plus Task-3 scripts. All refusals go through
 * BrowserToolRefused so the tools render them as answers.
 *
 * Import direction: view.ts → this module → ui/browser-view. This module must
 * never import view.ts or ui/view-registry.ts (cycle).
 */
import { Platform, type WorkspaceLeaf } from "obsidian";
import type ExoPlugin from "../main";
import { acquireLease, checkLease, type BrowserLease } from "../core/browser-lease";
import { isAllowedUrl, type PageElement } from "../core/browser-page";
import {
  READ_PAGE_SCRIPT,
  SNAPSHOT_SCRIPT,
  STATUS_SCRIPT,
  clickScript,
  scrollScript,
  typeIntoScript,
  type ElementTarget,
} from "../core/browser-inject";
import { BrowserToolRefused, type BrowserBridge, type BrowserStatus } from "./browser-tools";
import type { BrowserHost } from "./browser-host";
import { BrowserView, EXO_BROWSER_VIEW_TYPE } from "../ui/browser-view";

const controllers = new WeakMap<ExoPlugin, BrowserController>();

export function getBrowserController(plugin: ExoPlugin): BrowserController {
  let c = controllers.get(plugin);
  if (!c) {
    c = new BrowserController(plugin);
    controllers.set(plugin, c);
  }
  return c;
}

/** Per-convo bridge, or undefined when the feature is gated off: undefined is
 *  what keeps the session tool list byte-identical with the flag off. */
export function browserBridgeFor(plugin: ExoPlugin, convoId: string): BrowserBridge | undefined {
  if (!plugin.settings.browserEnabled || Platform.isMobile) return undefined;
  return getBrowserController(plugin).bridgeFor(convoId);
}

export class BrowserController {
  private lease: BrowserLease | null = null;

  constructor(private readonly plugin: ExoPlugin) {}

  bridgeFor(convoId: string): BrowserBridge {
    return {
      open: (url) => this.open(convoId, url),
      navigate: (url) => this.navigate(convoId, url),
      snapshot: () => this.snapshot(),
      readPage: () => this.readPage(),
      screenshot: () => this.screenshot(),
      click: (t) => this.click(convoId, t),
      type: (t, text, opts) => this.type(convoId, t, text, opts),
      scroll: (op) => this.scroll(convoId, op),
    };
  }

  /* ------------------------------ plumbing ------------------------------ */

  private async ensureView(reveal: boolean): Promise<{ view: BrowserView; host: BrowserHost }> {
    const { workspace } = this.plugin.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(EXO_BROWSER_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: EXO_BROWSER_VIEW_TYPE, active: reveal });
    }
    // A leaf restored from layout may still be deferred: realize it first.
    await (leaf as WorkspaceLeaf & { loadIfDeferred?: () => Promise<void> }).loadIfDeferred?.();
    if (reveal) workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (!(view instanceof BrowserView)) {
      throw new BrowserToolRefused("The agent-browser view could not be created in this workspace.");
    }
    const host = view.ensureHost();
    if (!host) {
      throw new BrowserToolRefused(
        "The agent browser is unavailable here (disabled, mobile, or no webview support)."
      );
    }
    return { view, host };
  }

  /** Existing, live view+host: for tools that must not create the tab. */
  private async currentView(): Promise<{ view: BrowserView; host: BrowserHost }> {
    const leaves = this.plugin.app.workspace.getLeavesOfType(EXO_BROWSER_VIEW_TYPE);
    if (!leaves.length) {
      throw new BrowserToolRefused("No agent-browser tab is open. Call browser_open first.");
    }
    return this.ensureView(false);
  }

  private requireLease(convoId: string): void {
    const res = checkLease(this.lease, convoId);
    if (!res.ok) throw new BrowserToolRefused(res.reason);
  }

  private async status(view: BrowserView, host: BrowserHost): Promise<BrowserStatus> {
    const basics = host.pageBasics();
    let scroll = { scrollY: 0, scrollHeight: 0, viewportHeight: 0 };
    try {
      scroll = JSON.parse(await host.exec(STATUS_SCRIPT)) as typeof scroll;
    } catch {
      /* about:blank or a crashed guest: basics still stand */
    }
    view.setStatus(basics.url, basics.title);
    return { ...basics, ...scroll, ownerConvoId: this.lease?.ownerConvoId ?? null };
  }

  /* ------------------------------- ops ---------------------------------- */

  private async open(convoId: string, url?: string): Promise<BrowserStatus> {
    const { lease, tookOverFrom } = acquireLease(this.lease, convoId, Date.now());
    this.lease = lease;
    const { view, host } = await this.ensureView(true);
    if (url) {
      const gate = isAllowedUrl(url);
      if (!gate.ok) throw new BrowserToolRefused(gate.reason);
      await host.navigate(gate.url);
    }
    const status = await this.status(view, host);
    if (tookOverFrom) {
      status.title = `${status.title} [took over the browser from ${tookOverFrom}]`;
    }
    return status;
  }

  private async navigate(convoId: string, url: string): Promise<BrowserStatus> {
    this.requireLease(convoId);
    const gate = isAllowedUrl(url);
    if (!gate.ok) throw new BrowserToolRefused(gate.reason);
    const { view, host } = await this.currentView();
    await host.navigate(gate.url);
    return this.status(view, host);
  }

  private async snapshot(): Promise<{ status: BrowserStatus; elements: PageElement[] }> {
    const { view, host } = await this.currentView();
    let elements: PageElement[] = [];
    try {
      elements = JSON.parse(await host.exec(SNAPSHOT_SCRIPT)) as PageElement[];
    } catch {
      elements = [];
    }
    return { status: await this.status(view, host), elements };
  }

  private async readPage(): Promise<{ status: BrowserStatus; text: string; total: number }> {
    const { view, host } = await this.currentView();
    let text = "";
    let total = 0;
    try {
      const parsed = JSON.parse(await host.exec(READ_PAGE_SCRIPT)) as { text: string; total: number };
      text = parsed.text;
      total = parsed.total;
    } catch {
      /* leave empty: status still reports the URL */
    }
    return { status: await this.status(view, host), text, total };
  }

  private async screenshot(): Promise<{ status: BrowserStatus; pngB64: string }> {
    const { view, host } = await this.currentView();
    const pngB64 = await host.capture();
    return { status: await this.status(view, host), pngB64 };
  }

  private async act(convoId: string, script: string): Promise<BrowserStatus> {
    this.requireLease(convoId);
    const { view, host } = await this.currentView();
    let res: { ok: boolean; reason?: string } = { ok: false, reason: "no result" };
    try {
      res = JSON.parse(await host.exec(script)) as typeof res;
    } catch (e) {
      res = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    if (!res.ok) throw new BrowserToolRefused(res.reason ?? "The page rejected the action.");
    await host.settleAfterAction();
    return this.status(view, host);
  }

  private click(convoId: string, target: ElementTarget): Promise<BrowserStatus> {
    return this.act(convoId, clickScript(target));
  }

  private type(
    convoId: string,
    target: ElementTarget,
    text: string,
    opts: { clear?: boolean; submit?: boolean }
  ): Promise<BrowserStatus> {
    return this.act(convoId, typeIntoScript(target, text, opts));
  }

  private scroll(convoId: string, op: { to?: "top" | "bottom"; pages?: number }): Promise<BrowserStatus> {
    return this.act(convoId, scrollScript(op));
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run tests/browser-controller.test.ts && pnpm typecheck && pnpm vitest run`
Expected: PASS across the suite (the mock's new `Platform` export must not break other tests; it is additive).

- [ ] **Step 5: Commit**

```bash
git add src/obsidian/browser-controller.ts tests/browser-controller.test.ts tests/__mocks__/obsidian.ts
git commit -m "feat(browser): controller with lease, leaf orchestration, per-convo bridges"
```

---

### Task 10: view.ts wiring, paid for by the formatDate/formatRelative extraction

`view.ts` is exactly at its 6600 ceiling. The wiring below adds ~4 lines; the extraction removes ~23. Do the extraction FIRST so the tree is never red.

**Files:**
- Modify: `src/core/history.ts` (receive `formatCompactDate`, `formatRelativeDays`)
- Modify: `src/view.ts` (delete the two methods + their now-unused import; add bridge wiring + session-sig line)
- Modify: `src/ui/gallery-cards.ts` (call the core functions instead of view methods)
- Test: `tests/browser-wiring.test.ts` (new; seam contract in the style of `tests/fanout-wiring.test.ts`)

**Interfaces:**
- Consumes: `browserBridgeFor` (Task 9).
- Produces: browser bridge reaching both tool-server call sites; `sessionSigOf` including `browserEnabled`; `formatCompactDate(ts)/formatRelativeDays(ts)` in `core/history.ts`.

- [ ] **Step 1: Extraction (mechanical)**

In `src/core/history.ts` (which already owns `startOfDay`, `DAY_MS`, and the calendar-day vocabulary), add:

```typescript
/** Compact absolute date for card metadata: clock time today, "12 Aug" otherwise. */
export function formatCompactDate(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

/** "3 giorni fa" relative time in CALENDAR days (same vocabulary as
 *  groupByTime): a chat retired yesterday at 23:00 is "ieri", not "oggi".
 *  Math.round because a DST day is 23 or 25 hours long. */
export function formatRelativeDays(ts: number): string {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / DAY_MS);
  if (days <= 0) return "oggi";
  if (days === 1) return "ieri";
  return `${days} giorni fa`;
}
```

In `src/view.ts`: delete the `formatDate` and `formatRelative` methods (currently ~lines 2617–2638) and the `import { startOfDay, DAY_MS } from "./core/history";` line (~line 109) after verifying with a grep that nothing else in `view.ts` uses those two symbols. In `src/ui/gallery-cards.ts`: replace `view.formatDate(c.updatedAt)` → `formatCompactDate(c.updatedAt)` and `view.formatRelative(c.retiredAt)` → `formatRelativeDays(c.retiredAt)`, importing both from `../core/history`.

Run: `pnpm typecheck && pnpm vitest run tests/size-contract.test.ts`: green, with `view.ts` now ~23 lines under ceiling.

- [ ] **Step 2: Write the failing wiring test**

Create `tests/browser-wiring.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Browser wiring contract: the seams that connect the tested browser core to
 * the untestable view.ts. Same rationale as fanout-wiring.test.ts: every link
 * is a plain call whose failure mode is silence. A session that never receives
 * the bridge simply has no browser tools; a session signature that ignores
 * `browserEnabled` keeps serving stale tool lists after the flag flips.
 * Red here means "re-wire the seam", never "relax the assertion".
 */
const read = (...rel: string[]): string => readFileSync(join(__dirname, "..", ...rel), "utf8");
const view = read("src", "view.ts");
const tools = read("src", "obsidian", "tools.ts");

describe("browser wiring", () => {
  it("view.ts builds a per-convo browser bridge for the Claude tool server", () => {
    expect(view).toMatch(/createObsidianToolServer\([\s\S]*?browserBridgeFor\(this\.plugin,\s*c\.id\)/);
  });

  it("view.ts passes the bridge to the Codex registry too", () => {
    expect(view).toMatch(/browserBridge:\s*browserBridgeFor\(this\.plugin,\s*c\.id\)/);
  });

  it("the session signature includes browserEnabled, so flipping the flag respawns", () => {
    const at = view.indexOf("sessionSigOf");
    expect(at).toBeGreaterThan(-1);
    expect(view.slice(at, at + 900)).toContain("browserEnabled");
  });

  it("tools.ts registers the browser set only behind the bridge", () => {
    expect(tools).toMatch(/browserBridge \? buildBrowserTools\(browserBridge\) : \[\]/);
  });
});
```

Run: `pnpm vitest run tests/browser-wiring.test.ts`: FAIL (three assertions).

- [ ] **Step 3: Wire view.ts**

In `src/view.ts`:

1. Import (with the other `./obsidian/…` imports):

```typescript
import { browserBridgeFor } from "./obsidian/browser-controller";
```

2. Claude tool-server call site (the positional `createObsidianToolServer(...)` inside `spawnSession`, whose last args are currently `this.plugin.paths, c.id // parentConvoId: gates spawn_task`): append the new trailing argument:

```typescript
          this.plugin.paths, c.id, // parentConvoId: gates spawn_task
          browserBridgeFor(this.plugin, c.id) // agent browser (undefined when off/mobile)
```

3. Codex registry call site (the `buildObsidianTools(this.app, { … })` options object that already carries `parentConvoId: c.id`): add:

```typescript
          browserBridge: browserBridgeFor(this.plugin, c.id),
```

4. `sessionSigOf`: after `s.orchestrationEnabled,` add:

```typescript
      s.browserEnabled,
```

- [ ] **Step 4: Run the full suite**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint`
Expected: PASS, including `size-contract` (view.ts net negative) and `browser-wiring`.

- [ ] **Step 5: Commit**

```bash
git add src/core/history.ts src/view.ts src/ui/gallery-cards.ts tests/browser-wiring.test.ts
git commit -m "feat(browser): wire per-convo bridges into both tool servers (net -19 lines in view.ts)"
```

---

### Task 11: Live verification in the real vault (obsidian-cli)

**Files:** none except appending results to this plan file.

**Interfaces:**
- Consumes: everything above.
- Produces: a verified end-to-end agent-browser session, or a bug list with real outputs.

⚠️ This is Mario's live vault. Do not reload the plugin while any Exo turn is in flight; do not touch vault notes; use only the probes below. The binary is `obsidian-cli` (plain `obsidian` on PATH is the app).

- [ ] **Step 1: Build and deploy**

Run: `pnpm release:check` (lint + full tests + build; the build writes `main.js` into the live vault via `.obsidian-plugin-dir`). Confirm zero failures, then when Exo is idle:

```bash
obsidian-cli plugin:reload id=exo
obsidian-cli dev:errors
```

Expected: no new errors from the reload.

- [ ] **Step 2: Enable the flag**

```bash
obsidian-cli eval code="(async () => { const p = app.plugins.plugins.exo; p.settings.browserEnabled = true; await p.saveSettings(); return 'browserEnabled=' + p.settings.browserEnabled; })()"
```

Expected output: `browserEnabled=true`.

- [ ] **Step 3: Tool registration probe**

Open a NEW Exo conversation (new tab, the session signature change means old sessions keep the old tool list) and ask: `Which browser_* tools do you have? Just list them.` Expected: the eight names. Also confirm in Capabilities Hub → Tools after the session's init snapshot lands.

- [ ] **Step 4: Happy path, research in front of Mario**

In that conversation: `Open https://example.com in your browser and tell me the page's main heading.` Verify, in order:

1. A permission card for `browser_open` appears with the URL visible; approve it.
2. The `exo-browser` leaf opens in the main pane and `https://example.com/` renders in it.
3. The agent reads the heading ("Example Domain") via snapshot/read_page WITHOUT further permission cards (read set auto-allowed).
4. `obsidian-cli dev:screenshot path=/tmp/exo-browser-verify.png`, inspect: the browser leaf is visible next to the chat.

Then: `Take a screenshot of the page and describe what you see.` Verify the agent's description matches the actual page (this is the image-block seam test; if the agent says it cannot see an image, record it and implement the fallback in Known unverified seams, item 3).

- [ ] **Step 5: Lease and gate refusals**

1. Open a SECOND Exo conversation and ask it to `browser_navigate` somewhere **without** opening first: expect the "driven by another conversation / call browser_open" refusal text, not an error card.
2. In the same second conversation: `Use browser_open to take over and go to https://en.wikipedia.org`. Approve; verify the takeover note in the result and that the first conversation now gets the refusal on its next mutation.
3. Ask either conversation to open `file:///etc/hosts`: expect the http(s)-only refusal.

- [ ] **Step 6: Interaction path**

`On the current page, use the search box: type "Obsidian" and submit, then tell me the first result's title.` Verify: `browser_type` card shows the text and target; after approval, the page actually searches and the reported title matches what the tab shows.

- [ ] **Step 7: Off-flag byte-identity**

```bash
obsidian-cli eval code="(async () => { const p = app.plugins.plugins.exo; p.settings.browserEnabled = false; await p.saveSettings(); return 'off'; })()"
```

Open a fresh conversation, ask again which `browser_*` tools it has. Expected: none. Then decide with Mario whether to leave the flag on or off; leave it OFF if he is not around.

- [ ] **Step 8: Cleanup and record**

Close the `exo-browser` leaf. Run `obsidian-cli dev:errors` one last time (expect clean). Append a `## Verification` section to this plan file with the real outcomes of steps 1–7, including anything that failed and the exact refusal texts observed.

```bash
git add -f docs/plans/2026-08-11-scoped-browser-plan.md
git commit -m "docs: record agent-browser live verification results"
```

---

## Known unverified seams

The implementer must **check these rather than assume**; each has a decided fallback.

1. **Webview element surface inside an Obsidian leaf** (`loadURL`, `executeJavaScript`, `capturePage`, `did-stop-loading` on the element). Obsidian's core Web Viewer proves the tag exists on desktop, but the method surface on OUR partition is probed in Task 7 Step 1 before any host code is written. Fallback: route through `remote.webContents.fromId(el.getWebContentsId())`.
2. **`require("electron").remote.session` availability** for deny-all permission handlers and download blocking. Probed in Task 7 Step 1. Fallback: proceed with `hardened=false`, surface it in the leaf header tooltip and the final report. Electron's no-handler default GRANTS permission requests, so this must never be silent.
3. **Claude Code CLI forwarding MCP image content blocks to the model.** The MCP type supports it and the Exo UI tolerates it (verified in-repo); whether the CLI relays the image to the model is verified live in Task 11 Step 4. Fallback if it does not: `browser_screenshot` additionally writes the PNG under `paths.reports + "/browser/"` (a mechanism path, safe to create) and returns the vault path in the text block so the agent can `Read` it.
4. **Codex loopback bridge and image blocks.** The Codex↔Obsidian bridge serializes tool results; it may drop the image block. Browser tools otherwise work on Codex unchanged (same registry). If screenshots degrade there, apply the same file fallback for Codex sessions only; do not block the Claude path on it.
5. **`capturePage` on a backgrounded window** may return an empty image (Obsidian throttles hidden surfaces). The feature's premise is a visible tab, so this is acceptable; if Task 11 hits it, have `screenshot()` refuse with "the browser tab is not visible" instead of returning a blank image.
6. **Exact anchors in `view.ts`** (the positional call site's final args, the codex opts object, `sessionSigOf`'s array) and the current ratchet counts: re-verify with grep/`wc -l` at execution time; they were exact on 2026-08-11 but this file is touched by 40% of commits.
7. **The moved settings-schema import set** (Task 6 Step 1 lists the expected four; typecheck is the arbiter).
8. **`tests/tool-registries.test.ts` assertion direction**: the plan assumes it checks "classifier ⊆ registered"; read the second half of the file before editing and satisfy whichever direction it enforces.
9. **styles.css spacing tokens** (`--size-4-*` etc.): match what neighbouring rules in the file actually use.

## Self-Review

**Spec coverage:** shared visible webview leaf → Tasks 7–8; T3-style lease scoping → Tasks 1, 9; 8 research-first tools with schemas → Task 4; per-convo registration + byte-identical off-gating → Tasks 5, 9, 10 (wiring test pins all three seams); permission split read/mutate → Tasks 4–5 (`BROWSER_READ_TOOLS` into `OBSIDIAN_READ_TOOLS`, sync-tested); security posture → Tasks 2 (URL gate), 3 (escaping, tested), 7 (partition/attrs pinned by test, deny-all handlers, download block); screenshot return path → Tasks 4, 7, seam 3; gating setting default OFF → Task 6; mobile degrade-to-absent → Tasks 8–9 (`Platform.isMobile` in both the view gate and the bridge factory); live verification with obsidian-cli → Task 11.

**Deliberate exclusions (YAGNI per scope):** no `browser_evaluate` (arbitrary JS is T3's riskiest tool and research does not need it), no recording, no device presets, no color-scheme emulation, no multi-tab, no user-facing "open browser" command (the agent opens it; a command is one line in `view-registry.ts` later if Mario asks).

**Ratchet accounting:** `main.ts` +0 (WeakMap accessor + registration in un-ratcheted `view-registry.ts`); `view.ts` net ≈ −19 (extraction −23, wiring +4); `settings.ts` shrinks by ~300 via its own sanctioned schema extraction, ceiling lowered accordingly.
