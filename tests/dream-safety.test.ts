import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { TFile } from "obsidian";
import {
  applyPlan,
  DreamSnapshotPersistenceError,
  type DreamPlan,
} from "../src/obsidian/dream";

describe("dream snapshot safety", () => {
  it("aborts before the first mutation when checkpoint persistence fails", async () => {
    const keep = new TFile();
    keep.path = "_system/memory/learnings/2026-07-06-safe.md";
    keep.basename = "2026-07-06-safe";
    const processFrontMatter = vi.fn();
    const app = {
      vault: {
        getAbstractFileByPath: (path: string) => (path === keep.path ? keep : null),
        read: vi.fn().mockResolvedValue("before"),
        delete: vi.fn(),
      },
      fileManager: {
        processFrontMatter,
        renameFile: vi.fn(),
      },
    } as unknown as App;
    const plan: DreamPlan = {
      scanned: 1,
      dedup: [{ keep: keep.path, drop: [], evidence: 3 }],
      promote: [],
      stale: [],
    };

    await expect(
      applyPlan(app, plan, "2026-07-06T12:00:00.000Z", async () => {
        throw new DreamSnapshotPersistenceError();
      })
    ).rejects.toBeInstanceOf(DreamSnapshotPersistenceError);
    expect(processFrontMatter).not.toHaveBeenCalled();
  });
});
