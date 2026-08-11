import { describe, it, expect } from "vitest";
import { acquireLease, checkLease, releaseLease, type BrowserLease } from "../src/core/browser-lease";

describe("acquireLease", () => {
  it("grants a fresh lease when nobody holds one", () => {
    const { lease, tookOverFrom } = acquireLease(null, "convo-a", 1000);
    expect(lease).toEqual({ ownerConvoId: "convo-a", acquiredAt: 1000 });
    expect(tookOverFrom).toBeUndefined();
  });

  it("re-acquiring your own lease refreshes it without a takeover", () => {
    const current: BrowserLease = { ownerConvoId: "convo-a", acquiredAt: 1000 };
    const { lease, tookOverFrom } = acquireLease(current, "convo-a", 2000);
    expect(lease.acquiredAt).toBe(2000);
    expect(tookOverFrom).toBeUndefined();
  });

  it("takes over another conversation's lease and names it", () => {
    const current: BrowserLease = { ownerConvoId: "convo-a", acquiredAt: 1000 };
    const { lease, tookOverFrom } = acquireLease(current, "convo-b", 2000);
    expect(lease.ownerConvoId).toBe("convo-b");
    expect(tookOverFrom).toBe("convo-a");
  });
});

describe("checkLease", () => {
  it("refuses when nobody holds the lease, pointing at browser_open", () => {
    const res = checkLease(null, "convo-a");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("browser_open");
  });

  it("allows the owner", () => {
    expect(checkLease({ ownerConvoId: "convo-a", acquiredAt: 1 }, "convo-a")).toEqual({ ok: true });
  });

  it("refuses a non-owner, naming the owner and the takeover path", () => {
    const res = checkLease({ ownerConvoId: "convo-a", acquiredAt: 1 }, "convo-b");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("convo-a");
      expect(res.reason).toContain("browser_open");
    }
  });
});

describe("releaseLease", () => {
  it("clears the lease for its owner and is a no-op for anyone else", () => {
    const lease: BrowserLease = { ownerConvoId: "convo-a", acquiredAt: 1 };
    expect(releaseLease(lease, "convo-a")).toBeNull();
    expect(releaseLease(lease, "convo-b")).toBe(lease);
    expect(releaseLease(null, "convo-a")).toBeNull();
  });
});
