/**
 * Incremental block-boundary scan — extracted verbatim from `view.ts`.
 *
 * `ScanState` is a narrow view of the four fields the scan touches;
 * `AssistantCtx` in `view.ts` structurally satisfies it, so the call site stays
 * `advanceBoundary(ctx)`.
 */
export interface ScanState {
  curRaw: string;
  scanPos: number;
  fenceOpen: boolean;
  lastBoundary: number;
}

/** Advance the incremental block-boundary scan over the not-yet-scanned suffix
 * of `ctx.curRaw` and return the index just after the last blank-line boundary
 * that is not inside a ``` fence (0 if none). Only complete (newline-terminated)
 * lines are consumed — the trailing partial line waits for its newline — so each
 * streaming tick costs O(new chars), not O(total). Rendering the prefix up to
 * the returned boundary is layout-stable. */
export function advanceBoundary(ctx: ScanState): number {
  const raw = ctx.curRaw;
  let nl: number;
  while ((nl = raw.indexOf("\n", ctx.scanPos)) !== -1) {
    const t = raw.slice(ctx.scanPos, nl).trim();
    if (/^(```|~~~)/.test(t)) ctx.fenceOpen = !ctx.fenceOpen;
    ctx.scanPos = nl + 1;
    if (!ctx.fenceOpen && t === "") ctx.lastBoundary = ctx.scanPos;
  }
  return ctx.lastBoundary;
}
