import { describe, it, expect } from "vitest";
import {
  normalizeSentinelPaths,
  sentinelRecordArgs,
  SENTINEL_AGENT,
} from "../src/core/write-sentinel";

const VAULT = "/Users/m/Vaults/marioverse.ai";

describe("normalizeSentinelPaths", () => {
  it("strips the vault prefix so sessions collide on the same key", () => {
    expect(normalizeSentinelPaths([`${VAULT}/Journal/Daily/30-07-2026.md`], VAULT)).toEqual([
      "Journal/Daily/30-07-2026.md",
    ]);
  });

  it("keeps already-relative paths as-is", () => {
    expect(normalizeSentinelPaths(["Atlas/People/Mario.md"], VAULT)).toEqual([
      "Atlas/People/Mario.md",
    ]);
  });

  it("drops absolute paths outside the vault — not shared state", () => {
    expect(normalizeSentinelPaths(["/etc/passwd", "/tmp/scratch.md"], VAULT)).toEqual([]);
  });

  it("drops traversal and empty entries", () => {
    expect(normalizeSentinelPaths(["../outside.md", "  ", "a/../../b.md"], VAULT)).toEqual([]);
  });

  it("normalizes backslashes and a leading ./", () => {
    expect(normalizeSentinelPaths(["./Notes\\Sub\\file.md"], VAULT)).toEqual(["Notes/Sub/file.md"]);
  });

  it("dedupes so one turn writing a file twice records it once", () => {
    expect(
      normalizeSentinelPaths([`${VAULT}/note.md`, "note.md", "./note.md"], VAULT),
    ).toEqual(["note.md"]);
  });

  it("tolerates a vault path with a trailing slash", () => {
    expect(normalizeSentinelPaths([`${VAULT}/note.md`], `${VAULT}/`)).toEqual(["note.md"]);
  });
});

describe("sentinelRecordArgs", () => {
  it("returns null when there is nothing to record", () => {
    expect(sentinelRecordArgs("/s.mjs", [])).toBeNull();
  });

  it("builds the record argv", () => {
    expect(sentinelRecordArgs("/s.mjs", ["a.md", "b.md"])).toEqual([
      "/s.mjs",
      "record",
      "a.md",
      "b.md",
    ]);
  });

  it("caps the path count so a huge turn cannot blow up argv", () => {
    const many = Array.from({ length: 100 }, (_, i) => `n${i}.md`);
    const args = sentinelRecordArgs("/s.mjs", many, 40);
    expect(args).not.toBeNull();
    expect(args!.length).toBe(42); // script + "record" + 40 paths
  });
});

describe("SENTINEL_AGENT", () => {
  it("labels plugin writes distinctly from CLI sessions", () => {
    expect(SENTINEL_AGENT).toBe("exo");
  });
});
