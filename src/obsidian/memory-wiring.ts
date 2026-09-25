import { Notice, TFile } from "obsidian";
import type ExoPlugin from "../main";
import { memoryCaps, type MemoryCaps } from "../core/memory-caps";
import { latestHarvestSha, restoreSnapshots, revertHarvestCommit, type UndoResult } from "../core/memory-undo";
import { MemoryHarvester } from "./memory-harvest";
import { HarvestLog } from "./harvest-log";
import { checkGitRepo, gitRunner, type GitRun } from "./git";
import { vaultBasePath } from "./tool-kit";
import { harvestSource } from "../ui/convo-bridge";

/**
 * Plugin-side wiring for automatic memory: the harvester (heartbeat, catch-up,
 * leave-triggered harvests), its log, and undo. Kept out of main.ts, which
 * sits under the size ratchet.
 */

/** How often due conversations are checked. The idle threshold (10 min) is
 *  what actually paces harvests; this only bounds the lag after it. */
export const HARVEST_HEARTBEAT_MS = 2 * 60 * 1000;
/** First catch-up after layout-ready: late enough to stay off the startup path. */
export const HARVEST_FIRST_TICK_MS = 60 * 1000;

/** Memory caps for the plugin's own surfaces (commands, capture, hub). */
export function pluginMemoryCaps(plugin: ExoPlugin): MemoryCaps {
  return memoryCaps(plugin.settings, { surface: "chat" });
}

function vaultGit(plugin: ExoPlugin): GitRun | null {
  const base = vaultBasePath(plugin.app);
  return base ? gitRunner(base) : null;
}

export function createHarvestLog(plugin: ExoPlugin): HarvestLog {
  const path = `${plugin.manifest.dir}/memory-harvests.json`;
  const adapter = plugin.app.vault.adapter;
  return new HarvestLog({
    read: async () => ((await adapter.exists(path)) ? adapter.read(path) : null),
    write: (content) => adapter.write(path, content),
  });
}

export function createMemoryHarvester(plugin: ExoPlugin, log: HarvestLog): MemoryHarvester {
  return new MemoryHarvester({
    app: plugin.app,
    caps: () => pluginMemoryCaps(plugin),
    paths: () => plugin.paths,
    source: () => harvestSource(plugin.app),
    utility: async (prompt, signal) => {
      let tokens: number | null = null;
      const text = await plugin.runUtilityPass(prompt, {
        signal,
        onUsage: (t) => {
          tokens = t;
        },
      });
      return { text, tokens };
    },
    budget: {
      check: (estimate) => plugin.checkBackgroundBudget(estimate),
      record: (tokens) => plugin.recordBackgroundSpend(tokens),
    },
    writeQueue: plugin.memoryWriteQueue,
    git: () => vaultGit(plugin),
    log,
    notify: (message) => new Notice(message, 8000),
    diag: (message) => plugin.diag.push("memory", message),
  });
}

/**
 * Undo a memory harvest: the latest one not yet undone, or `target` (a harvest
 * record id, or a commit sha or its prefix). With git: `git revert` (refused if a touched note changed
 * since). Without git: restore the harvest's snapshots (same refusal).
 */
export async function undoMemoryWrite(plugin: ExoPlugin, log: HarvestLog, target?: string): Promise<UndoResult> {
  const records = await log.list();
  const want = target?.trim();
  const record = want
    ? records.find((r) => r.id === want || (r.sha && (r.sha.startsWith(want) || want.startsWith(r.sha))))
    : records.find((r) => !r.undoneAt);
  if (record?.undoneAt) return { ok: false, message: "That harvest was already undone." };

  const git = vaultGit(plugin);
  const repo = git ? await checkGitRepo(git) : { isGitRepo: false, gitAvailable: false };
  let result: UndoResult;
  if (git && repo.isGitRepo) {
    const sha = record ? record.sha : (want ?? (await latestHarvestSha(git)) ?? undefined);
    if (sha) result = await revertHarvestCommit(git, sha);
    else if (record) result = await restoreSnapshots(snapshotVault(plugin), record.files);
    else result = { ok: false, message: "No memory harvest to undo." };
  } else if (record) {
    result = await restoreSnapshots(snapshotVault(plugin), record.files);
  } else {
    result = { ok: false, message: want ? `No memory harvest ${want} on record.` : "No memory harvest to undo." };
  }
  if (result.ok && record) await log.markUndone(record.id, Date.now());
  plugin.refreshHub();
  return result;
}

function snapshotVault(plugin: ExoPlugin) {
  const vault = plugin.app.vault;
  return {
    read: async (path: string) => {
      const f = vault.getAbstractFileByPath(path);
      return f instanceof TFile ? vault.read(f) : null;
    },
    write: async (path: string, content: string) => {
      const f = vault.getAbstractFileByPath(path);
      if (f instanceof TFile) await vault.modify(f, content);
      else await vault.create(path, content);
    },
    remove: async (path: string) => {
      const f = vault.getAbstractFileByPath(path);
      if (f instanceof TFile) await plugin.app.fileManager.trashFile(f);
    },
  };
}

/** Build the harvester and its log onto the plugin, and register the undo
 *  command, the heartbeat and the first catch-up tick. Called in onload
 *  before the chat view registers: the view reports tab switches to it. */
export function registerMemory(plugin: ExoPlugin): void {
  plugin.harvestLog = createHarvestLog(plugin);
  plugin.memoryHarvest = createMemoryHarvester(plugin, plugin.harvestLog);
  plugin.register(() => plugin.memoryHarvest.dispose());

  plugin.addCommand({
    id: "undo-memory-write",
    name: "Undo last memory write",
    checkCallback: (checking) => {
      if (!pluginMemoryCaps(plugin).undo) return false;
      if (!checking) {
        void undoMemoryWrite(plugin, plugin.harvestLog).then((r) => new Notice(r.message, 8000));
      }
      return true;
    },
  });

  plugin.registerInterval(window.setInterval(() => void plugin.memoryHarvest.tick(), HARVEST_HEARTBEAT_MS));
  plugin.app.workspace.onLayoutReady(() => {
    const t = window.setTimeout(() => void plugin.memoryHarvest.tick(), HARVEST_FIRST_TICK_MS);
    plugin.register(() => window.clearTimeout(t));
  });
}
