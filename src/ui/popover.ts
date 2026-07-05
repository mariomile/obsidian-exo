/**
 * The one popover open/close lifecycle used by the composer toolbar controls
 * (tune dialog, select chips, attach menu). Owns the `open` flag, the
 * `document` click-capture listener that closes on an outside click, the
 * `pop.show()/hide()` toggle, the `is-open` class on the anchor, and
 * Escape-to-close. The CALLER still creates the DOM (wrap / anchor / pop) and is
 * responsible for registering the returned `close` for teardown.
 *
 * "Outside" a click means: not within `wrap` and not on any of the anchors
 * (`anchor` plus any `extraAnchors`). `onOpen` runs right before the popover is
 * shown (rebuild content, seed rows); `onClose` runs after it hides; `focus`
 * runs on the next tick after opening (deferred, matching the prior setTimeout).
 */
export function openablePopover(opts: {
  anchor: HTMLElement;
  extraAnchors?: HTMLElement[];
  pop: HTMLElement;
  wrap: HTMLElement;
  onOpen?: () => void;
  onClose?: () => void;
  focus?: () => void;
}): { toggle: () => void; close: () => void; isOpen: () => boolean } {
  const { anchor, pop, wrap } = opts;
  const anchors = [anchor, ...(opts.extraAnchors ?? [])];
  let open = false;

  const onDoc = (e: MouseEvent) => {
    const t = e.target as Node;
    if (!wrap.contains(t) && !anchors.some((a) => a === t)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && open) close();
  };

  // Unconditional, matching the prior hand-rolled close: teardown registers it
  // and may fire it when the popover was never opened, so every call must be a
  // safe no-op that just re-asserts the closed state.
  const close = () => {
    const wasOpen = open;
    open = false;
    pop.hide();
    anchor.removeClass("is-open");
    document.removeEventListener("click", onDoc, true);
    document.removeEventListener("keydown", onKey);
    if (wasOpen) opts.onClose?.();
  };

  const doOpen = () => {
    opts.onOpen?.();
    open = true;
    anchor.addClass("is-open");
    pop.show();
    document.addEventListener("click", onDoc, true);
    document.addEventListener("keydown", onKey);
    if (opts.focus) setTimeout(() => opts.focus?.(), 0);
  };

  const toggle = () => {
    if (open) return close();
    doOpen();
  };

  return { toggle, close, isOpen: () => open };
}
