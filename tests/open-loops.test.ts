import { describe, it, expect } from "vitest";
import {
  formatLoop,
  parseLoopsFile,
  activeLoops,
  dueLoops,
  closeLoop,
  type LoopEntry,
} from "../src/core/open-loops";

const T = Date.UTC(2024, 6, 3, 12, 0, 0); // 2024-07-03T12:00:00.000Z

function loop(over: Partial<LoopEntry> = {}): LoopEntry {
  return {
    id: `loop-${T}`,
    title: "Follow up with Marco",
    note: "He asked for the pricing deck by Friday.",
    openedAt: T,
    status: "open",
    ...over,
  };
}

describe("formatLoop / parseLoopsFile round-trip", () => {
  it("round-trips a minimal open loop (no resurface, tags, closedAt)", () => {
    const e = loop();
    const parsed = parseLoopsFile(formatLoop(e));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(e);
  });

  it("round-trips resurface, tags and closedAt when present", () => {
    const e = loop({
      resurface: "2024-08-01",
      tags: ["career", "outreach"],
      status: "closed",
      closedAt: T + 1000,
    });
    const parsed = parseLoopsFile(formatLoop(e));
    expect(parsed[0]).toEqual(e);
  });

  it("omits resurface/tags/closed lines when absent", () => {
    const block = formatLoop(loop());
    expect(block).not.toContain("resurface:");
    expect(block).not.toContain("tags:");
    expect(block).not.toContain("closed:");
  });

  it("preserves multi-line verbatim note including internal blank lines", () => {
    const e = loop({ note: "line one\n\n- a bullet\n- another\n\nfinal para" });
    const parsed = parseLoopsFile(formatLoop(e));
    expect(parsed[0].note).toBe(e.note);
  });

  it("round-trips several entries concatenated into one file", () => {
    const a = loop({ id: "loop-1", openedAt: 1, note: "first" });
    const b = loop({ id: "loop-2", openedAt: 2, note: "second\nmore", tags: ["x"] });
    const file = [formatLoop(a), formatLoop(b)].join("\n\n");
    expect(parseLoopsFile(file)).toEqual([a, b]);
  });

  it("falls back to the id-embedded epoch when the opened: line is missing", () => {
    const file = `## loop-42\n- title: untitled\n- status: open\n\nhello`;
    const parsed = parseLoopsFile(file);
    expect(parsed[0].openedAt).toBe(42);
  });
});

describe("parseLoopsFile — junk tolerance", () => {
  it("ignores leading prose and hand-edited garbage between blocks, recovers every real block", () => {
    const a = loop({ id: "loop-1", openedAt: 1, note: "first" });
    const b = loop({ id: "loop-2", openedAt: 2, note: "second" });
    const file =
      "# a human heading someone typed\n\nsome loose prose I jotted down\n\n" +
      formatLoop(a) +
      "\n\nrandom junk line that isn't a block\n- not-a-real-key: whatever\n\n" +
      formatLoop(b) +
      "\n\ntrailing junk\n";
    const parsed = parseLoopsFile(file);
    // Leading prose is ignored; both real blocks are recovered with correct ids.
    // Junk between blocks has no terminator of its own, so — same tolerant-parsing
    // contract as `memory-store.ts` — it's absorbed into the preceding block's note.
    expect(parsed.map((e) => e.id)).toEqual(["loop-1", "loop-2"]);
    expect(parsed[0].note.startsWith("first")).toBe(true);
    expect(parsed[1].note.startsWith("second")).toBe(true);
  });

  it("never throws on a totally malformed file", () => {
    expect(() => parseLoopsFile("not even close to a loop block\n---\nrandom")).not.toThrow();
    expect(parseLoopsFile("not even close to a loop block\n---\nrandom")).toEqual([]);
  });

  it("defaults status to open when the status line is missing or garbage", () => {
    const missing = parseLoopsFile(`## loop-5\n- title: x\n- opened: 2024-01-01T00:00:00.000Z\n\nbody`);
    expect(missing[0].status).toBe("open");
    const garbage = parseLoopsFile(
      `## loop-6\n- title: x\n- opened: 2024-01-01T00:00:00.000Z\n- status: banana\n\nbody`
    );
    expect(garbage[0].status).toBe("open");
  });
});

describe("dueLoops — tickler / timezone-safe local-date logic", () => {
  it("a loop with no resurface date is due immediately", () => {
    const e = loop();
    expect(dueLoops([e], T)).toEqual([e]);
  });

  it("excludes a loop whose resurface date is in the future", () => {
    const e = loop({ resurface: "2099-01-01" });
    expect(dueLoops([e], T)).toEqual([]);
  });

  it("includes a loop whose resurface date is today (local-date boundary, inclusive)", () => {
    const now = new Date(2024, 6, 15, 9, 30); // local 2024-07-15 09:30
    const e = loop({ resurface: "2024-07-15" });
    expect(dueLoops([e], now)).toEqual([e]);
  });

  it("is timezone-safe: due regardless of time-of-day, as long as the local calendar day matches", () => {
    const lateNight = new Date(2024, 6, 15, 23, 59);
    const earlyMorning = new Date(2024, 6, 15, 0, 1);
    const e = loop({ resurface: "2024-07-15" });
    expect(dueLoops([e], lateNight)).toEqual([e]);
    expect(dueLoops([e], earlyMorning)).toEqual([e]);
  });

  it("includes a loop whose resurface date is in the past", () => {
    const now = new Date(2024, 6, 15);
    const e = loop({ resurface: "2024-01-01" });
    expect(dueLoops([e], now)).toEqual([e]);
  });

  it("excludes closed loops regardless of resurface date", () => {
    const now = new Date(2024, 6, 15);
    const e = loop({ resurface: "2020-01-01", status: "closed", closedAt: T });
    expect(dueLoops([e], now)).toEqual([]);
  });
});

describe("activeLoops", () => {
  it("returns only open loops", () => {
    const open = loop({ id: "loop-1" });
    const closed = loop({ id: "loop-2", status: "closed", closedAt: T });
    expect(activeLoops([open, closed])).toEqual([open]);
  });
});

describe("closeLoop — append-only close semantics", () => {
  it("flips status to closed and sets closedAt, preserving the original note when no outcome is given", () => {
    const e = loop();
    const [closed] = closeLoop([e], e.id, undefined, T + 5000);
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toBe(T + 5000);
    expect(closed.note).toBe(e.note);
    expect(closed.id).toBe(e.id);
    expect(closed.title).toBe(e.title);
    expect(closed.openedAt).toBe(e.openedAt);
  });

  it("appends the outcome to the note without discarding the original content", () => {
    const e = loop();
    const [closed] = closeLoop([e], e.id, "Sent the deck, he replied thanks.", T + 5000);
    expect(closed.note).toContain(e.note);
    expect(closed.note).toContain("Sent the deck, he replied thanks.");
  });

  it("leaves other entries in the list untouched", () => {
    const a = loop({ id: "loop-1" });
    const b = loop({ id: "loop-2", title: "Other loop" });
    const result = closeLoop([a, b], "loop-1", undefined, T + 5000);
    const untouched = result.find((r) => r.id === "loop-2");
    expect(untouched).toEqual(b);
  });

  it("throws when the id does not exist (never silently deletes/loses data)", () => {
    const e = loop();
    expect(() => closeLoop([e], "loop-does-not-exist")).toThrow();
  });

  it("round-trips through format/parse after closing", () => {
    const e = loop();
    const [closed] = closeLoop([e], e.id, "done", T + 5000);
    const parsed = parseLoopsFile(formatLoop(closed));
    expect(parsed[0]).toEqual(closed);
  });
});
