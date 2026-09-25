/**
 * WriteQueue — a pure, in-process promise-chain serializer (no Obsidian imports).
 *
 * Every read-modify-write on a shared file (a ledger, a memory note) goes
 * through ONE shared WriteQueue per file family, so concurrent writers never
 * interleave a cycle and never clobber each other.
 *
 * Guarantees:
 *  - Strict FIFO: tasks run in enqueue order, exactly one at a time; the next task
 *    starts only after the previous one settles.
 *  - Result pass-through: `enqueue` resolves/rejects with `fn`'s own outcome.
 *  - Error isolation: a rejected task rejects only its own returned promise and
 *    does NOT poison the chain — later tasks still run in order.
 */
export class WriteQueue {
  /** Tail of the chain. Always resolves (never rejects) so one failure can't break serialization. */
  private tail: Promise<void> = Promise.resolve();

  /** Run `fn` after all previously-enqueued tasks settle; returns its result. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => fn());
    // Advance the tail on a branch that swallows rejection, so a failed task
    // does not poison the chain for later tasks.
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
