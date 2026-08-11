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
    `scroll: ${Math.round(s.scrollY)} to ${Math.round(bottom)} of ${Math.round(s.scrollHeight)}px (${pct}% seen)`,
  ].join("\n");
}

function elementLine(e: PageElement): string {
  const role = e.role === "heading" && e.level ? `heading#${e.level}` : e.role;
  const bits = [`- ${e.ref} [${role}] "${e.text}"`];
  if (e.value) bits.push(`value="${e.value}"`);
  if (e.href) bits.push(`-> ${e.href}`);
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
    `\n... [truncated: showing ${PAGE_TEXT_CAP} of ${totalLen} chars: use browser_snapshot to find anchors, or ask for a section]`
  );
}
