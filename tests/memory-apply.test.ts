import { describe, it, expect } from "vitest";
import { applyDecisions, type ApplyVault } from "../src/core/memory-apply";
import { HARVEST_MAX_WRITES, type Decision, type TargetEnv } from "../src/core/memory-harvest";

function fakeVault(files: Record<string, string>) {
  const store = new Map(Object.entries(files));
  const created: string[] = [];
  const vault: ApplyVault = {
    exists: (p) => store.has(p),
    read: async (p) => {
      const v = store.get(p);
      if (v === undefined) throw new Error(`missing ${p}`);
      return v;
    },
    modify: async (p, c) => {
      if (!store.has(p)) throw new Error(`modify of missing ${p}`);
      store.set(p, c);
    },
    create: async (p, c) => {
      if (store.has(p)) throw new Error(`create over ${p}`);
      created.push(p);
      store.set(p, c);
    },
  };
  return { vault, store, created };
}

const INBOX = "_exo/memory/inbox/2026-09-25.md";
function envFor(vault: ApplyVault): TargetEnv & { today: string } {
  return {
    exists: (p) => vault.exists(p),
    inboxPath: INBOX,
    kernelPaths: new Set(["_exo/agent/USER.md", "AGENTS.md"]),
    ignoredPrefixes: ["Input"],
    today: "2026-09-25",
  };
}

describe("applyDecisions", () => {
  it("ADD appends one bullet to the named section and snapshots the file first", async () => {
    const before = "# Anna\n## Work\n- Designer\n";
    const { vault, store } = fakeVault({ "CRM/Anna.md": before });
    const res = await applyDecisions(
      vault,
      [{ op: "add", candidate: 0, path: "CRM/Anna.md", section: "Work", text: "Leads design at Acme" }],
      envFor(vault),
    );
    expect(store.get("CRM/Anna.md")).toBe("# Anna\n## Work\n- Designer\n- Leads design at Acme\n");
    expect(res.writes).toEqual([{ path: "CRM/Anna.md", op: "add", text: "Leads design at Acme" }]);
    expect(res.files).toEqual([{ path: "CRM/Anna.md", before, after: store.get("CRM/Anna.md") }]);
  });

  it("UPDATE replaces only the exact line; a line that is not there exactly once is rejected", async () => {
    const { vault, store } = fakeVault({ "P/context.md": "- Status: beta\n- Owner: Mario\n- Owner: Mario\n" });
    const res = await applyDecisions(
      vault,
      [
        { op: "update", candidate: 0, path: "P/context.md", oldLine: "- Status: beta", newText: "Status: live (dal 2026-09-25; prima beta)" },
        { op: "update", candidate: 1, path: "P/context.md", oldLine: "- Owner: Mario", newText: "Owner: Anna" },
        { op: "update", candidate: 2, path: "P/context.md", oldLine: "- Status: alpha", newText: "x" },
      ],
      envFor(vault),
    );
    expect(store.get("P/context.md")).toBe("- Status: live (dal 2026-09-25; prima beta)\n- Owner: Mario\n- Owner: Mario\n");
    expect(res.writes).toHaveLength(1);
    expect(res.rejected.map((r) => r.reason)).toEqual(["oldLine not found exactly once", "oldLine not found exactly once"]);
  });

  it("NOOP writes nothing", async () => {
    const { vault, store } = fakeVault({ "a.md": "x\n" });
    const res = await applyDecisions(vault, [{ op: "noop", candidate: 0 }], envFor(vault));
    expect(res.writes).toEqual([]);
    expect(store.get("a.md")).toBe("x\n");
  });

  it("guardrails reject ignored, kernel and non-existent paths without touching them", async () => {
    const { vault, store, created } = fakeVault({
      "Input/Readwise/Book.md": "book\n",
      "_exo/agent/USER.md": "user\n",
      ".obsidian/x.md": "cfg\n",
    });
    const decisions: Decision[] = [
      { op: "add", candidate: 0, path: "Input/Readwise/Book.md", text: "note" },
      { op: "add", candidate: 1, path: "_exo/agent/USER.md", text: "note" },
      { op: "add", candidate: 2, path: ".obsidian/x.md", text: "note" },
      { op: "add", candidate: 3, path: "CRM/New Person.md", text: "note" },
    ];
    const res = await applyDecisions(vault, decisions, envFor(vault));
    expect(res.writes).toEqual([]);
    expect(res.rejected.map((r) => r.reason)).toEqual([
      "synced source folder",
      "agent kernel file",
      "hidden or config folder",
      "note does not exist",
    ]);
    expect(created).toEqual([]);
    expect(store.get("_exo/agent/USER.md")).toBe("user\n");
  });

  it("creates today's inbox note when needed, and records it as created", async () => {
    const { vault, store, created } = fakeVault({});
    const res = await applyDecisions(
      vault,
      [
        { op: "add", candidate: 0, path: INBOX, text: "rclone has a gdrive remote" },
        { op: "add", candidate: 1, path: INBOX, text: "second fact" },
      ],
      envFor(vault),
    );
    expect(created).toEqual([INBOX]);
    expect(store.get(INBOX)).toMatch(/# Memory inbox: 2026-09-25\n- rclone has a gdrive remote\n- second fact\n$/);
    expect(res.files).toEqual([{ path: INBOX, before: null, after: store.get(INBOX) }]);
  });

  it("drops edits that carry a credential", async () => {
    const { vault, store } = fakeVault({ "a.md": "- x\n" });
    const res = await applyDecisions(
      vault,
      [{ op: "add", candidate: 0, path: "a.md", text: "deploy token: ghp_abcdefghijklmnopqrstuvwxyz0123" }],
      envFor(vault),
    );
    expect(res.writes).toEqual([]);
    expect(res.rejected[0].reason).toBe("looks like a credential");
    expect(store.get("a.md")).toBe("- x\n");
  });

  it(`stops at ${HARVEST_MAX_WRITES} writes per harvest`, async () => {
    const { vault } = fakeVault({ "a.md": "" });
    const decisions: Decision[] = Array.from({ length: HARVEST_MAX_WRITES + 3 }, (_, i) => ({
      op: "add" as const,
      candidate: i,
      path: "a.md",
      text: `fact number ${i}`,
    }));
    const res = await applyDecisions(vault, decisions, envFor(vault));
    expect(res.writes).toHaveLength(HARVEST_MAX_WRITES);
    expect(res.rejected.filter((r) => r.reason === "write limit reached")).toHaveLength(3);
  });

  it("two writes to one note keep the ORIGINAL content as the snapshot", async () => {
    const { vault, store } = fakeVault({ "a.md": "- one\n" });
    const res = await applyDecisions(
      vault,
      [
        { op: "add", candidate: 0, path: "a.md", text: "two" },
        { op: "add", candidate: 1, path: "a.md", text: "three" },
      ],
      envFor(vault),
    );
    expect(res.files).toEqual([{ path: "a.md", before: "- one\n", after: "- one\n- two\n- three\n" }]);
    expect(store.get("a.md")).toBe("- one\n- two\n- three\n");
  });
});
