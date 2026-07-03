import { describe, it, expect } from "vitest";
import { maxIdSuffix, makeIdAllocator } from "../src/core/ids";

describe("maxIdSuffix", () => {
  it("seeds from the highest numeric suffix, not the count (the 'c31' collision bug)", () => {
    // Real incident: 19 conversations with ids c12..c30 (they climbed past the
    // count after deletions/trimming). A count-based seed (19) would mint c20,
    // colliding with an existing id. maxIdSuffix must return 30.
    const ids = Array.from({ length: 19 }, (_, i) => `c${12 + i}`); // c12..c30
    expect(maxIdSuffix(ids)).toBe(30);
  });

  it("ignores duplicate suffixes and non-matching ids", () => {
    expect(maxIdSuffix(["c30", "c30", "hello", "", undefined, null, "c7"])).toBe(30);
  });

  it("returns 0 when nothing matches", () => {
    expect(maxIdSuffix([])).toBe(0);
    expect(maxIdSuffix(["x", "", undefined])).toBe(0);
  });

  it("does not match ids with non-digit suffixes", () => {
    expect(maxIdSuffix(["c1a", "cx", "c"])).toBe(0);
  });
});

describe("makeIdAllocator", () => {
  it("never reuses an existing id after seeding from the max suffix (c31 bug)", () => {
    // c12..c30 plus several duplicate c30 husks — the exact shape that produced
    // five conversations sharing "c31" under the old count-based seed.
    const stored = ["c12", "c13", "c30", "c30", "c30", "c30"];
    const seed = maxIdSuffix(stored); // 30, NOT the count (6)
    const alloc = makeIdAllocator(seed);
    const seen = new Set<string>();
    const assigned = stored.map((id) => alloc.assign(id, seen));

    // Every assigned id is unique — no reused/colliding id.
    expect(new Set(assigned).size).toBe(assigned.length);
    // The first c30 is kept; each later duplicate gets a fresh id strictly > 30.
    expect(assigned[2]).toBe("c30");
    for (const id of assigned.slice(3)) {
      expect(Number(/^c(\d+)$/.exec(id)![1])).toBeGreaterThan(30);
    }
    // The next minted id also climbs strictly past 30 (never a reused low value).
    expect(Number(/^c(\d+)$/.exec(alloc.next())![1])).toBeGreaterThan(30);
  });

  it("keeps the first occurrence's id and reassigns duplicates to a fresh id", () => {
    const alloc = makeIdAllocator(5);
    const seen = new Set<string>();
    expect(alloc.assign("c3", seen)).toBe("c3"); // first occurrence kept
    const dup = alloc.assign("c3", seen); // collision → fresh
    expect(dup).not.toBe("c3");
    expect(dup).toBe("c6"); // seed 5 → ++counter = c6
  });

  it("gives a fresh id when the stored id is missing", () => {
    const alloc = makeIdAllocator(10);
    const seen = new Set<string>();
    expect(alloc.assign(undefined, seen)).toBe("c11");
    expect(alloc.assign("", seen)).toBe("c12");
  });

  it("exposes the current seed for syncing back the module-global counter", () => {
    const alloc = makeIdAllocator(4);
    const seen = new Set<string>();
    alloc.assign(undefined, seen); // c5
    alloc.next(); // c6
    expect(alloc.seed).toBe(6);
  });
});
