/**
 * Custom icon registration. Lives here rather than in `main.ts` so the plugin
 * lifecycle file carries behaviour, not a wall of SVG path data.
 *
 * `addIcon` wraps whatever it is given in an `<svg viewBox="0 0 100 100">` and
 * that viewBox is NOT configurable — every icon authored on a different grid
 * has to be scaled into it explicitly, which is why the Huge Icons below (a
 * 24x24 grid) are wrapped in `<g transform="scale(4.166667)">` (100/24). Drop
 * that wrapper and the glyph renders at a quarter size in the corner.
 */
import { addIcon } from "obsidian";
import { EXO_ICON } from "../view";
import { BOARD_ICON } from "./board-view";
import { COCKPIT_ICON } from "./cockpit-view";
import { HUB_ICON } from "./hub/hub-view";

/** 100/24 — the Huge Icons grid scaled into addIcon's fixed 100x100 viewBox. */
const HUGE = '<g transform="scale(4.166667)" fill="none" stroke="currentColor"';

export function registerExoIcons(): void {
  // Exo brand mark — a concave 4-point star (matches the product logo).
  // Authored directly on the 100x100 grid, so no scale wrapper.
  addIcon(
    EXO_ICON,
    '<path fill="currentColor" d="M50 3 Q 50 50 97 50 Q 50 50 50 97 Q 50 50 3 50 Q 50 50 50 3 Z"/>',
  );

  // Orchestration board — Huge Icons (hugeicons.com, free/MIT, Stroke Rounded).
  addIcon(
    BOARD_ICON,
    `${HUGE} stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5">` +
      '<path d="M12 21c3.75 0 5.625 0 6.939-.955a5 5 0 0 0 1.106-1.106C21 17.625 21 15.749 21 12s0-5.625-.955-6.939a5 5 0 0 0-1.106-1.106C17.625 3 15.749 3 12 3s-5.625 0-6.939.955A5 5 0 0 0 3.955 5.06C3 6.375 3 8.251 3 12s0 5.625.955 6.939a5 5 0 0 0 1.106 1.106C6.375 21 8.251 21 12 21m0-14v4m5-4v10M7 7v7"/>' +
      "</g>",
  );

  // Connections marketplace — Huge Icons puzzle piece.
  addIcon(
    HUB_ICON,
    `${HUGE} stroke-linejoin="round" stroke-width="1.5">` +
      '<path d="M12.828 6.001a3 3 0 1 0-5.658 0c-2.285.008-3.504.09-4.292.878S2.008 8.886 2 11.17a3 3 0 1 1 0 5.66c.008 2.284.09 3.503.878 4.291s2.007.87 4.291.878a3 3 0 1 1 5.66 0c2.284-.008 3.503-.09 4.291-.878s.87-2.007.878-4.292a3 3 0 1 0 0-5.658c-.008-2.285-.09-3.504-.878-4.292c-.788-.789-2.007-.87-4.292-.878Z"/>' +
      "</g>",
  );

  // Cockpit — Huge Icons dashboard-speed (gauge with needle).
  addIcon(
    COCKPIT_ICON,
    `${HUGE} stroke-width="1.5">` +
      '<path stroke-linecap="round" d="M13.5 13L17 9m-3 6a2 2 0 1 1-4 0a2 2 0 0 1 4 0Zm-8-3a6 6 0 0 1 9-5.197"/>' +
      '<path d="M2.5 12c0-4.478 0-6.717 1.391-8.109c1.392-1.39 3.63-1.39 8.11-1.39c4.477 0 6.717 0 8.108 1.39c1.391 1.392 1.391 3.63 1.391 8.11c0 4.477 0 6.717-1.391 8.108S16.479 21.5 12 21.5c-4.478 0-6.717 0-8.109-1.391c-1.39-1.391-1.39-3.63-1.39-8.109Z"/>' +
      "</g>",
  );
}
