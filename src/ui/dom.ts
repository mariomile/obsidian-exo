/** Shared DOM helpers for the chat UI. */

/**
 * Make a non-button element keyboard- and screen-reader-operable: role=button,
 * focusable (tabIndex 0), and Enter/Space fire the same handler as a click. Use
 * for the div/span controls that can't easily become a <button> without losing
 * their layout. The global `.mva-root :focus-visible` ring then applies for free.
 */
export function clickable(el: HTMLElement, handler: (e: Event) => void): void {
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  el.addEventListener("click", handler);
  el.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handler(e);
    }
  });
}
