/**
 * Minimal `obsidian` stub for vitest. The extracted `core/` modules are pure
 * and must not pull `obsidian` at runtime; this alias only exists so that if a
 * transitive import ever appears, the test loader resolves to an empty module
 * instead of crashing. Deliberately intentionally sparse — add exports only if
 * a test genuinely needs one.
 */
export class TFile {
  path = "";
  basename = "";
  stat = { mtime: 0 };
}

/** Mutable so a test can assert the mobile branch of a desktop-only gate and
 *  put it back. Desktop is the default because that is where Exo runs. */
export const Platform = { isMobile: false, isDesktopApp: true };

/** Base class for the views the browser controller instanceof-checks. Real
 *  Obsidian gives it a leaf and a contentEl; nothing here needs either. */
export class ItemView {
  constructor(public leaf?: unknown) {}
}

/** User-facing feedback. Tests need it not to crash, and occasionally to read
 *  back what was said — a command whose only outcome is a Notice ("nothing is
 *  waiting on you") is otherwise untestable. */
export class Notice {
  static last = "";
  constructor(public message: string) {
    Notice.last = message;
  }
  hide(): void {}
}

/** Paints a lucide glyph into an element. Nothing here reads the icon back;
 *  the stub exists so a surface that labels its chips can be rendered in a
 *  test at all. */
export function setIcon(el: { dataset?: Record<string, string> }, icon: string): void {
  if (el.dataset) el.dataset.icon = icon;
}
