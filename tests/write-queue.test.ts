import { describe, it, expect } from "vitest";
import { WriteQueue } from "../src/core/write-queue";

/** A deferred promise + its resolver, so a test can control when a task settles. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("WriteQueue", () => {
  it("returns the resolved result of the enqueued fn", async () => {
    const q = new WriteQueue();
    await expect(q.enqueue(async () => 42)).resolves.toBe(42);
  });

  it("runs tasks strictly FIFO in enqueue order", async () => {
    const q = new WriteQueue();
    const log: number[] = [];
    const results = await Promise.all([
      q.enqueue(async () => {
        await Promise.resolve();
        log.push(1);
        return 1;
      }),
      q.enqueue(async () => {
        log.push(2);
        return 2;
      }),
      q.enqueue(async () => {
        log.push(3);
        return 3;
      }),
    ]);
    expect(log).toEqual([1, 2, 3]);
    expect(results).toEqual([1, 2, 3]);
  });

  it("isolates errors: a rejected task does not block later tasks", async () => {
    const q = new WriteQueue();
    const log: string[] = [];
    const first = q.enqueue(async () => {
      log.push("first");
      throw new Error("boom");
    });
    const second = q.enqueue(async () => {
      log.push("second");
      return "ok";
    });
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
    expect(log).toEqual(["first", "second"]);
  });

  it("never overlaps: synchronous concurrent enqueues run one at a time", async () => {
    const q = new WriteQueue();
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const task = (n: number) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      // Yield across several microtasks so any concurrency bug would surface.
      await Promise.resolve();
      await Promise.resolve();
      order.push(n);
      active--;
      return n;
    };
    // Fire all synchronously — the queue must still serialize them.
    const promises = [];
    for (let n = 0; n < 8; n++) promises.push(q.enqueue(task(n)));
    const results = await Promise.all(promises);
    expect(maxActive).toBe(1);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("preserves order even when an earlier task settles later (deferred)", async () => {
    const q = new WriteQueue();
    const d = deferred<string>();
    const log: string[] = [];
    const slow = q.enqueue(async () => {
      log.push("slow-start");
      const v = await d.promise;
      log.push("slow-end");
      return v;
    });
    const fast = q.enqueue(async () => {
      log.push("fast");
      return "fast";
    });
    // Give microtasks a chance; "fast" must NOT have run yet — slow holds the queue.
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(["slow-start"]);
    d.resolve("slow");
    expect(await slow).toBe("slow");
    expect(await fast).toBe("fast");
    expect(log).toEqual(["slow-start", "slow-end", "fast"]);
  });
});
