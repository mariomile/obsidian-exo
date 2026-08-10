import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  planPersistedConvos,
  parseConversationsSource,
  partitionConvos,
} from "../src/core/persistence";

type C = { id: string; messages: unknown[]; updatedAt?: number };

const convo = (id: string, msgCount: number, updatedAt?: number): C => ({
  id,
  messages: Array.from({ length: msgCount }, () => ({})),
  updatedAt,
});

/**
 * NOT a production contract. `planPersistedConvos` is deprecated and has no
 * caller: production retention is `planRetention` (src/core/retention.ts), which
 * never shrinks what it keeps. These cases pin the HISTORICAL planner — the one
 * that returned a reduced set whose difference was then deleted from disk — so
 * that the behaviour this branch removed stays legible, and so "recreates the
 * incident" below reads as the bug it was, not as a rule still in force.
 */
describe("planPersistedConvos (deprecated planner — historical behaviour only)", () => {
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

describe("parseConversationsSource", () => {
  const arr = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `c${i}` })));

  it("uses a valid main file and reports it not corrupt", () => {
    const r = parseConversationsSource(arr(3), null);
    expect(r.source).toBe("main");
    expect(r.mainCorrupt).toBe(false);
    expect(r.data).toHaveLength(3);
  });

  it("falls back to a valid .bak when main is corrupt, flagging mainCorrupt", () => {
    const r = parseConversationsSource("{ not json", arr(2));
    expect(r.source).toBe("bak");
    expect(r.mainCorrupt).toBe(true);
    expect(r.data).toHaveLength(2);
  });

  it("returns empty + mainCorrupt when BOTH main and bak are corrupt", () => {
    const r = parseConversationsSource("{ broken", "also [broken");
    expect(r.source).toBe("empty");
    expect(r.mainCorrupt).toBe(true);
    expect(r.data).toEqual([]);
  });

  it("returns empty and NOT corrupt when both files are missing (fresh install)", () => {
    const r = parseConversationsSource(null, null);
    expect(r.source).toBe("empty");
    expect(r.mainCorrupt).toBe(false);
    expect(r.data).toEqual([]);
  });

  it("recovers from bak for a truncated-JSON main (the classic crash-mid-write)", () => {
    // A write interrupted partway leaves valid-prefix-but-unterminated JSON.
    const truncated = arr(5).slice(0, arr(5).length - 10);
    const r = parseConversationsSource(truncated, arr(4));
    expect(r.source).toBe("bak");
    expect(r.mainCorrupt).toBe(true);
    expect(r.data).toHaveLength(4);
  });

  it("treats valid JSON that isn't an array as corrupt and tries bak", () => {
    const r = parseConversationsSource('{"conversations":[]}', arr(1));
    expect(r.source).toBe("bak");
    expect(r.mainCorrupt).toBe(true);
    expect(r.data).toHaveLength(1);
  });

  it("uses main even when a stale bak is also present (main wins)", () => {
    const r = parseConversationsSource(arr(2), arr(9));
    expect(r.source).toBe("main");
    expect(r.data).toHaveLength(2);
  });
});

describe("partitionConvos", () => {
  const c = (id: string, archived?: boolean) => ({ id, archived });

  it("splits archived from live, preserving order within each side", () => {
    const { live, archived } = partitionConvos([
      c("a"),
      c("b", true),
      c("c"),
      c("d", true),
    ]);
    expect(live.map((x) => x.id)).toEqual(["a", "c"]);
    expect(archived.map((x) => x.id)).toEqual(["b", "d"]);
  });

  it("treats a missing archived flag as live", () => {
    const { live, archived } = partitionConvos([{ id: "a" }]);
    expect(live.map((x) => x.id)).toEqual(["a"]);
    expect(archived).toEqual([]);
  });

  it("handles all-archived and all-live inputs", () => {
    expect(partitionConvos([c("a", true), c("b", true)]).live).toEqual([]);
    expect(partitionConvos([c("a"), c("b")]).archived).toEqual([]);
  });

  it("returns empty sides for empty input", () => {
    expect(partitionConvos([])).toEqual({ live: [], archived: [] });
  });
});

/**
 * Convo ⇄ ConvoData round-trip contract.
 *
 * The mapping is NOT in this module: it is two hand-written object literals in
 * `view.ts` — the `const c: Convo = {…}` in `restore()` (disk → memory) and the
 * literal in `toConvoData()` (memory → disk). `view.ts` imports `obsidian` and
 * has zero unit tests, so nothing else in the tree can observe that the two
 * halves still agree.
 *
 * The failure they are exposed to is asymmetric and silent: add a field to one
 * literal and not the other and the build is green, the typecheck is green
 * (both sides are optional), and the field simply evaporates on the next
 * reload. That is exactly how a fan-out child would come back from a restart
 * with no parent, jump out from under it in the sidebar, and read as a chat
 * nobody started.
 *
 * ⚠️ Red here means "add the field to the other literal too", never "delete the
 * field from the list".
 */
const view = readFileSync(join(__dirname, "..", "src", "view.ts"), "utf8");

/** Everything that must survive a save/load cycle. Deliberately includes the
 *  fields that predate this contract — one rule for all of them, so the next
 *  field added is added under a rule that is already being enforced. */
const ROUND_TRIP_FIELDS = [
  "archived",
  "pinned",
  "retiredAt",
  "lastActiveAt",
  "boardStatus",
  "parentConvoId",
  "titleLocked",
  "agent",
  "sessionId",
  "updatedAt",
  "usage",
] as const;

/** The literal in `restore()` that builds a live `Convo` from a `ConvoData`. */
const restoreLiteral = (): string => {
  const start = view.indexOf("const c: Convo = {");
  expect(start, "restore()'s `const c: Convo = {` literal moved or was renamed").toBeGreaterThan(-1);
  const end = view.indexOf("\n      };", start);
  expect(end, "could not find the end of restore()'s Convo literal").toBeGreaterThan(start);
  return view.slice(start, end);
};

/** The literal in `toConvoData()` that writes a `ConvoData` back to disk. */
const toDataLiteral = (): string => {
  const start = view.indexOf("private toConvoData(c: Convo): ConvoData {");
  expect(start, "toConvoData moved or was renamed").toBeGreaterThan(-1);
  const end = view.indexOf("\n  }", start);
  expect(end, "could not find the end of toConvoData").toBeGreaterThan(start);
  return view.slice(start, end);
};

describe("Convo persistence round-trip (view.ts, which has no unit tests)", () => {
  const restore = restoreLiteral();
  const toData = toDataLiteral();

  for (const field of ROUND_TRIP_FIELDS) {
    it(`${field} is read back on restore`, () => {
      expect(
        restore,
        `${field} is written to disk but never read back: it silently disappears on reload.`,
      ).toContain(field);
    });

    it(`${field} is written on save`, () => {
      expect(
        toData,
        `${field} is restored from disk but never written: it survives exactly one session.`,
      ).toContain(field);
    });
  }

  it("parentConvoId is written conditionally, so a normal chat stays clean on disk", () => {
    // Matches how `boardStatus` and `titleLocked` are already handled: absent
    // stays absent rather than becoming an explicit `undefined` in every entry.
    expect(toData).toMatch(/\.\.\.\(c\.parentConvoId \? \{ parentConvoId: c\.parentConvoId \} : \{\}\)/);
  });

  it("pendingChildReports is runtime-only and never persisted", () => {
    // A queued report has no meaning after a reload — there is no in-flight
    // turn to prepend it to, and the board still shows the child's real state.
    expect(toData).not.toContain("pendingChildReports");
    expect(restore).not.toContain("pendingChildReports");
  });
});
