import { describe, expect, it, vi } from "vitest";
import { parseLoopsFile } from "../src/core/open-loops";
import type { ProposalRecord } from "../src/core/proposals";
import { WriteQueue } from "../src/core/write-queue";
import { routeAcceptedProposal } from "../src/obsidian/proposal-router";
import {
  DECISIONS_DIR,
  OPEN_LOOPS_PATH,
  DecisionProposalTarget,
  OpenLoopProposalTarget,
  PlaybookProposalTarget,
  createProposalAcceptanceDeps,
  type ProposalTargetVaultAdapter,
} from "../src/obsidian/proposal-targets";

function fakeVault(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const folders = new Set<string>();
  const adapter: ProposalTargetVaultAdapter = {
    getFile: (path) => (files.has(path) ? { path } : null),
    read: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`missing: ${path}`);
      return content;
    },
    create: async (path, content) => {
      if (files.has(path)) throw new Error(`already exists: ${path}`);
      files.set(path, content);
    },
    modify: async (path, content) => {
      if (!files.has(path)) throw new Error(`missing: ${path}`);
      files.set(path, content);
    },
    ensureFolder: async (path) => {
      const slash = path.lastIndexOf("/");
      if (slash > 0) folders.add(path.slice(0, slash));
    },
  };
  return { adapter, files, folders };
}

describe("OpenLoopProposalTarget", () => {
  it("serializes concurrent creates without losing entries and makes same-millisecond ids unique", async () => {
    const { adapter, files, folders } = fakeVault();
    const target = new OpenLoopProposalTarget(adapter, new WriteQueue(), () => 1_720_000_000_000);

    const created = await Promise.all([
      target.create({ title: "One", note: "First" }),
      target.create({ title: "Two", note: "Second", tags: ["exo"] }),
      target.create({ title: "Three", note: "Third", resurface: "2026-08-01" }),
    ]);

    expect(new Set(created.map(({ id }) => id)).size).toBe(3);
    expect(created.map(({ id }) => id)).toEqual([
      "loop-1720000000000",
      "loop-1720000000001",
      "loop-1720000000002",
    ]);
    expect(parseLoopsFile(files.get(OPEN_LOOPS_PATH)!).map(({ title }) => title)).toEqual([
      "One",
      "Two",
      "Three",
    ]);
    expect(folders).toContain("_system/memory");
  });
});

describe("DecisionProposalTarget", () => {
  it("creates the dated slug path with raw-patched frontmatter and decision body", async () => {
    const { adapter, files, folders } = fakeVault();
    const target = new DecisionProposalTarget(adapter, () => new Date(2026, 6, 20, 23, 30));

    const result = await target.captureRawPreserving({
      title: "Require Explicit Accept!",
      context: "Suggestions remain inert.",
      decision: "Require a user click.",
      rationale: "Prevents surprise writes.",
    });

    const path = `${DECISIONS_DIR}/2026-07-20-require-explicit-accept.md`;
    expect(result).toEqual({ path });
    expect(files.get(path)).toBe(
      `---\ntype: "decision"\ncreated_by: "exo"\ncreated: "2026-07-20"\ntags: ["type/decision"]\n---\n` +
      `# Decision: Require Explicit Accept!\n\n` +
      `## Contesto\nSuggestions remain inert.\n\n` +
      `## Decisione\nRequire a user click.\n\n` +
      `## Razionale\nPrevents surprise writes.\n`
    );
    expect(folders).toContain(DECISIONS_DIR);
  });

  it("fails on a collision instead of overwriting the existing decision", async () => {
    const path = `${DECISIONS_DIR}/2026-07-20-same.md`;
    const { adapter, files } = fakeVault({ [path]: "keep me" });
    const target = new DecisionProposalTarget(adapter, () => new Date(2026, 6, 20));

    await expect(target.captureRawPreserving({
      title: "Same",
      context: "Context",
      decision: "Decision",
      rationale: "Rationale",
    })).rejects.toThrow(`Already exists: ${path}`);
    expect(files.get(path)).toBe("keep me");
  });
});

describe("PlaybookProposalTarget", () => {
  it("resolves names case-insensitively inside the serialized save boundary", async () => {
    const settings = { customPrompts: [{ name: "digest", prompt: "old" }] };
    const saveSettings = vi.fn(async () => undefined);
    const target = new PlaybookProposalTarget(
      new WriteQueue(),
      { settings: () => settings, saveSettings }
    );

    await expect(target.save({ name: "Digest", prompt: "new" })).resolves.toEqual({ name: "Digest 2" });
    expect(settings.customPrompts.at(-1)).toEqual({ name: "Digest 2", prompt: "new" });
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent additions and saves each collision-safe snapshot", async () => {
    const settings = { customPrompts: [] as { name: string; prompt: string }[] };
    const snapshots: string[][] = [];
    const target = new PlaybookProposalTarget(
      new WriteQueue(),
      {
        settings: () => settings,
        saveSettings: async () => {
          await Promise.resolve();
          snapshots.push(settings.customPrompts.map(({ name }) => name));
        },
      }
    );

    const saved = await Promise.all([
      target.save({ name: "Review", prompt: "one" }),
      target.save({ name: "review", prompt: "two" }),
      target.save({ name: "Review", prompt: "three" }),
    ]);

    expect(saved.map(({ name }) => name)).toEqual(["Review", "review 2", "Review 3"]);
    expect(snapshots).toEqual([
      ["Review"],
      ["Review", "review 2"],
      ["Review", "review 2", "Review 3"],
    ]);
  });
});

describe("createProposalAcceptanceDeps", () => {
  it("passes the shared TaskStore-shaped dependency through unchanged", () => {
    const { adapter } = fakeVault();
    const tasks = { create: vi.fn(async () => ({ id: "task-1" })) };
    const deps = createProposalAcceptanceDeps({
      tasks,
      vault: adapter,
      loopsWriteQueue: new WriteQueue(),
      playbooksWriteQueue: new WriteQueue(),
      playbooks: {
        settings: () => ({ customPrompts: [] }),
        saveSettings: async () => undefined,
      },
    });
    expect(deps.tasks).toBe(tasks);
  });

  it("lets the router convert a production adapter failure to a retryable route error", async () => {
    const { adapter } = fakeVault();
    adapter.create = async () => {
      throw new Error("vault is read-only");
    };
    const deps = createProposalAcceptanceDeps({
      tasks: { create: async () => ({ id: "task-1" }) },
      vault: adapter,
      loopsWriteQueue: new WriteQueue(),
      playbooksWriteQueue: new WriteQueue(),
      playbooks: {
        settings: () => ({ customPrompts: [] }),
        saveSettings: async () => undefined,
      },
    });
    const record = {
      id: "proposal-loop",
      kind: "loop",
      status: "pending",
      title: "Remember",
      payload: { kind: "loop", title: "Remember", note: "Later" },
      rationale: "Requested follow-up",
      fingerprint: "fp",
      source: { convoId: "c", turnId: "t", createdAt: 1 },
    } satisfies ProposalRecord;

    await expect(routeAcceptedProposal(record, deps)).resolves.toEqual({
      ok: false,
      error: "vault is read-only",
    });
  });
});
