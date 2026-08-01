import { describe, it, expect, beforeEach } from "vitest";
import { AgentStore, type AgentVaultAdapter, type RawBrain } from "../src/obsidian/agent-store";
import { exoPaths } from "../src/core/paths";
import { WriteQueue } from "../src/core/write-queue";
import { parseAgentSidecar, defaultContract } from "../src/core/agents";

const paths = exoPaths("_system");

/** In-memory vault: path → content. */
function fakeVault(files: Record<string, string> = {}): AgentVaultAdapter & { files: Record<string, string> } {
  const folders = new Set<string>();
  return {
    files,
    listFiles: async (dir) =>
      Object.keys(files).filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/")),
    read: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    write: async (p, c) => {
      files[p] = c;
    },
    exists: async (p) => p in files,
    ensureFolder: async (d) => {
      folders.add(d);
    },
  };
}

const brainFile = (slug: string, fm: string[] = [], source: RawBrain["source"] = "vault"): RawBrain => ({
  slug,
  path: `.claude/agents/${slug}.md`,
  raw: ["---", `name: ${slug}`, ...fm, "---", "You are an agent."].join("\n"),
  source,
});

const sidecar = (slug: string, extra: string[] = []) =>
  ["---", "type: agent", `agent: ${slug}`, "enabled: true", ...extra, "---", "notes"].join("\n");

function makeStore(vaultFiles: Record<string, string>, brains: RawBrain[]) {
  const vault = fakeVault(vaultFiles);
  const store = new AgentStore({ vault, paths, queue: new WriteQueue(), brains: async () => brains });
  return { store, vault };
}

describe("AgentStore.refresh", () => {
  it("joins brains with contracts by slug", async () => {
    const { store } = makeStore(
      { "_system/agents/ghostwriter.md": sidecar("ghostwriter", ["autonomy: act", 'write: ["Posts/**"]']) },
      [brainFile("ghostwriter", ["description: Drafts posts"]), brainFile("crm-keeper")]
    );
    await store.refresh();

    expect(store.list().map((a) => a.brain.slug).sort()).toEqual(["crm-keeper", "ghostwriter"]);
    const gw = store.get("ghostwriter")!;
    expect(gw.brain.description).toBe("Drafts posts");
    expect(gw.contract.enabled).toBe(true);
    expect(gw.contract.autonomy).toBe("act");
    // A brain with no sidecar stays inert.
    expect(store.get("crm-keeper")!.contract).toEqual(defaultContract("crm-keeper"));
  });

  it("only enabled agents are eligible for triggers", async () => {
    const { store } = makeStore({ "_system/agents/a.md": sidecar("a") }, [brainFile("a"), brainFile("b")]);
    await store.refresh();
    expect(store.enabled().map((x) => x.brain.slug)).toEqual(["a"]);
  });

  it("ignores non-contract notes in the agents folder and reports them as conflicts", async () => {
    // marioverse already has _system/agents/ghostwriter.md as a `type: memory` note.
    const legacy = ["---", "type: memory", "tags:", "  - type/memory", "---", "# Ghostwriter voice notes"].join("\n");
    const { store } = makeStore({ "_system/agents/ghostwriter.md": legacy }, [brainFile("ghostwriter")]);
    await store.refresh();

    expect(store.conflicts()).toEqual([{ slug: "ghostwriter", path: "_system/agents/ghostwriter.md" }]);
    expect(store.get("ghostwriter")!.contract.enabled).toBe(false); // never parsed as a contract
  });

  it("reports contracts whose brain disappeared", async () => {
    const { store } = makeStore({ "_system/agents/ghost.md": sidecar("ghost") }, [brainFile("a")]);
    await store.refresh();
    expect(store.orphans()).toEqual(["ghost"]);
    expect(store.get("ghost")).toBeNull();
  });

  it("surfaces sidecar warnings without dropping the agent", async () => {
    const { store } = makeStore({ "_system/agents/a.md": sidecar("a", ["autonomy: yolo"]) }, [brainFile("a")]);
    await store.refresh();
    expect(store.get("a")).not.toBeNull();
    expect(store.warningsFor("a").join(" ")).toMatch(/unknown autonomy/);
  });

  it("applies source precedence — a vault brain shadows a global one", async () => {
    const { store } = makeStore({}, [
      brainFile("a", ["description: vault copy"], "vault"),
      brainFile("a", ["description: global copy"], "user"),
    ]);
    await store.refresh();
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].brain.description).toBe("vault copy");
  });

  it("survives a failing brain scan and unreadable sidecars", async () => {
    const vault = fakeVault({ "_system/agents/a.md": sidecar("a") });
    vault.read = async () => {
      throw new Error("boom");
    };
    const store = new AgentStore({
      vault,
      paths,
      queue: new WriteQueue(),
      brains: async () => {
        throw new Error("scan failed");
      },
    });
    await expect(store.refresh()).resolves.toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(store.isLoaded()).toBe(true);
  });

  it("ignores non-markdown files and files in subfolders", async () => {
    const { store } = makeStore(
      { "_system/agents/notes.txt": "x", "_system/agents/runs/2026-08.md": sidecar("2026-08") },
      [brainFile("a")]
    );
    await store.refresh();
    expect(store.conflicts()).toEqual([]);
    expect(store.orphans()).toEqual([]);
  });

  it("notifies subscribers, and a throwing listener does not break the store", async () => {
    const { store } = makeStore({}, [brainFile("a")]);
    const seen: string[] = [];
    store.subscribe(() => {
      throw new Error("bad listener");
    });
    const off = store.subscribe(() => seen.push("hit"));
    await store.refresh();
    expect(seen).toEqual(["hit"]);
    off();
    await store.refresh();
    expect(seen).toEqual(["hit"]);
  });
});

