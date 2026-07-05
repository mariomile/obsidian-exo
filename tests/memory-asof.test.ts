import { describe, it, expect } from "vitest";
import { currentAsOf, isValidAsOfDate } from "../src/core/memory-asof";
import type { MemoryEntry } from "../src/core/memory-store";

/** Epoch ms at noon UTC on `date` — any time of day maps to the same UTC calendar day. */
function at(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 12, 0, 0);
}

function e(id: string, date: string, over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    kind: "fact",
    at: at(date),
    session: "s",
    tags: [],
    source: "user",
    text: id,
    ...over,
  };
}

const ids = (entries: MemoryEntry[]) => entries.map((x) => x.id);

describe("isValidAsOfDate", () => {
  it("accepts real calendar dates in YYYY-MM-DD", () => {
    expect(isValidAsOfDate("2024-07-03")).toBe(true);
    expect(isValidAsOfDate("2026-12-31")).toBe(true);
    expect(isValidAsOfDate("2024-02-29")).toBe(true); // leap year
  });

  it("rejects malformed shapes", () => {
    expect(isValidAsOfDate("2024-7-3")).toBe(false);
    expect(isValidAsOfDate("07-03-2024")).toBe(false);
    expect(isValidAsOfDate("2024/07/03")).toBe(false);
    expect(isValidAsOfDate("not a date")).toBe(false);
    expect(isValidAsOfDate("")).toBe(false);
    expect(isValidAsOfDate("2024-07-03T00:00:00Z")).toBe(false);
  });

  it("rejects impossible calendar dates that still match the shape", () => {
    expect(isValidAsOfDate("2024-13-01")).toBe(false); // month 13
    expect(isValidAsOfDate("2024-00-10")).toBe(false); // month 0
    expect(isValidAsOfDate("2024-02-30")).toBe(false); // Feb 30
    expect(isValidAsOfDate("2023-02-29")).toBe(false); // not a leap year
    expect(isValidAsOfDate("2024-04-31")).toBe(false); // Apr has 30 days
  });
});

describe("currentAsOf — point-in-time belief resolution", () => {
  it("keeps an entry that is superseded only AFTER D, and marks the later supersession", () => {
    const a = e("mem-a", "2024-01-01");
    const b = e("mem-b", "2024-03-01", { supersedes: "mem-a" });

    // Between the two: A is still the current belief.
    const mid = currentAsOf([a, b], "2024-02-01");
    expect(ids(mid.current)).toEqual(["mem-a"]);
    expect(mid.supersededAfter.get("mem-a")).toEqual({ by: "mem-b", on: "2024-03-01" });

    // After B lands: A drops out, B is current, no later supersession.
    const post = currentAsOf([a, b], "2024-03-05");
    expect(ids(post.current)).toEqual(["mem-b"]);
    expect(post.supersededAfter.has("mem-b")).toBe(false);
  });

  it("excludes an entry superseded on/before D", () => {
    const a = e("mem-a", "2024-01-01");
    const b = e("mem-b", "2024-02-01", { supersedes: "mem-a" });
    // Query exactly on the supersession date: on/before ⇒ A already excluded.
    expect(ids(currentAsOf([a, b], "2024-02-01").current)).toEqual(["mem-b"]);
    expect(ids(currentAsOf([a, b], "2024-06-01").current)).toEqual(["mem-b"]);
  });

  it("excludes entries created strictly after D (they do not exist yet)", () => {
    const a = e("mem-a", "2024-01-01");
    const future = e("mem-future", "2024-05-01");
    expect(ids(currentAsOf([a, future], "2024-03-01").current)).toEqual(["mem-a"]);
  });

  it("resolves a chain A←B←C at each epoch", () => {
    const a = e("mem-a", "2024-01-01");
    const b = e("mem-b", "2024-01-10", { supersedes: "mem-a" });
    const c = e("mem-c", "2024-01-20", { supersedes: "mem-b" });
    const all = [a, b, c];

    const t1 = currentAsOf(all, "2024-01-05"); // only A exists
    expect(ids(t1.current)).toEqual(["mem-a"]);
    expect(t1.supersededAfter.get("mem-a")).toEqual({ by: "mem-b", on: "2024-01-10" });

    const t2 = currentAsOf(all, "2024-01-15"); // A superseded by B; C not yet
    expect(ids(t2.current)).toEqual(["mem-b"]);
    expect(t2.supersededAfter.get("mem-b")).toEqual({ by: "mem-c", on: "2024-01-20" });

    const t3 = currentAsOf(all, "2024-01-25"); // C is the current belief
    expect(ids(t3.current)).toEqual(["mem-c"]);
    expect(t3.supersededAfter.size).toBe(0);
  });

  it("guards against supersedes cycles without infinite-looping", () => {
    // A supersedes B and B supersedes A — nonsense, but must terminate.
    const a = e("mem-a", "2024-01-01", { supersedes: "mem-b" });
    const b = e("mem-b", "2024-01-02", { supersedes: "mem-a" });
    const res = currentAsOf([a, b], "2024-02-01");
    // Both are superseded by the other (on/before D) ⇒ neither is current.
    expect(ids(res.current)).toEqual([]);
  });

  it("guards against a self-supersede (A supersedes A)", () => {
    const a = e("mem-a", "2024-01-01", { supersedes: "mem-a" });
    // An entry cannot supersede itself out of existence.
    expect(ids(currentAsOf([a], "2024-02-01").current)).toEqual(["mem-a"]);
  });

  it("tolerates a supersedes pointer to a non-existent id", () => {
    const x = e("mem-x", "2024-01-01", { supersedes: "mem-missing" });
    expect(ids(currentAsOf([x], "2024-02-01").current)).toEqual(["mem-x"]);
  });

  it("treats a date-less entry (at=0 parse fallback) conservatively — present for every D", () => {
    // parseStoreFile falls back to epoch 0 when neither `at:` nor the id carry a
    // timestamp; such an entry sorts to 1970-01-01 and is therefore included in
    // every as-of query (we'd rather surface an early belief than hide a memory).
    const dateless = e("mem-dateless", "2024-01-01");
    dateless.at = 0;
    const res = currentAsOf([dateless], "2024-01-01");
    expect(ids(res.current)).toEqual(["mem-dateless"]);
  });

  it("returns an empty resolution for an empty corpus", () => {
    const res = currentAsOf([], "2024-01-01");
    expect(res.current).toEqual([]);
    expect(res.supersededAfter.size).toBe(0);
  });

  it("marks the EARLIEST later superseder when several name the same target", () => {
    const a = e("mem-a", "2024-01-01");
    const later = e("mem-later", "2024-05-01", { supersedes: "mem-a" });
    const earlier = e("mem-earlier", "2024-03-01", { supersedes: "mem-a" });
    const res = currentAsOf([a, later, earlier], "2024-02-01");
    expect(ids(res.current)).toEqual(["mem-a"]);
    expect(res.supersededAfter.get("mem-a")).toEqual({ by: "mem-earlier", on: "2024-03-01" });
  });
});
