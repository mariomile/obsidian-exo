import { describe, it, expect } from "vitest";
import { latestHarvestSha, restoreSnapshots, revertHarvestCommit, type UndoVault } from "../src/core/memory-undo";

/** Scripted git: answers by the first args, records every call. */
function fakeGit(answers: Record<string, string | Error>) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    const key = Object.keys(answers)
      .sort((a, b) => b.length - a.length)
      .find((k) => args.join(" ").startsWith(k));
    const a = key === undefined ? "" : answers[key];
    if (a instanceof Error) throw a;
    return a;
  };
  return { run, calls };
}

const SHA = "a1b2c3d4e5f6";

describe("revertHarvestCommit", () => {
  it("reverts a harvest commit and commits ONLY its files with the revert message", async () => {
    const { run, calls } = fakeGit({
      [`log -1 --format=%s ${SHA}`]: "exo: memory harvest: 2 scritture (Pricing)\n",
      [`show --name-only --format= ${SHA}`]: "CRM/Anna.md\n_exo/memory/inbox/2026-09-25.md\n",
      [`log --format=%H ${SHA}..HEAD`]: "",
      "status --porcelain": "",
      "rev-parse HEAD": "ffff0000\n",
    });
    const res = await revertHarvestCommit(run, SHA);
    expect(res.ok).toBe(true);
    expect(res.revertSha).toBe("ffff0000");
    expect(calls).toContainEqual(["revert", "--no-commit", SHA]);
    expect(calls).toContainEqual([
      "commit",
      "-m",
      `exo: memory revert: ${SHA}`,
      "--",
      "CRM/Anna.md",
      "_exo/memory/inbox/2026-09-25.md",
    ]);
  });

  it("refuses a commit that is not a memory harvest", async () => {
    const { run, calls } = fakeGit({ [`log -1 --format=%s ${SHA}`]: "fix: typo\n" });
    const res = await revertHarvestCommit(run, SHA);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not a memory harvest/);
    expect(calls.some((c) => c[0] === "revert")).toBe(false);
  });

  it("refuses when a touched file was committed again since", async () => {
    const { run, calls } = fakeGit({
      [`log -1 --format=%s ${SHA}`]: "exo: memory harvest: 1 scritture (x)",
      [`show --name-only --format= ${SHA}`]: "CRM/Anna.md\n",
      [`log --format=%H ${SHA}..HEAD`]: "9999\n",
      "status --porcelain": "",
    });
    const res = await revertHarvestCommit(run, SHA);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/changed since/);
    expect(calls.some((c) => c[0] === "revert")).toBe(false);
  });

  it("refuses when a touched file has uncommitted edits", async () => {
    const { run } = fakeGit({
      [`log -1 --format=%s ${SHA}`]: "exo: memory harvest: 1 scritture (x)",
      [`show --name-only --format= ${SHA}`]: "CRM/Anna.md\n",
      [`log --format=%H ${SHA}..HEAD`]: "",
      "status --porcelain": " M CRM/Anna.md\n",
    });
    expect((await revertHarvestCommit(run, SHA)).ok).toBe(false);
  });

  it("aborts the revert when git fails midway", async () => {
    const { run, calls } = fakeGit({
      [`log -1 --format=%s ${SHA}`]: "exo: memory harvest: 1 scritture (x)",
      [`show --name-only --format= ${SHA}`]: "a.md\n",
      [`log --format=%H ${SHA}..HEAD`]: "",
      "status --porcelain": "",
      "revert --no-commit": new Error("conflict"),
    });
    const res = await revertHarvestCommit(run, SHA);
    expect(res.ok).toBe(false);
    expect(calls).toContainEqual(["revert", "--abort"]);
  });

  it("reports an unknown sha", async () => {
    const { run } = fakeGit({ "log -1": new Error("bad revision") });
    expect((await revertHarvestCommit(run, "nope")).message).toMatch(/No commit/);
  });
});

describe("latestHarvestSha", () => {
  it("returns the newest harvest that no revert points at", async () => {
    const { run } = fakeGit({
      log: [
        "c3\texo: memory revert: c2",
        "c2\texo: memory harvest: 1 scritture (b)",
        "c1\texo: memory harvest: 3 scritture (a)",
      ].join("\n"),
    });
    expect(await latestHarvestSha(run)).toBe("c1");
  });
  it("null when every harvest was reverted, or none exist", async () => {
    expect(await latestHarvestSha(fakeGit({ log: "c2\texo: memory revert: c1\nc1\texo: memory harvest: 1 scritture (a)" }).run)).toBeNull();
    expect(await latestHarvestSha(fakeGit({ log: "" }).run)).toBeNull();
  });
});

describe("restoreSnapshots (no git)", () => {
  function vault(files: Record<string, string>) {
    const store = new Map(Object.entries(files));
    const v: UndoVault = {
      read: async (p) => store.get(p) ?? null,
      write: async (p, c) => void store.set(p, c),
      remove: async (p) => void store.delete(p),
    };
    return { v, store };
  }

  it("restores edited notes and removes a note the harvest created", async () => {
    const { v, store } = vault({ "a.md": "- one\n- two\n", "inbox.md": "# inbox\n- fact\n" });
    const res = await restoreSnapshots(v, [
      { path: "a.md", before: "- one\n", after: "- one\n- two\n" },
      { path: "inbox.md", before: null, after: "# inbox\n- fact\n" },
    ]);
    expect(res.ok).toBe(true);
    expect(store.get("a.md")).toBe("- one\n");
    expect(store.has("inbox.md")).toBe(false);
  });

  it("refuses, touching nothing, when any file changed since", async () => {
    const { v, store } = vault({ "a.md": "- one\n- two\n", "b.md": "edited by hand\n" });
    const res = await restoreSnapshots(v, [
      { path: "a.md", before: "- one\n", after: "- one\n- two\n" },
      { path: "b.md", before: "", after: "- fact\n" },
    ]);
    expect(res.ok).toBe(false);
    expect(store.get("a.md")).toBe("- one\n- two\n");
  });

  it("refuses without snapshots", async () => {
    expect((await restoreSnapshots(vault({}).v, [])).ok).toBe(false);
  });
});
