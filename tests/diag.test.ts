import { describe, it, expect } from "vitest";
import { DiagLog } from "../src/core/diag";

/** Deterministic clock: starts at a fixed epoch, +1s per push. */
function makeClock(start = 1_750_000_000_000): () => number {
  let t = start;
  return () => (t += 1000);
}

describe("DiagLog", () => {
  it("records entries in order and dumps them with category tags", () => {
    const log = new DiagLog(10, makeClock());
    log.push("turn", "start convo=c1");
    log.push("tool", "Bash start");
    log.push("turn", "end 12s");
    const out = log.dump();
    expect(out).toContain("[turn] start convo=c1");
    expect(out).toContain("[tool] Bash start");
    // Order preserved: start before end.
    expect(out.indexOf("start convo=c1")).toBeLessThan(out.indexOf("end 12s"));
    expect(log.size).toBe(3);
  });

  it("is a ring buffer: evicts the oldest entries beyond capacity", () => {
    const log = new DiagLog(3, makeClock());
    for (let i = 1; i <= 5; i++) log.push("t", `event ${i}`);
    expect(log.size).toBe(3);
    const out = log.dump();
    expect(out).not.toContain("event 1");
    expect(out).not.toContain("event 2");
    expect(out).toContain("event 3");
    expect(out).toContain("event 5");
  });

  it("truncates long messages so a huge payload can never bloat the buffer", () => {
    const log = new DiagLog(10, makeClock());
    log.push("x", "a".repeat(1000));
    const line = log.dump().split("\n").find((l) => l.includes("[x]"))!;
    expect(line.length).toBeLessThan(300);
    expect(line).toContain("…");
  });

  it("dump includes header key/values and a UTC timestamp per entry", () => {
    const log = new DiagLog(10, makeClock());
    log.push("turn", "start");
    const out = log.dump({ version: "0.23.2", provider: "claude" });
    expect(out).toContain("version: 0.23.2");
    expect(out).toContain("provider: claude");
    // ISO-style time prefix (HH:MM:SS) on the entry line.
    expect(out).toMatch(/\d{2}:\d{2}:\d{2}.*\[turn\] start/);
  });

  it("dump of an empty log still renders the header (no crash, no undefined)", () => {
    const log = new DiagLog(10, makeClock());
    const out = log.dump({ version: "x" });
    expect(out).toContain("version: x");
    expect(out).not.toContain("undefined");
  });
});
