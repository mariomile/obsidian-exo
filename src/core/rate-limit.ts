/**
 * Pure logic for the Claude-plan quota badge (Trust Pack). The SDK emits
 * `rate_limit_event` messages carrying an `SDKRateLimitInfo` — but only for
 * claude.ai subscription sessions (API-key users never get one, so the badge
 * simply never appears). This module normalizes the raw shape and decides the
 * badge's visibility/level so `view.ts` stays free of arithmetic.
 *
 * Two defensive normalizations, both verified against a real event captured
 * during the spike (`{status:"allowed_warning", resetsAt:1783191600,
 * rateLimitType:"seven_day", utilization:0.8}`):
 *   - `utilization` arrived as a FRACTION 0-1 (0.8 = 80%), not 0-100 as the
 *     type comment implies — we coerce either convention to a 0-100 percent.
 *   - `resetsAt` arrived as epoch SECONDS (10 digits) — we coerce seconds or
 *     milliseconds to milliseconds by magnitude.
 */

export type RateStatus = "allowed" | "allowed_warning" | "rejected";

/** Coerce utilization to a 0-100 percent, accepting either a 0-1 fraction
 *  (observed) or an already-0-100 value. Returns undefined when absent. */
export function normalizeUtilization(u?: number): number | undefined {
  if (typeof u !== "number" || Number.isNaN(u)) return undefined;
  const pct = u <= 1 ? u * 100 : u;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/** Coerce a reset timestamp to epoch milliseconds, accepting either seconds
 *  (observed, 10 digits) or milliseconds by magnitude. Returns undefined when
 *  absent or non-positive. */
export function normalizeResetEpochMs(resetsAt?: number): number | undefined {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return undefined;
  // < 1e12 ms ≈ before 2001, so any plausible reset given in that range is seconds.
  return resetsAt < 1e12 ? Math.round(resetsAt * 1000) : Math.round(resetsAt);
}

/** Human label for the rate-limit window from the SDK's rateLimitType. */
export function windowLabel(rateLimitType?: string): string {
  if (!rateLimitType) return "usage";
  if (rateLimitType === "five_hour") return "5-hour";
  if (rateLimitType.startsWith("seven_day")) return "weekly";
  if (rateLimitType === "overage") return "overage";
  return "usage";
}

/** Local HH:MM (24h) for an epoch-ms timestamp. Split out so callers format a
 *  reset time without re-deriving Date fields; timezone-consistent (both the
 *  input Date and this reader use local time). */
export function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export interface BadgeState {
  /** Whether the badge should be shown at all. */
  visible: boolean;
  /** Severity — drives the theme color (caution = orange, danger = red). */
  level: "ok" | "caution" | "danger";
  /** Compact text: a percent ("83%") or the literal "limit" when rejected. */
  label: string;
}

/**
 * Decide whether the badge shows and how loud it is. Quiet by design: hidden
 * while there's plenty of headroom (status 'allowed' AND utilization < 80),
 * caution once the plan warns or crosses 80%, danger only when the plan
 * actually rejects a request.
 */
export function badgeState(status: RateStatus | undefined, utilization?: number): BadgeState {
  const pct = normalizeUtilization(utilization);
  if (status === "rejected") {
    return { visible: true, level: "danger", label: "limit" };
  }
  const highUtil = typeof pct === "number" && pct >= 80;
  if (status === "allowed_warning" || highUtil) {
    return { visible: true, level: "caution", label: typeof pct === "number" ? `${pct}%` : "high" };
  }
  return { visible: false, level: "ok", label: typeof pct === "number" ? `${pct}%` : "" };
}
