import { describe, it, expect } from "vitest";
import { clickable, isolateActivation } from "../src/ui/dom";

/**
 * The nested-control hazard, in the one place it can be tested without a DOM.
 *
 * `clickable` makes a div behave like a button by listening for Enter/Space and
 * calling `preventDefault()`. A real `<button>` nested inside such an element
 * inherits that listener through bubbling — and `preventDefault()` on a keydown
 * is exactly what cancels a button's own activation click. So a button inside a
 * clickable row is, from the keyboard, not a button at all: pressing Enter on it
 * runs the ROW's handler instead of its own.
 *
 * The listeners are recorded off a fake element rather than a jsdom one: the
 * suite runs in `node`, and the property under test is which listener sees the
 * event, not how a browser paints it.
 */
type Listener = (e: Record<string, unknown>) => void;

interface Fake {
  el: HTMLElement;
  on: (type: string) => Listener[];
}

function fakeEl(): Fake {
  const map = new Map<string, Listener[]>();
  const el = {
    tabIndex: -1,
    setAttribute: () => {},
    addEventListener: (type: string, fn: Listener) => {
      const arr = map.get(type) ?? [];
      arr.push(fn);
      map.set(type, arr);
    },
  } as unknown as HTMLElement;
  return { el, on: (type) => map.get(type) ?? [] };
}

/** Dispatch along a bubble path (innermost first), honouring `stopPropagation`
 *  between nodes and running every listener on the node it reached — which is
 *  what the DOM does. */
function bubble(
  type: string,
  path: Fake[],
  init: Record<string, unknown> = {},
): { stopped: boolean; defaultPrevented: boolean } {
  let stopped = false;
  let defaultPrevented = false;
  const e = {
    ...init,
    stopPropagation: () => {
      stopped = true;
    },
    preventDefault: () => {
      defaultPrevented = true;
    },
  };
  for (const node of path) {
    for (const fn of node.on(type)) fn(e);
    if (stopped) break;
  }
  return { stopped, defaultPrevented };
}

describe("clickable", () => {
  it("answers Enter and Space by preventing the default and running the handler", () => {
    const fired: string[] = [];
    const row = fakeEl();
    clickable(row.el, () => fired.push("row"));

    expect(bubble("keydown", [row], { key: "Enter" }).defaultPrevented).toBe(true);
    expect(bubble("keydown", [row], { key: " " }).defaultPrevented).toBe(true);
    expect(fired).toEqual(["row", "row"]);
  });

  it("leaves other keys alone", () => {
    const fired: string[] = [];
    const row = fakeEl();
    clickable(row.el, () => fired.push("row"));

    expect(bubble("keydown", [row], { key: "Tab" }).defaultPrevented).toBe(false);
    expect(fired).toEqual([]);
  });
});

describe("isolateActivation", () => {
  /** A native button inside a clickable row: the chats sidebar's inline Allow /
   *  Deny, which sits inside a row that reveals the conversation. */
  const nested = () => {
    const fired: string[] = [];
    const row = fakeEl();
    const btn = fakeEl();
    clickable(row.el, () => fired.push("row"));
    isolateActivation(btn.el);
    btn.el.addEventListener("click", () => fired.push("btn"));
    return { row, btn, fired };
  };

  it("keeps Enter on the button from reaching the row", () => {
    const { row, btn, fired } = nested();
    const e = bubble("keydown", [btn, row], { key: "Enter" });
    expect(fired).toEqual([]);
    expect(e.stopped).toBe(true);
  });

  it("leaves the button's own activation intact", () => {
    // The keydown must NOT be default-prevented: that default IS the button's
    // click. Stopping propagation is the whole fix — preventing the default
    // would break the button in the other direction.
    const { row, btn, fired } = nested();
    expect(bubble("keydown", [btn, row], { key: "Enter" }).defaultPrevented).toBe(false);
    // …and the click the browser then synthesizes runs the button, not the row.
    bubble("click", [btn, row]);
    expect(fired).toEqual(["btn"]);
  });

  it("treats Space the same as Enter", () => {
    const { row, btn, fired } = nested();
    expect(bubble("keydown", [btn, row], { key: " " }).stopped).toBe(true);
    expect(fired).toEqual([]);
  });

  it("does not swallow keys the row still needs", () => {
    // The pane's arrow-key axis is bound on an ancestor: over-stopping here
    // would kill navigation whenever focus sat on a decide button.
    const { row, btn } = nested();
    expect(bubble("keydown", [btn, row], { key: "ArrowDown" }).stopped).toBe(false);
  });

  it("stops the mouse click from reaching the row too", () => {
    const { row, btn, fired } = nested();
    expect(bubble("click", [btn, row]).stopped).toBe(true);
    expect(fired).toEqual(["btn"]);
  });
});
