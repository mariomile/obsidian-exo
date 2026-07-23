/**
 * Tiny semver comparison — enough to answer "is the installed CLI older than the
 * latest published version?" without pulling in a dependency. Tolerant of a
 * leading "v" and of pre-release / build suffixes.
 */

/** Compare two semver-ish strings. Returns -1 if `a` < `b`, 0 if equal, 1 if
 *  `a` > `b`. Numeric core (major.minor.patch) is compared first; on a tie a
 *  pre-release is ordered BELOW its release (1.2.3-beta < 1.2.3), and two
 *  pre-releases compare lexically. Missing/garbage parts count as 0. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  // Equal numeric core: a release outranks any pre-release of the same core.
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // a is a release, b is a pre-release → a > b
  if (!pb.pre) return -1; // a is a pre-release, b is a release → a < b
  return pa.pre < pb.pre ? -1 : 1; // both pre-release → lexical
}

function parseSemver(v: string): { nums: [number, number, number]; pre: string } {
  const s = (v || "").trim().replace(/^v/i, "");
  // Strip build metadata (+…), then split off any pre-release (-…).
  const noBuild = s.split("+")[0];
  const dash = noBuild.indexOf("-");
  const core = dash === -1 ? noBuild : noBuild.slice(0, dash);
  const pre = dash === -1 ? "" : noBuild.slice(dash + 1);
  const parts = core.split(".");
  return { nums: [toInt(parts[0]), toInt(parts[1]), toInt(parts[2])], pre };
}

function toInt(x: string | undefined): number {
  const n = parseInt(x ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

/** The Claude CLI range Exo's session behaviors are verified against.
 *  Exo depends on per-version CLI behaviors (interrupt → error_during_execution
 *  classification, system/init caps in streaming-input mode, result.usage), so
 *  drift outside this range should be *visible*, not a mystery bug. Bump
 *  maxVerified after running `npm run smoke` against a newer CLI.
 *
 *  Note: {@link cliVerifyStatus} tolerates *patch-level* drift above maxVerified
 *  (same major.minor) — Anthropic ships CLI patches often and they almost never
 *  touch these contracts, so nagging end users on every patch is pure noise. A
 *  minor/major bump, where the contracts can actually change, still surfaces. */
export const VERIFIED_CLAUDE_CLI = { min: "2.1.195", maxVerified: "2.1.218" };

export type CliVerifyStatus = "verified" | "newer" | "older" | "unknown";

/** Classify an installed CLI version against a verified range. `null` or a
 *  garbage string (failed probe) → "unknown" — never nag on a bad read.
 *
 *  Above maxVerified we distinguish patch drift from a real jump: a version in
 *  the *same major.minor* as maxVerified (e.g. 2.1.219 vs a 2.1.218 ceiling) is
 *  still "verified" — routine patch, low risk. Only a higher major.minor
 *  (2.2.x, 3.x) is "newer", because that's where the SDK contracts Exo leans on
 *  can shift. Below min is always "older". */
export function cliVerifyStatus(
  version: string | null,
  range: { min: string; maxVerified: string }
): CliVerifyStatus {
  if (!version || !/\d+\.\d+\.\d+/.test(version)) return "unknown";
  if (compareSemver(version, range.min) < 0) return "older";
  if (compareSemver(version, range.maxVerified) <= 0) return "verified";
  return sameMajorMinor(version, range.maxVerified) ? "verified" : "newer";
}

/** True when two versions share the same major.minor (patch/pre-release differ). */
function sameMajorMinor(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  return pa.nums[0] === pb.nums[0] && pa.nums[1] === pb.nums[1];
}
