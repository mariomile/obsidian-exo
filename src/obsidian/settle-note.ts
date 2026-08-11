/**
 * Settle to note — the vault half. Reads the chats folder, decides between a
 * fresh note and an update of the one this conversation already owns, and
 * writes it.
 *
 * Written through the VAULT API (`create` / `modify`), never through
 * `vault.adapter`: the adapter bypasses Obsidian's metadata cache, and a file
 * the cache never saw has no backlinks, no graph node and no place in search
 * until the next restart. The whole point of this phase is that a settled chat
 * becomes a real vault citizen, so the write path is the one that makes it one.
 *
 * All the decisions — what goes in, where it goes, whether it may go at all —
 * live in `core/settle-note.ts`. This file only touches files.
 */
import { TFile, type App } from "obsidian";
import type { ExoPaths } from "../core/paths";
import { buildRecap } from "../core/recap";
import { WriteQueue } from "../core/write-queue";
import type { Message } from "../core/model";
import {
  distillConversation,
  findSettledNote,
  renderSettleNote,
  settleFolder,
  settleStamp,
  uniqueSettlePath,
  type SettleSource,
} from "../core/settle-note";

/** Structural slice of the vault this module needs — same shape and same
 *  reason as `AgentVaultAdapter`: the writer stays unit-testable and the
 *  Obsidian API sits behind one adapter. */
export interface SettleVaultAdapter {
  listFiles(dir: string): Promise<string[]>;
  read(path: string): Promise<string>;
  /** Creates or modifies through the Vault API, so the cache sees it. */
  write(path: string, content: string): Promise<void>;
  ensureFolder(dir: string): Promise<void>;
}

export function adaptAppToSettleVault(app: App): SettleVaultAdapter {
  return {
    listFiles: async (dir) => {
      try {
        return (await app.vault.adapter.list(dir)).files.filter((p) => p.endsWith(".md"));
      } catch {
        return []; // the folder does not exist yet — the normal first-run case
      }
    },
    read: (path) => app.vault.adapter.read(path),
    write: async (path, content) => {
      const file = app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) await app.vault.modify(file, content);
      else await app.vault.create(path, content);
    },
    ensureFolder: async (dir) => {
      if (!dir || app.vault.getAbstractFileByPath(dir)) return;
      try {
        await app.vault.createFolder(dir);
      } catch {
        /* raced with another writer, or already exists */
      }
    },
  };
}

/**
 * Mirror one settled conversation into its vault note and return the path.
 *
 * Re-settling updates: the folder is scanned for the note carrying this
 * conversation's frontmatter stamp, and when one is found it is rewritten in
 * place — under whatever name the user has since given it. Only when there is
 * none does a new file appear, and even then it never overwrites a note that
 * belongs to a different chat.
 *
 * The caller owns the settled-only gate (`canSettle`): this function is the
 * write, not the policy.
 */
export function settleConversationToNote(
  vault: SettleVaultAdapter,
  paths: ExoPaths,
  src: SettleSource,
  normalize: (p: string) => string = (p) => p,
): Promise<string> {
  return settleWrites.enqueue(() => settleOnce(vault, paths, src, normalize));
}

/**
 * ONE SETTLE AT A TIME. The decision below is a read of the whole folder
 * followed by a write, with N awaits in between: two conversations both called
 * "New chat", settled a keystroke apart from the sidebar, both saw a folder
 * without the other's note, both claimed the same path, and the second one
 * modified the file the first had just created. One chat ended up with no
 * note, and the surviving file carried the other chat's stamp.
 *
 * The queue is this module's own rather than the plugin's `tasksWriteQueue`,
 * which serializes writes to `tasks.md`: the two never touch the same file, and
 * a lock a caller has to remember to take is a lock that will be forgotten.
 */
const settleWrites = new WriteQueue();

async function settleOnce(
  vault: SettleVaultAdapter,
  paths: ExoPaths,
  src: SettleSource,
  normalize: (p: string) => string,
): Promise<string> {
  const folder = settleFolder(paths);
  await vault.ensureFolder(folder);

  const existingPaths = await vault.listFiles(folder);
  const files: { path: string; raw: string }[] = [];
  for (const path of existingPaths) {
    try {
      files.push({ path, raw: await vault.read(path) });
    } catch {
      /* unreadable file — it simply cannot be this conversation's note */
    }
  }

  const owned = findSettledNote(files, settleStamp(src));
  // Taken is the LISTING, not the files that read back. A note we could not
  // read is not this conversation's note, but it is still a file: deriving the
  // collision set from `files` would hand back its exact path and `write`
  // would resolve it to a TFile and replace it wholesale.
  const takenByOthers = existingPaths.filter((p) => p !== owned);
  const target = owned ?? uniqueSettlePath(folder, src.title, takenByOthers);
  const existing = owned ? (files.find((f) => f.path === owned)?.raw ?? null) : null;

  const note = distillConversation(src, buildRecap(src.messages as Message[], normalize));
  await vault.write(target, renderSettleNote(existing, note));
  return target;
}
