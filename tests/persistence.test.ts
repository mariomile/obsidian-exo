import { describe, it, expect } from "vitest";
import { planPersistedConvos } from "../src/core/persistence";

type C = { id: string; messages: unknown[]; updatedAt?: number };

const convo = (id: string, msgCount: number, updatedAt?: number): C => ({
  id,
  messages: Array.from({ length: msgCount }, () => ({})),
  updatedAt,
});

describe("planPersistedConvos", () => {
  it("recreates the incident: an OLD convo with recent updatedAt survives while a NEWER empty husk is dropped", () => {
    // 35 real convos + 10 empty husks = 45 entries, max 30 → real eviction runs
    // (35 > 30). c0 sits at the FRONT of the array but was touched most recently;
    // it must beat later, staler convos on updatedAt. Empty husks (0 messages,
    // unpinned) are dropped even though several carry a newer timestamp than c0.
    const all: C[] = [];
    all.push(convo("c0", 3, 10_000)); // old position, freshest timestamp
    for (let i = 1; i < 35; i++) all.push(convo(`c${i}`, 2, 1000 + i)); // 34 staler real convos
    for (let i = 0; i < 10; i++) all.push(convo(`husk${i}`, 0, 20_000 + i)); // 10 NEWER empty husks

    const kept = planPersistedConvos(all, "c1", [], 30);

    expect(kept.length).toBe(30);
    // The old-positioned but recently-updated convo survives eviction.
    expect(kept.some((c) => c.id === "c0")).toBe(true);
    // Every empty husk is dropped despite a newer updatedAt than c0.
    expect(kept.some((c) => c.id.startsWith("husk"))).toBe(false);
    // The pinned active convo is always kept.
    expect(kept.some((c) => c.id === "c1")).toBe(true);
  });

  it("always keeps active + open-tab convos even with 0 messages", () => {
    const all: C[] = [
      convo("active", 0), // empty but active
      convo("tab", 0), // empty but an open tab
      convo("orphan", 0), // empty, unpinned → dropped
      convo("real", 5, 100),
    ];
    const kept = planPersistedConvos(all, "active", ["tab"], 30);
    expect(kept.map((c) => c.id).sort()).toEqual(["active", "real", "tab"]);
  });

  it("preserves ORIGINAL array order in the output", () => {
    const all: C[] = [
      convo("a", 1, 5),
      convo("b", 1, 100),
      convo("c", 1, 50),
    ];
    // Active "z" isn't in the list, so nothing is pinned — pure recency eviction.
    const kept = planPersistedConvos(all, "z", [], 2);
    // b and c have the newest updatedAt; kept must still be in array order (b before c).
    expect(kept.map((c) => c.id)).toEqual(["b", "c"]);
  });

  it("never returns more than max", () => {
    const all = Array.from({ length: 50 }, (_, i) => convo(`c${i}`, 1, i));
    const kept = planPersistedConvos(all, "c0", [], 30);
    expect(kept.length).toBe(30);
  });

  it("evicts unpinned convos by updatedAt desc, keeping the most recent", () => {
    const all: C[] = [
      convo("keep-active", 1, 1),
      convo("old", 1, 1),
      convo("new", 1, 100),
      convo("mid", 1, 50),
    ];
    // max 2: active pinned + the single most-recent unpinned ("new").
    const kept = planPersistedConvos(all, "keep-active", [], 2);
    expect(kept.map((c) => c.id).sort()).toEqual(["keep-active", "new"]);
  });

  it("returns the filtered list untouched when under the cap", () => {
    const all: C[] = [convo("a", 1), convo("b", 0), convo("c", 2)];
    // b (empty, unpinned) is filtered out; a and c stay, in order, no eviction.
    const kept = planPersistedConvos(all, "z", [], 30);
    expect(kept.map((c) => c.id)).toEqual(["a", "c"]);
  });
});