describe("AgentStore.scaffoldMissing", () => {
  let store: AgentStore;
  let vault: ReturnType<typeof fakeVault>;

  beforeEach(async () => {
    ({ store, vault } = makeStore({}, [brainFile("a"), brainFile("b")]));
    await store.refresh();
  });

  it("writes an inert sidecar per brain that has none", async () => {
    const written = await store.scaffoldMissing("2026-08-01");
    expect(written.sort()).toEqual(["_system/agents/a.md", "_system/agents/b.md"]);

    const { contract } = parseAgentSidecar(vault.files["_system/agents/a.md"], "a");
    expect(contract.enabled).toBe(false);
    expect(contract.triggers).toEqual([]);
    expect(contract.scope.write).toEqual([]);
  });

  it("is idempotent — a second pass writes nothing", async () => {
    await store.scaffoldMissing();
    await store.refresh();
    expect(await store.scaffoldMissing()).toEqual([]);
  });

  it("never overwrites an existing contract", async () => {
    ({ store, vault } = makeStore(
      { "_system/agents/a.md": sidecar("a", ["autonomy: act", 'write: ["Posts/**"]']) },
      [brainFile("a")]
    ));
    await store.refresh();
    expect(await store.scaffoldMissing()).toEqual([]);
    expect(store.get("a")!.contract.autonomy).toBe("act");
  });

  it("never overwrites a conflicting non-contract note", async () => {
    const legacy = ["---", "type: memory", "---", "important human notes"].join("\n");
    ({ store, vault } = makeStore({ "_system/agents/a.md": legacy }, [brainFile("a")]));
    await store.refresh();
    expect(await store.scaffoldMissing()).toEqual([]);
    expect(vault.files["_system/agents/a.md"]).toBe(legacy);
  });
});

describe("AgentStore writes", () => {
  it("persists a contract and re-reads it", async () => {
    const { store, vault } = makeStore({}, [brainFile("a", ["description: does things"])]);
    await store.refresh();

    await store.saveContract(
      { ...defaultContract("a"), enabled: true, autonomy: "act", scope: { read: [], write: ["Posts/**"] } },
      "2026-08-01"
    );

    expect(vault.files["_system/agents/a.md"]).toContain("enabled: true");
    const reloaded = store.get("a")!;
    expect(reloaded.contract.enabled).toBe(true);
    expect(reloaded.contract.scope.write).toEqual(["Posts/**"]);
  });

  it("setEnabled flips only the flag", async () => {
    const { store } = makeStore({ "_system/agents/a.md": sidecar("a", ['write: ["Posts/**"]', "autonomy: act"]) }, [
      brainFile("a"),
    ]);
    await store.refresh();
    await store.setEnabled("a", false);
    const c = store.get("a")!.contract;
    expect(c.enabled).toBe(false);
    expect(c.autonomy).toBe("act");
    expect(c.scope.write).toEqual(["Posts/**"]);
  });

  it("setEnabled on an unknown slug is a no-op", async () => {
    const { store, vault } = makeStore({}, [brainFile("a")]);
    await store.refresh();
    await store.setEnabled("nope", true);
    expect(vault.files["_system/agents/nope.md"]).toBeUndefined();
  });
});
