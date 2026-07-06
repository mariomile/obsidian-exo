import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the node:child_process execFile before importing the module under test —
// `readUnimportedObservations` shells out via `promisify(execFile)` at call time,
// so controlling this mock lets us simulate every failure mode without touching
// a real sqlite3 binary or db file.
const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { WriteQueue } from "../src/core/write-queue";
import {
  advanceAndPersistWatermark,
  readSyncState,
  readUnimportedObservations,
  writeSyncState,
} from "../src/obsidian/claudemem";

/** Minimal fake of the Obsidian `App`'s vault adapter surface this module touches. */
function fakeApp(files: Record<string, string> = {}) {
  const store = { ...files };
  return {
    app: {
      vault: {
        adapter: {
          exists: vi.fn(async (p: string) => p in store),
          read: vi.fn(async (p: string) => {
            if (!(p in store)) throw new Error(`ENOENT: ${p}`);
            return store[p];
          }),
          write: vi.fn(async (p: string, content: string) => {
            store[p] = content;
          }),
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    store,
  };
}

/** Drive the callback-style `execFile(cmd, args, opts, cb)` contract that
 *  `util.promisify` wraps, resolving/rejecting exactly like the real binary would. */
function mockExecFileOnce(
  impl: (cmd: string, args: string[]) => { stdout: string } | Error
) {
  execFileMock.mockImplementationOnce(
    (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, res?: { stdout: string }) => void) => {
      const result = impl(cmd, args);
      if (result instanceof Error) cb(result);
      else cb(null, result);
    }
  );
}

beforeEach(() => {
  execFileMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readUnimportedObservations — failure modes (all silent no-ops)", () => {
  it("returns [] and does not throw when sqlite3 reports the db file missing", async () => {
    mockExecFileOnce(() => new Error("Error: unable to open database file"));
    const { app } = fakeApp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const obs = await readUnimportedObservations(app, { projects: ["example-vault"], limit: 100 });
    expect(obs).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("returns [] and does not throw when the sqlite3 binary is missing (ENOENT)", async () => {
    mockExecFileOnce(() => {
      const err = new Error("spawn sqlite3 ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return err;
    });
    const { app } = fakeApp();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const obs = await readUnimportedObservations(app, { projects: ["example-vault"], limit: 100 });
    expect(obs).toEqual([]);
  });

  it("returns [] and does not throw on a query error", async () => {
    mockExecFileOnce(() => new Error("Parse error: no such table: observations"));
    const { app } = fakeApp();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const obs = await readUnimportedObservations(app, { projects: ["example-vault"], limit: 100 });
    expect(obs).toEqual([]);
  });

  it("returns [] on malformed JSON stdout rather than throwing", async () => {
    mockExecFileOnce(() => ({ stdout: "not json {[" }));
    const { app } = fakeApp();
    const obs = await readUnimportedObservations(app, { projects: ["example-vault"], limit: 100 });
    expect(obs).toEqual([]);
  });

  it("returns [] immediately (no execFile call) when no projects are configured", async () => {
    const { app } = fakeApp();
    const obs = await readUnimportedObservations(app, { projects: [], limit: 100 });
    expect(obs).toEqual([]);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("logs the failure only once across repeated calls (no repeated log spam)", async () => {
    mockExecFileOnce(() => new Error("boom 1"));
    mockExecFileOnce(() => new Error("boom 2"));
    const { app } = fakeApp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await readUnimportedObservations(app, { projects: ["example-vault"], limit: 100 });
    await readUnimportedObservations(app, { projects: ["example-vault"], limit: 100 });
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("readUnimportedObservations — happy path & read-only argv discipline", () => {
  it("parses real-shaped sqlite3 -json stdout into observations", async () => {
    mockExecFileOnce(() => ({
      stdout: JSON.stringify([
        {
          id: 7,
          project: "example-vault",
          type: "discovery",
          title: "t",
          subtitle: "s",
          facts: "f",
          narrative: "n",
          created_at_epoch: 123,
        },
      ]),
    }));
    const { app } = fakeApp();
    const obs = await readUnimportedObservations(app, { projects: ["example-vault"], limit: 100 });
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ id: 7, project: "example-vault", title: "t" });
  });

  it("invokes sqlite3 as explicit argv with -readonly (never a shell string)", async () => {
    mockExecFileOnce(() => ({ stdout: "[]" }));
    const { app } = fakeApp();
    await readUnimportedObservations(app, { projects: ["example-vault"], limit: 100 });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("sqlite3");
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain("-readonly");
    expect(args).toContain("-json");
    // The SQL text is a single argv element (not concatenated into `cmd`), and
    // contains no write verbs anywhere.
    const sql = args[args.length - 1];
    expect(sql).toMatch(/^SELECT /i);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|PRAGMA)\b/i);
  });

  it("filters by the configured project(s) using the real DB naming (not a path-slug)", async () => {
    mockExecFileOnce(() => ({ stdout: "[]" }));
    const { app } = fakeApp();
    await readUnimportedObservations(app, { projects: ["example-vault"], limit: 100 });
    const args = execFileMock.mock.calls[0][1] as string[];
    const sql = args[args.length - 1];
    expect(sql).toContain("'example-vault'");
  });
});

describe("watermark persistence (via WriteQueue, never touching the claude-mem DB)", () => {
  it("readSyncState returns a zero watermark when the state file does not exist", async () => {
    const { app } = fakeApp();
    await expect(readSyncState(app)).resolves.toEqual({ lastImportedId: 0, lastRunISO: "" });
  });

  it("writeSyncState persists through the shared WriteQueue at the documented path", async () => {
    const { app, store } = fakeApp();
    const queue = new WriteQueue();
    await writeSyncState(app, queue, { lastImportedId: 5, lastRunISO: "2026-07-05T00:00:00.000Z" });
    expect(JSON.parse(store["_system/memory/claudemem-sync-state.json"])).toEqual({
      lastImportedId: 5,
      lastRunISO: "2026-07-05T00:00:00.000Z",
    });
  });

  it("advanceAndPersistWatermark advances from the current state and never touches DB write paths", async () => {
    const { app } = fakeApp({
      "_system/memory/claudemem-sync-state.json": JSON.stringify({
        lastImportedId: 10,
        lastRunISO: "2026-07-01T00:00:00.000Z",
      }),
    });
    const queue = new WriteQueue();
    await advanceAndPersistWatermark(app, queue, [12, 8, 15], "2026-07-05T12:00:00.000Z");
    const next = await readSyncState(app);
    expect(next).toEqual({ lastImportedId: 15, lastRunISO: "2026-07-05T12:00:00.000Z" });
    // The whole test suite never mocked or called any DB-writing execFile path.
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
