/**
 * Strip density — whether the tab strip renders full titles or marks only.
 *
 * The decision is a RATIO, not a width. A fixed breakpoint is wrong in both
 * directions: two tabs are comfortable in 356px, six are cramped in 1000px.
 * What matters is how much room a wide render would leave each non-active tab.
 *
 * Pure (no `obsidian`, no DOM, no clock) so the policy is testable without
 * mounting a view — same discipline as the other cores here.
 */

export type StripDensity = "wide" | "dense";

/** Below this many pixels per non-active tab, a wide render is not readable. */
const ENTER_DENSE_PX = 90;
/** And back to wide only well above it. The gap between the two is deliberate:
 *  with one threshold, dragging a splitter across the boundary would oscillate
 *  the whole strip pixel by pixel. */
const EXIT_DENSE_PX = 110;

export interface DensityInput {
  /** Width the strip can actually use, excluding the trailing controls. */
  availableWidth: number;
  tabCount: number;
  /** What the active tab takes when it shows its title. */
  activeTabWidth: number;
  /** The density in effect right now — the hysteresis needs it. */
  current: StripDensity;
}

export function chooseDensity(m: DensityInput): StripDensity {
  // Not laid out yet: never flip on a measurement we do not have. Flipping and
  // flipping back one frame later is a visible flash.
  if (m.availableWidth <= 0) return m.current;
  // One tab: the strip hides anyway, and the division below would have no
  // divisor. Wide is the neutral answer.
  if (m.tabCount <= 1) return "wide";

  const perTab = (m.availableWidth - m.activeTabWidth) / (m.tabCount - 1);
  if (m.current === "dense") return perTab > EXIT_DENSE_PX ? "wide" : "dense";
  return perTab < ENTER_DENSE_PX ? "dense" : "wide";
}
