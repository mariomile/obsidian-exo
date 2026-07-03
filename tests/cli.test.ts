import { describe, it, expect } from "vitest";
import { fixedPathCandidates, versionManagerCandidates, firstExisting } from "../src/cli";

const HOME = "/home/u";

describe("fixedPathCandidates", () => {
  it("lists canonical install locations in priority order", () => {
    expect(fixedPathCandidates("claude", HOME)).toEqual([
      "/home/u/.claude/local/claude",
      "/home/u/.local/bin/claude",
      "/home/u/.local/node/bin/claude",
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]);
  });
});

describe("versionManagerCandidates", () => {
  it("orders volta, asdf, npm-global, then nvm dirs (newest first)", () => {
    const cands = versionManagerCandidates("claude", HOME, {
      platform: "linux",
      nvmVersions: ["v22.0.0", "v20.0.0"],
    });
    expect(cands).toEqual([
      "/home/u/.volta/bin/claude",
      "/home/u/.asdf/shims/claude",
      "/home/u/.npm-global/bin/claude",
      "/home/u/.nvm/versions/node/v22.0.0/bin/claude",
      "/home/u/.nvm/versions/node/v20.0.0/bin/claude",
    ]);
  });

  it("includes $npm_config_prefix/bin after npm-global when set, and omits it when unset", () => {
    const withPrefix = versionManagerCandidates("codex", HOME, {
      platform: "linux",
      npmConfigPrefix: "/opt/npm",
    });
    expect(withPrefix).toContain("/opt/npm/bin/codex");
    // Sits right after ~/.npm-global/bin.
    expect(withPrefix.indexOf("/opt/npm/bin/codex")).toBe(
      withPrefix.indexOf("/home/u/.npm-global/bin/codex") + 1
    );

    const withoutPrefix = versionManagerCandidates("codex", HOME, { platform: "linux" });
    expect(withoutPrefix.some((c) => c.includes("/opt/npm/"))).toBe(false);
  });

  it("adds the Obsidian-app-adjacent dir only on macOS", () => {
    const mac = versionManagerCandidates("claude", HOME, {
      platform: "darwin",
      execPath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
    });
    expect(mac).toContain("/Applications/Obsidian.app/Contents/MacOS/claude");

    const linux = versionManagerCandidates("claude", HOME, {
      platform: "linux",
      execPath: "/usr/bin/obsidian",
    });
    expect(linux.some((c) => c.includes("Obsidian.app"))).toBe(false);
  });

  it("puts nvm dirs LAST — after every other version-manager location", () => {
    const cands = versionManagerCandidates("claude", HOME, {
      platform: "darwin",
      execPath: "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
      npmConfigPrefix: "/opt/npm",
      nvmVersions: ["v22.0.0"],
    });
    const nvmIdx = cands.findIndex((c) => c.includes("/.nvm/"));
    expect(nvmIdx).toBe(cands.length - 1);
    // Every non-nvm candidate precedes the nvm one.
    expect(cands.slice(0, nvmIdx).every((c) => !c.includes("/.nvm/"))).toBe(true);
  });
});

describe("firstExisting", () => {
  it("returns the first candidate the injected predicate accepts", () => {
    const exists = (p: string) => p === "/b" || p === "/c";
    expect(firstExisting(["/a", "/b", "/c"], exists)).toBe("/b");
  });

  it("returns null when nothing exists", () => {
    expect(firstExisting(["/a", "/b"], () => false)).toBeNull();
  });

  it("pins the incident: a canonical fixed path beats a stale nvm hit", () => {
    // Both a fixed path AND a stale nvm copy 'exist'. Checked as one ordered list
    // (fixed first), the canonical path must win — the shape of today's bug fix.
    const fixed = fixedPathCandidates("claude", HOME);
    const vm = versionManagerCandidates("claude", HOME, {
      platform: "linux",
      nvmVersions: ["v18.0.0"],
    });
    const staleNvm = vm[vm.length - 1];
    const liveHomebrew = "/opt/homebrew/bin/claude";
    const exists = (p: string) => p === liveHomebrew || p === staleNvm;
    expect(firstExisting([...fixed, ...vm], exists)).toBe(liveHomebrew);
  });
});
