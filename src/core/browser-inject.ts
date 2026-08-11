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
  opts: { clear?: boolean; submit?: boolean } = {},
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
