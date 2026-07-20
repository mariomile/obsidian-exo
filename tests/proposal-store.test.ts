import { describe, expect, it, vi } from "vitest";
import { WriteQueue } from "../src/core/write-queue";
import type { ProposalCandidate, ProposalRecord } from "../src/core/proposals";
import {
  PROPOSALS_FILE,
  ProposalStore,
  type ProposalFileAdapter,
  type ProposalMetrics,
} from "../src/obsidian/proposal-store";

function task(title: string, prompt = "Do it"): ProposalCandidate {
  return {
    kind: "task",
    title,
    payload: { kind: "task", title, prompt },
    rationale: "Explicit commitment",
  };
}

function source(createdAt = 1_720_000_000_000) {
  return { convoId: "convo-1", turnId: "turn-1", createdAt };
}

function fakeFiles(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set(PROPOSALS_FILE, initial);
  const adapter: ProposalFileAdapter = {
    read: async (path) => files.get(path) ?? null,
    write: async (path, content) => {
      files.set(path, content);
    },
  };
  return { adapter, files };
}

const zeroMetrics: ProposalMetrics = {
  generated: 0,
  accepted: 0,
  dismissed: 0,
  duplicates: 0,
  parseErrors: 0,
  routeErrors: 0,
};

describe("ProposalStore", () => {
  it("loads a safe empty versioned store when proposals.json is absent", async () => {
    const { adapter } = fakeFiles();
    const snapshot = await new ProposalStore(adapter, new WriteQueue()).load();
    expect(snapshot.data).toEqual({ version: 1, records: [], metrics: zeroMetrics });
    expect(snapshot.warnings).toEqual([]);
  });

  it("falls back without deleting or rewriting a wholly corrupt file", async () => {
    const raw = "{ definitely-not-json";
    const { adapter, files } = fakeFiles(raw);
    const store = new ProposalStore(adapter, new WriteQueue());

    const snapshot = await store.load();
    expect(snapshot.data.records).toEqual([]);
    expect(snapshot.warnings[0]).toMatch(/could not parse/i);
    expect(files.get(PROPOSALS_FILE)).toBe(raw);
    await expect(store.append(task("No overwrite"), source())).rejects.toThrow(/corrupt/i);
    expect(files.get(PROPOSALS_FILE)).toBe(raw);
  });

  it("logically quarantines invalid records, preserves them on write, and keeps valid records", async () => {
    const { adapter, files } = fakeFiles();
    const seed = new ProposalStore(adapter, new WriteQueue());
    const appended = await seed.append(task("Valid"), source());
    expect(appended.status).toBe("appended");
    const parsed = JSON.parse(files.get(PROPOSALS_FILE)!) as { records: unknown[]; metrics: ProposalMetrics };
    parsed.records.push({ id: "broken", kind: "task" });
    files.set(PROPOSALS_FILE, JSON.stringify(parsed));

    const store = new ProposalStore(adapter, new WriteQueue());
    const before = await store.load();
    expect(before.data.records).toHaveLength(1);
    expect(before.warnings).toEqual([expect.stringMatching(/record 1/i)]);

    await store.recordMetric("parseErrors");
    const rawAfter = JSON.parse(files.get(PROPOSALS_FILE)!) as { records: unknown[] };
    expect(rawAfter.records).toHaveLength(2);
    expect(rawAfter.records).toContainEqual({ id: "broken", kind: "task" });
    expect((await store.load()).data.metrics.parseErrors).toBe(1);
  });

  it("validates candidates, assigns stable collision-safe ids/source, and deduplicates", async () => {
    const { adapter } = fakeFiles();
    const store = new ProposalStore(adapter, new WriteQueue());
    const first = await store.append(task("Ship it"), source());
    expect(first.status).toBe("appended");
    if (first.status !== "appended") throw new Error("expected append");
    expect(first.record.id).toMatch(/^proposal-/);
    expect(first.record.source).toEqual(source());

    const duplicate = await store.append(task("  SHIP IT  ", " do   it "), source());
    expect(duplicate.status).toBe("duplicate");
    const invalid = await store.append({ kind: "task", title: "", payload: { kind: "task", title: "", prompt: "" }, rationale: "" }, source());
    expect(invalid.status).toBe("invalid");

    const snapshot = await store.load();
    expect(snapshot.data.records).toHaveLength(1);
    expect(snapshot.data.metrics).toMatchObject({ generated: 2, duplicates: 1 });
  });

  it("retains every pending record while pruning resolved records through the core policy", async () => {
    const { adapter } = fakeFiles();
    const store = new ProposalStore(adapter, new WriteQueue());
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const current = await store.append(task("Current"), source(Date.now()));
    const stale = await store.append(task("Stale"), { ...source(old), turnId: "old" });
    if (current.status !== "appended" || stale.status !== "appended") throw new Error("expected append");
    await store.dismiss(stale.record.id, old);

    const pending = await store.listPending();
    expect(pending.records.map((record) => record.title)).toEqual(["Current"]);
    expect((await store.load()).data.records.map((record) => record.title)).toEqual(["Current"]);
  });

  it("marks accepted only after a successful route and records route failures as pending", async () => {
    const { adapter } = fakeFiles();
    const store = new ProposalStore(adapter, new WriteQueue());
    const appended = await store.append(task("Route me"), source());
    if (appended.status !== "appended") throw new Error("expected append");

    const failed = await store.accept(appended.record.id, async () => ({ ok: false, error: "target unavailable" }));
    expect(failed).toMatchObject({ ok: false, error: "target unavailable" });
    expect((await store.listPending()).records).toHaveLength(1);
    expect((await store.load()).data.metrics.routeErrors).toBe(1);

    const succeeded = await store.accept(appended.record.id, async () => ({ ok: true, target: "task-42" }));
    expect(succeeded).toMatchObject({ ok: true, target: "task-42" });
    expect((await store.listPending()).records).toEqual([]);
    expect((await store.load()).data.metrics.accepted).toBe(1);
  });

  it("treats a thrown route as a failure without resolving the proposal", async () => {
    const { adapter } = fakeFiles();
    const store = new ProposalStore(adapter, new WriteQueue());
    const appended = await store.append(task("Retry me"), source());
    if (appended.status !== "appended") throw new Error("expected append");
    const result = await store.accept(appended.record.id, async () => {
      throw new Error("boom");
    });
    expect(result).toMatchObject({ ok: false, error: "boom" });
    expect((await store.listPending()).records[0].status).toBe("pending");
  });

  it("makes concurrent double accept single-flight and idempotent", async () => {
    const { adapter } = fakeFiles();
    const store = new ProposalStore(adapter, new WriteQueue());
    const appended = await store.append(task("Once"), source());
    if (appended.status !== "appended") throw new Error("expected append");
    const route = vi.fn(async () => ({ ok: true as const, target: "task-once" }));
    const [first, second] = await Promise.all([
      store.accept(appended.record.id, route),
      store.accept(appended.record.id, route),
    ]);
    expect(route).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect((await store.load()).data.metrics.accepted).toBe(1);
  });

  it("serializes concurrent append and accept without losing either update", async () => {
    const { adapter } = fakeFiles();
    const queue = new WriteQueue();
    const enqueue = vi.spyOn(queue, "enqueue");
    const store = new ProposalStore(adapter, queue);
    const first = await store.append(task("First"), source());
    if (first.status !== "appended") throw new Error("expected append");
    await Promise.all([
      store.append(task("Second"), { ...source(), turnId: "turn-2" }),
      store.accept(first.record.id, async () => ({ ok: true, target: "task-first" })),
    ]);
    const snapshot = await store.load();
    expect(snapshot.data.records).toHaveLength(2);
    expect(snapshot.data.records.find((record) => record.id === first.record.id)?.status).toBe("accepted");
    expect(snapshot.data.records.find((record) => record.title === "Second")?.status).toBe("pending");
    expect(enqueue).toHaveBeenCalledTimes(3);
  });

  it("dismisses idempotently and reload reconstructs pending records plus metrics", async () => {
    const { adapter } = fakeFiles();
    const firstStore = new ProposalStore(adapter, new WriteQueue());
    const kept = await firstStore.append(task("Keep"), source());
    const removed = await firstStore.append(task("Dismiss"), { ...source(), turnId: "turn-2" });
    if (kept.status !== "appended" || removed.status !== "appended") throw new Error("expected append");
    await firstStore.dismiss(removed.record.id);
    await firstStore.dismiss(removed.record.id);
    await firstStore.recordMetric("parseErrors", 2);

    const reloaded = new ProposalStore(adapter, new WriteQueue());
    expect((await reloaded.listPending()).records.map((record: ProposalRecord) => record.id)).toEqual([kept.record.id]);
    expect((await reloaded.load()).data.metrics).toMatchObject({ generated: 2, dismissed: 1, parseErrors: 2 });
  });
});
