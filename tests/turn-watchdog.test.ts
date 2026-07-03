import { describe, it, expect } from "vitest";
import { TurnWatchdog } from "../src/core/turn-watchdog";

const IDLE = 120_000;
const TOOL = 600_000;

/** Minimal deterministic scheduler matching setTimer/clearTimer's shape. */
class FakeClock {
  now = 0;
  private seq = 1;
  private timers = new Map<number, { fn: () => void; at: number }>();

  readonly set = (fn: () => void, ms: number): number => {
    const id = this.seq++;
    this.timers.set(id, { fn, at: this.now + ms });
    return id;
  };
  readonly clear = (id: number): void => {
    this.timers.delete(id);
  };
  /** Advance the clock, firing every timer whose deadline is now due (in order). */
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= this.now) {
        this.timers.delete(id);
        t.fn();
      }
    }
  }
}

function make(clock: FakeClock, onTimeout: (byTool: boolean) => void = () => {}): TurnWatchdog {
  return new TurnWatchdog({ idleMs: IDLE, toolMs: TOOL, onTimeout, setTimer: clock.set, clearTimer: clock.clear });
}

describe("TurnWatchdog", () => {
  it("fires on the idle window after bump", () => {
    const clock = new FakeClock();
    const wd = make(clock);
    wd.bump();
    clock.advance(IDLE - 1);
    expect(wd.fired).toBe(false);
    clock.advance(1);
    expect(wd.fired).toBe(true);
    expect(wd.firedByTool).toBe(false);
  });

  it("does not fire without an initial bump", () => {
    const clock = new FakeClock();
    const wd = make(clock);
    clock.advance(TOOL * 2);
    expect(wd.fired).toBe(false);
  });

  it("bump re-arms the idle window (cancels the pending timer)", () => {
    const clock = new FakeClock();
    let fires = 0;
    const wd = make(clock, () => fires++);
    wd.bump();
    clock.advance(IDLE - 10); // almost due
    wd.bump(); // re-arm from now
    clock.advance(IDLE - 10); // the FIRST arm would have fired here — but was cancelled
    expect(wd.fired).toBe(false);
    clock.advance(10); // reach the second arm's deadline
    expect(wd.fired).toBe(true);
    expect(fires).toBe(1);
  });

  it("toolStart switches to the tool window; idle span alone does not fire", () => {
    const clock = new FakeClock();
    const wd = make(clock);
    wd.toolStart("t1");
    clock.advance(IDLE); // past the idle window, but armed on the tool window
    expect(wd.fired).toBe(false);
    clock.advance(TOOL - IDLE); // reach the tool deadline
    expect(wd.fired).toBe(true);
    expect(wd.firedByTool).toBe(true);
  });

  it("toolEnd on the last tool re-arms the idle window", () => {
    const clock = new FakeClock();
    const wd = make(clock);
    wd.toolStart("t1");
    clock.advance(IDLE); // still on the tool window, not fired
    wd.toolEnd("t1"); // drains → re-arm on idle
    clock.advance(IDLE - 1);
    expect(wd.fired).toBe(false);
    clock.advance(1);
    expect(wd.fired).toBe(true);
    expect(wd.firedByTool).toBe(false);
  });

  it("keeps the tool window while ≥1 tool remains in flight", () => {
    const clock = new FakeClock();
    const wd = make(clock);
    wd.toolStart("t1");
    wd.toolStart("t2");
    wd.toolEnd("t1"); // t2 still in flight → re-arm still on tool window
    clock.advance(IDLE);
    expect(wd.fired).toBe(false);
    clock.advance(TOOL - IDLE);
    expect(wd.fired).toBe(true);
    expect(wd.firedByTool).toBe(true);
  });

  it("toolEnd for an unknown id is a no-op (does not re-arm)", () => {
    const clock = new FakeClock();
    const wd = make(clock);
    wd.toolStart("t1");
    clock.advance(100);
    wd.toolEnd("nope"); // unknown — must NOT re-arm (window stays the t1 arm)
    // If it had re-armed, the tool window would restart from now (100). Instead the
    // original arm (from time 0) reaches TOOL first.
    clock.advance(TOOL - 100);
    expect(wd.fired).toBe(true); // original arm fired on schedule
    expect(wd.firedByTool).toBe(true);
  });

  it("suspendCard cancels the timer and blocks bump", () => {
    const clock = new FakeClock();
    const wd = make(clock);
    wd.bump();
    wd.suspendCard(); // an interactive card opened
    wd.bump(); // NO-OP while a card is pending
    clock.advance(TOOL * 2);
    expect(wd.fired).toBe(false);
  });

  it("resumeCard to zero re-arms the idle window", () => {
    const clock = new FakeClock();
    const wd = make(clock);
    wd.suspendCard();
    wd.resumeCard(); // back to zero → re-arm
    clock.advance(IDLE);
    expect(wd.fired).toBe(true);
  });

  it("nested cards only re-arm once the LAST resolves", () => {
    const clock = new FakeClock();
    const wd = make(clock);
    wd.suspendCard();
    wd.suspendCard();
    wd.resumeCard(); // one still pending — must not re-arm
    clock.advance(TOOL * 2);
    expect(wd.fired).toBe(false);
    wd.resumeCard(); // last one → re-arm
    clock.advance(IDLE);
    expect(wd.fired).toBe(true);
  });

  it("clear() cancels the pending timer so nothing fires", () => {
    const clock = new FakeClock();
    const wd = make(clock);
    wd.bump();
    wd.clear();
    clock.advance(TOOL * 2);
    expect(wd.fired).toBe(false);
  });

  it("clear() resets in-flight tools so a later idle arm uses the idle window", () => {
    const clock = new FakeClock();
    const wd = make(clock);
    wd.toolStart("t1");
    wd.clear(); // turn over — drop in-flight set
    wd.bump(); // a fresh arm sees an empty in-flight set → idle window
    clock.advance(IDLE);
    expect(wd.fired).toBe(true);
    expect(wd.firedByTool).toBe(false);
  });

  it("the fired callback receives the captured window flag", () => {
    const clock = new FakeClock();
    const seen: boolean[] = [];
    const wd = make(clock, (byTool) => seen.push(byTool));
    wd.toolStart("t1");
    clock.advance(TOOL);
    expect(seen).toEqual([true]);
    expect(wd.firedByTool).toBe(true);
  });
});
