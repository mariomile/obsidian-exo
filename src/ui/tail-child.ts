import { Component } from "obsidian";
import type { AssistantCtx } from "./convo-types";

/** Unload the tail's previous owning Component before handing back a fresh
 *  one. `tail.empty()` only removes nodes, never `onunload()` — so a
 *  post-processor mount with async work in flight (Glance's link-preview
 *  fetch) leaks its store subscription onto `owner` forever, and its card can
 *  go stuck-loading even after the fetch resolves. */
export function swapTailChild(owner: Component, ctx: AssistantCtx): Component {
  if (ctx.tailChild) owner.removeChild(ctx.tailChild);
  const child = new Component();
  owner.addChild(child);
  ctx.tailChild = child;
  return child;
}
