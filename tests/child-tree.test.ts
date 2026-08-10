import { describe, it, expect } from "vitest";
import { groupAcrossHomes, groupByParent } from "../src/core/child-tree";

type C = { id: string; parentConvoId?: string };

describe("groupByParent", () => {
  it("keeps parentless convos at depth 0 in input order", () => {
    const out = groupByParent<C>([{ id: "a" }, { id: "b" }]);
    expect(out).toEqual([
      { item: { id: "a" }, depth: 0 },
      { item: { id: "b" }, depth: 0 },
    ]);
  });

  it("places a child at depth 1 directly after its parent", () => {
    const out = groupByParent<C>([{ id: "a" }, { id: "b" }, { id: "a1", parentConvoId: "a" }]);
    expect(out.map((n) => n.item.id)).toEqual(["a", "a1", "b"]);
    expect(out.map((n) => n.depth)).toEqual([0, 1, 0]);
  });

  it("keeps several children of one parent in input order", () => {
    const out = groupByParent<C>([
      { id: "a" },
      { id: "a1", parentConvoId: "a" },
      { id: "a2", parentConvoId: "a" },
    ]);
    expect(out.map((n) => n.item.id)).toEqual(["a", "a1", "a2"]);
  });

  it("promotes an orphan (parent absent from the list) to depth 0", () => {
    const out = groupByParent<C>([{ id: "x1", parentConvoId: "gone" }]);
    expect(out).toEqual([{ item: { id: "x1", parentConvoId: "gone" }, depth: 0 }]);
  });

  it("never nests deeper than one level: a grandchild renders at depth 1", () => {
    const out = groupByParent<C>([
      { id: "a" },
      { id: "a1", parentConvoId: "a" },
      { id: "a1x", parentConvoId: "a1" },
    ]);
    expect(out.map((n) => n.item.id)).toEqual(["a", "a1", "a1x"]);
    expect(out.map((n) => n.depth)).toEqual([0, 1, 1]);
  });

  it("does not emit a child twice: it appears only once, under its parent, not again in the main pass", () => {
    const out = groupByParent<C>([
      { id: "a" },
      { id: "a1", parentConvoId: "a" },
      { id: "b" },
    ]);
    const ids = out.map((n) => n.item.id);
    expect(ids).toEqual(["a", "a1", "b"]);
    expect(ids.filter((id) => id === "a1")).toHaveLength(1);
    expect(out).toHaveLength(3);
  });

  it("preserves input order among multiple parentless items interleaved with children", () => {
    const out = groupByParent<C>([
      { id: "z" },
      { id: "a" },
      { id: "a1", parentConvoId: "a" },
      { id: "m" },
    ]);
    expect(out.map((n) => n.item.id)).toEqual(["z", "a", "a1", "m"]);
    expect(out.map((n) => n.depth)).toEqual([0, 0, 1, 0]);
  });

  it("terminates and does not lose items on a cyclic parentConvoId chain", () => {
    // Hand-editable ledger data: a malformed cycle (a -> b -> a) must not hang
    // or drop items. Every id in the input must still appear exactly once,
    // and depth must stay within the 0|1 cap.
    const out = groupByParent<C>([
      { id: "a", parentConvoId: "b" },
      { id: "b", parentConvoId: "a" },
    ]);
    const ids = out.map((n) => n.item.id).sort();
    expect(ids).toEqual(["a", "b"]);
    for (const node of out) {
      expect([0, 1]).toContain(node.depth);
    }
  });
});

/**
 * `groupAcrossHomes` is the one algorithm; `groupByParent` is its single-home
 * case. These cover the part `groupByParent` cannot reach: relocation between
 * named collections, and the anchor that refuses it.
 */
describe("groupAcrossHomes — anchoring", () => {
  const homes = (o: Record<string, C[]>) => new Map(Object.entries(o));
  const flat = (out: Map<string, { item: C; depth: 0 | 1 }[]>) =>
    Object.fromEntries([...out].map(([k, v]) => [k, v.map((n) => [n.item.id, n.depth])]));

  it("relocates a child into its parent's home when nothing is anchored", () => {
    const out = groupAcrossHomes<C>(homes({ live: [{ id: "p" }], old: [{ id: "c", parentConvoId: "p" }] }));
    expect(flat(out)).toEqual({ live: [["p", 0], ["c", 1]], old: [] });
  });

  it("leaves an anchored row at depth 0 in the home it was already given", () => {
    const out = groupAcrossHomes<C>(
      homes({ live: [{ id: "c", parentConvoId: "p" }], old: [{ id: "p" }] }),
      { isAnchored: (item) => item.id === "c" },
    );
    expect(flat(out)).toEqual({ live: [["c", 0]], old: [["p", 0]] });
  });

  it("pins an anchored row's OWN position only — its children still nest under it", () => {
    const out = groupAcrossHomes<C>(
      homes({
        live: [{ id: "p", parentConvoId: "gp" }],
        old: [{ id: "gp" }, { id: "c", parentConvoId: "p" }],
      }),
      { isAnchored: (item) => item.id === "p" },
    );
    expect(flat(out)).toEqual({ live: [["p", 0], ["c", 1]], old: [["gp", 0]] });
  });

  it("emits every id exactly once, anchored or not", () => {
    const out = groupAcrossHomes<C>(
      homes({ a: [{ id: "p" }, { id: "c1", parentConvoId: "p" }], b: [{ id: "c2", parentConvoId: "p" }] }),
      { isAnchored: (item) => item.id === "c2" },
    );
    const ids = [...out.values()].flat().map((n) => n.item.id);
    expect(ids.sort()).toEqual(["c1", "c2", "p"]);
  });
});
