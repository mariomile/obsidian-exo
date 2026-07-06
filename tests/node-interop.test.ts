import { describe, it, expect, vi } from "vitest";
import { makeTolerantSetMaxListeners, isTolerantShim } from "../src/core/node-interop";

class FakeNodeTarget {}
class FakeDomSignal {}

/** An `orig` that mimics Node's events.setMaxListeners: accepts FakeNodeTarget,
 *  throws ERR_INVALID_ARG_TYPE-style on anything else. */
function strictOrig(): { fn: (n?: number, ...t: unknown[]) => void; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const fn = (n?: number, ...targets: unknown[]) => {
    calls.push([n, ...targets]);
    for (const t of targets) {
      if (!(t instanceof FakeNodeTarget)) {
        const err = new TypeError('The "eventTargets" argument must be an instance of EventTarget.') as TypeError & {
          code: string;
        };
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
    }
  };
  return { fn, calls };
}

describe("makeTolerantSetMaxListeners", () => {
  it("passes through the zero-target form (process-wide default)", () => {
    const orig = vi.fn();
    makeTolerantSetMaxListeners(orig)(20);
    expect(orig).toHaveBeenCalledTimes(1);
    expect(orig).toHaveBeenCalledWith(20);
  });

  it("applies valid targets even when an invalid one is in the same call", () => {
    const { fn, calls } = strictOrig();
    const shim = makeTolerantSetMaxListeners(fn);
    const good = new FakeNodeTarget();
    const bad = new FakeDomSignal();
    expect(() => shim(50, bad, good)).not.toThrow();
    // per-target fan-out: the good target still got its threshold raised
    expect(calls).toContainEqual([50, good]);
  });

  it("never throws even when every target is invalid (the SDK crash case)", () => {
    const { fn } = strictOrig();
    const shim = makeTolerantSetMaxListeners(fn);
    expect(() => shim(50, new FakeDomSignal())).not.toThrow();
  });

  it("rethrows unrelated failures instead of hiding global Node API errors", () => {
    const err = new RangeError("n must be non-negative");
    const shim = makeTolerantSetMaxListeners(() => {
      throw err;
    });
    expect(() => shim(-1, new FakeNodeTarget())).toThrow(err);
  });

  it("isTolerantShim identifies the shim and only the shim (idempotency guard)", () => {
    const orig = vi.fn();
    const shim = makeTolerantSetMaxListeners(orig);
    expect(isTolerantShim(shim)).toBe(true);
    expect(isTolerantShim(orig)).toBe(false);
    expect(isTolerantShim(undefined)).toBe(false);
  });
});
