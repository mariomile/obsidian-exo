/**
 * Electron-renderer ↔ Node interop shims.
 *
 * In Obsidian's renderer, `AbortController` is the DOM implementation while
 * `require("events")` is Node's. The Agent SDK calls
 * `events.setMaxListeners(n, abortController.signal)` on controllers it
 * creates internally — Node's validator rejects DOM signals with
 * ERR_INVALID_ARG_TYPE, which kills every session spawn at query() setup.
 *
 * `setMaxListeners` on a signal only raises the listener-leak-warning
 * threshold, so silently skipping an incompatible target is behaviorally safe:
 * the worst case is a MaxListenersExceededWarning in the console instead of a
 * dead agent.
 */

type SetMaxListeners = (n?: number, ...eventTargets: unknown[]) => void;

/** Wrap Node's `events.setMaxListeners` so incompatible (DOM-realm) targets
 *  are skipped per-target instead of throwing for the whole call. Pure —
 *  the caller supplies the original and installs the result. */
export function makeTolerantSetMaxListeners(orig: SetMaxListeners): SetMaxListeners {
  const shim: SetMaxListeners = (n?: number, ...eventTargets: unknown[]): void => {
    if (eventTargets.length === 0) {
      orig(n);
      return;
    }
    for (const target of eventTargets) {
      try {
        orig(n, target);
      } catch {
        // DOM EventTarget handed to a Node API — skip it. Only the
        // leak-warning threshold is lost for this target.
      }
    }
  };
  (shim as { __exoTolerant?: boolean }).__exoTolerant = true;
  return shim;
}

/** True when `fn` is already the tolerant shim (idempotency guard). */
export function isTolerantShim(fn: unknown): boolean {
  return typeof fn === "function" && (fn as { __exoTolerant?: boolean }).__exoTolerant === true;
}
