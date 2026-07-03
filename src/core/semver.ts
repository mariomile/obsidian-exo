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
