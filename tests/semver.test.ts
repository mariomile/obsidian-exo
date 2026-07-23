import { describe, it, expect } from "vitest";
import { compareSemver, cliVerifyStatus } from "../src/core/semver";

describe("compareSemver", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareSemver("1.0.0", "2.0.0")).toBe(-1);
    expect(compareSemver("1.2.0", "1.10.0")).toBe(-1); // numeric, not lexical
    expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("tolerates a leading v on either side", () => {
    expect(compareSemver("v1.2.3", "1.2.4")).toBe(-1);
    expect(compareSemver("1.2.5", "v1.2.4")).toBe(1);
    expect(compareSemver("v1.0.0", "v1.0.0")).toBe(0);
  });

  it("orders a pre-release below its own release", () => {
    expect(compareSemver("1.2.3-beta", "1.2.3")).toBe(-1);
    expect(compareSemver("1.2.3", "1.2.3-rc.1")).toBe(1);
    expect(compareSemver("1.2.3-alpha", "1.2.3-beta")).toBe(-1);
  });

  it("treats missing/garbage parts as zero", () => {
    expect(compareSemver("1", "1.0.0")).toBe(0);
    expect(compareSemver("1.2", "1.2.0")).toBe(0);
    expect(compareSemver("", "0.0.0")).toBe(0);
    expect(compareSemver("1.x.3", "1.0.3")).toBe(0); // NaN → 0
  });

  it("answers the real question: installed older than latest ⇒ update available", () => {
    // The settings tab calls this as compareSemver(currentVersion, latestKnown).
    const updateAvailable = (cur: string, latest: string) => compareSemver(cur, latest) < 0;
    expect(updateAvailable("v1.4.2", "1.4.3")).toBe(true);
    expect(updateAvailable("v1.4.3", "1.4.3")).toBe(false);
    expect(updateAvailable("v1.5.0", "1.4.3")).toBe(false);
  });

  it("ignores build metadata", () => {
    expect(compareSemver("1.2.3+build.9", "1.2.3")).toBe(0);
  });
});

describe("cliVerifyStatus", () => {
  const range = { min: "2.1.195", maxVerified: "2.1.201" };

  it("inside the verified range (bounds included) → verified", () => {
    expect(cliVerifyStatus("v2.1.195", range)).toBe("verified");
    expect(cliVerifyStatus("v2.1.197", range)).toBe("verified");
    expect(cliVerifyStatus("2.1.201", range)).toBe("verified");
  });

  it("patch drift above maxVerified (same major.minor) → still verified (no noise on routine CLI patches)", () => {
    expect(cliVerifyStatus("v2.1.202", range)).toBe("verified");
    expect(cliVerifyStatus("v2.1.250", range)).toBe("verified");
    expect(cliVerifyStatus("v2.1.999", range)).toBe("verified");
  });

  it("a minor/major bump beyond maxVerified → newer (contracts Exo depends on can shift)", () => {
    expect(cliVerifyStatus("v2.2.0", range)).toBe("newer");
    expect(cliVerifyStatus("v2.10.0", range)).toBe("newer");
    expect(cliVerifyStatus("v3.0.0", range)).toBe("newer");
  });

  it("below min → older", () => {
    expect(cliVerifyStatus("v2.1.194", range)).toBe("older");
    expect(cliVerifyStatus("v1.0.0", range)).toBe("older");
  });

  it("null/garbage version → unknown (never nag on a failed probe)", () => {
    expect(cliVerifyStatus(null, range)).toBe("unknown");
    expect(cliVerifyStatus("", range)).toBe("unknown");
    expect(cliVerifyStatus("not-a-version", range)).toBe("unknown");
  });
});
