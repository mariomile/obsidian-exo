/**
 * Browser lease: the pure ownership rule for the shared agent-browser tab
 * (no Obsidian imports).
 *
 * One visible tab, many conversations: without a lease, two convos driving it
 * concurrently would interleave multi-step interactions (T3 Code solved the
 * same problem with a host-assignment lease). Exo's version is deliberately
 * minimal: the lease is in-memory, has NO expiry clock (an expiring lease can
 * migrate a live flow mid-interaction), and changes hands ONLY through
 * `browser_open`, which raises a permission card, so the human ratifies every
 * takeover. Reads never need the lease; only mutations do.
 */

export interface BrowserLease {
  ownerConvoId: string;
  acquiredAt: number;
}

/** Grant (or refresh) the lease for `convoId`. Taking it from another
 *  conversation is allowed by design: `tookOverFrom` lets the caller say so. */
export function acquireLease(
  current: BrowserLease | null,
  convoId: string,
  now: number,
): { lease: BrowserLease; tookOverFrom?: string } {
  const tookOverFrom =
    current && current.ownerConvoId !== convoId ? current.ownerConvoId : undefined;
  return {
    lease: { ownerConvoId: convoId, acquiredAt: now },
    ...(tookOverFrom ? { tookOverFrom } : {}),
  };
}

/** Whether `convoId` may MUTATE the shared tab right now. The refusal reason is
 *  written for the model: it is an answer, not an error to retry. */
export function checkLease(
  current: BrowserLease | null,
  convoId: string,
): { ok: true } | { ok: false; reason: string } {
  if (!current) {
    return {
      ok: false,
      reason:
        "No browser session is open for this conversation yet. Call browser_open first.",
    };
  }
  if (current.ownerConvoId === convoId) return { ok: true };
  return {
    ok: false,
    reason:
      `The shared browser tab is currently driven by another conversation (${current.ownerConvoId}). ` +
      "Call browser_open to take it over; the tab is shared, so taking over interrupts that conversation's flow. " +
      "Reading tools (browser_snapshot, browser_read_page, browser_screenshot) work without taking over.",
  };
}

/** Drop the lease if `convoId` owns it; anyone else's release is a no-op. */
export function releaseLease(current: BrowserLease | null, convoId: string): BrowserLease | null {
  if (current && current.ownerConvoId === convoId) return null;
  return current;
}
