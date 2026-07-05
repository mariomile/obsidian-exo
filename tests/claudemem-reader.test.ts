import { describe, it, expect } from "vitest";
import {
  parseObservations,
  parseSyncState,
  advanceWatermark,
  initialSyncState,
  type ClaudeMemObservation,
  type SyncState,
} from "../src/core/claudemem-reader";

// Real-shaped rows: `sqlite3 -json` returns an array of objects keyed by column.
const REAL_JSON = JSON.stringify([
  {
    id: 101,
    project: "-Users-mariomiletta-Vaults-marioverse-ai",
    type: "discovery",
    title: "WriteQueue serializes store writes",
    subtitle: "one FIFO for remember + observer",
    facts: "queue is plugin-scoped",
    narrative: "Found that all store writers share one queue.",
    created_at_epoch: 1720000000,
  },
  {
    id: 102,
    project: "-Users-mariomiletta-Vaults-marioverse-ai",
    type: "bugfix",
    title: "Fixed the boot preamble cap",
    subtitle: "",
    facts: "",
    narrative: "",
    created_at_epoch: 1720000500,
  },
]);

describe("parseObservations", () => {
  it("round-trips real-shaped sqlite3 -json rows", () => {
    const obs = parseObservations(REAL_JSON);
    expect(obs).toHaveLength(2);
    expect(obs[0]).toMatchObject<Partial<ClaudeMemObservation>>({
      id: 101,
      project: "-Users-mariomiletta-Vaults-marioverse-ai",
      type: "discovery",
      title: "WriteQueue serializes store writes",
      subtitle: "one FIFO for remember + observer",
      createdAtEpoch: 1720000000,
    });
  });

  it("returns [] on empty output", () => {
    expect(parseObservations("")).toEqual([]);
    expect(parseObservations("[]")).toEqual([]);
  });

  it("returns [] on malformed JSON (never throws)", () => {
    expect(parseObservations("not json {[")).toEqual([]);
    expect(parseObservations("{\"not\":\"an array\"}")).toEqual([]);
  });

  it("skips rows without a numeric id, keeps the good ones", () => {
    const json = JSON.stringify([
      { id: "oops", title: "bad" },
      { id: 5, project: "p", type: "change", title: "good", created_at_epoch: 1 },
    ]);
    const obs = parseObservations(json);
    expect(obs).toHaveLength(1);
    expect(obs[0].id).toBe(5);
  });

  it("tolerates missing text fields (coerces to empty strings)", () => {
    const json = JSON.stringify([{ id: 9 }]);
    const obs = parseObservations(json);
    expect(obs[0]).toMatchObject({ id: 9, project: "", type: "", title: "", subtitle: "", createdAtEpoch: 0 });
  });
});

describe("parseSyncState", () => {
  it("parses a valid watermark file", () => {
    const s = parseSyncState(JSON.stringify({ lastImportedId: 42, lastRunISO: "2026-07-05T10:00:00.000Z" }));
    expect(s).toEqual({ lastImportedId: 42, lastRunISO: "2026-07-05T10:00:00.000Z" });
  });

  it("returns a zero watermark on missing/garbage content", () => {
    expect(parseSyncState(null)).toEqual(initialSyncState());
    expect(parseSyncState("")).toEqual(initialSyncState());
    expect(parseSyncState("nonsense")).toEqual(initialSyncState());
    expect(parseSyncState(JSON.stringify({ lastImportedId: "x" }))).toEqual(initialSyncState());
  });
});

describe("advanceWatermark", () => {
  const base: SyncState = { lastImportedId: 10, lastRunISO: "2026-07-01T00:00:00.000Z" };

  it("advances to the max imported id and stamps the run time", () => {
    const next = advanceWatermark(base, [12, 15, 11], "2026-07-05T10:00:00.000Z");
    expect(next).toEqual({ lastImportedId: 15, lastRunISO: "2026-07-05T10:00:00.000Z" });
  });

  it("never moves the watermark backwards", () => {
    const next = advanceWatermark(base, [3, 4], "2026-07-05T10:00:00.000Z");
    expect(next.lastImportedId).toBe(10);
  });

  it("keeps the watermark but restamps when there are no imports", () => {
    const next = advanceWatermark(base, [], "2026-07-05T10:00:00.000Z");
    expect(next).toEqual({ lastImportedId: 10, lastRunISO: "2026-07-05T10:00:00.000Z" });
  });
});
