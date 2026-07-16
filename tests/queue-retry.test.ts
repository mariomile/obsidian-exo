import { describe, expect, it } from "vitest";
import {
  isPending,
  isQueueRetryDue,
  parseNote,
  queueRequestBody,
  stampQueueFailure,
} from "../src/queue";

describe("Exo Queue retry state", () => {
  it("keeps a failed request pending but delays it until retry-after", () => {
    const now = Date.parse("2026-07-16T10:00:00.000Z");
    const failed = stampQueueFailure(parseNote("Prepare my digest"), 1, now);
    expect(isPending(failed)).toBe(true);
    expect(isQueueRetryDue(failed, now + 4 * 60 * 1000)).toBe(false);
    expect(isQueueRetryDue(failed, now + 5 * 60 * 1000)).toBe(true);
  });

  it("closes the request after the third failure", () => {
    const failed = stampQueueFailure(parseNote("Prepare my digest"), 3, 0);
    expect(failed).toContain("exo-failed:");
    expect(isPending(failed)).toBe(false);
  });

  it("does not feed the previous error back into the prompt", () => {
    const body = "Prepare my digest\n\n## Errore (Exo · tentativo 1/3)\n\nProvider unavailable\n";
    expect(queueRequestBody(body)).toBe("Prepare my digest");
  });
});
