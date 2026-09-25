/**
 * Undo a memory harvest. With git: `git revert` the harvest commit, refusing
 * when any file it touched changed since. Without git (a vault that is not a
 * repo): restore the snapshots the harvest took, refusing the same way when a
 * file no longer holds what the harvest wrote. I/O is injected; the git runner
 * is the `GitRun` shape from `obsidian/git.ts`.
 */
import {
  HARVEST_COMMIT_PREFIX,
  REVERT_COMMIT_PREFIX,
  revertCommitMessage,
} from "./memory-harvest";
import type { FileSnapshot } from "./memory-apply";

type GitRun = (args: string[]) => Promise<string>;

export interface UndoVault {
  /** Current content, or null when the file is gone. */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface UndoResult {
  ok: boolean;
  message: string;
  /** The revert commit, when git made one. */
  revertSha?: string;
}

const lines = (out: string): string[] =>
  out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Latest harvest commit not already reverted, from the vault's git log. */
export async function latestHarvestSha(git: GitRun): Promise<string | null> {
  const out = await git([
    "log",
    "-n",
    "200",
    "--format=%H%x09%s",
    "-E",
    `--grep=^exo: memory (harvest|revert):`,
  ]);
  const reverted = new Set<string>();
  for (const line of lines(out)) {
    const [sha, subject = ""] = line.split("\t");
    if (subject.startsWith(REVERT_COMMIT_PREFIX)) reverted.add(subject.slice(REVERT_COMMIT_PREFIX.length).trim());
    else if (subject.startsWith(HARVEST_COMMIT_PREFIX) && ![...reverted].some((r) => sha.startsWith(r) || r.startsWith(sha))) {
      return sha;
    }
  }
  return null;
}

export async function revertHarvestCommit(git: GitRun, sha: string): Promise<UndoResult> {
  let subject: string;
  try {
    subject = (await git(["log", "-1", "--format=%s", sha])).trim();
  } catch {
    return { ok: false, message: `No commit ${sha} in this vault.` };
  }
  if (!subject.startsWith(HARVEST_COMMIT_PREFIX)) {
    return { ok: false, message: `${sha.slice(0, 8)} is not a memory harvest commit ("${subject}").` };
  }
  const files = lines(await git(["show", "--name-only", "--format=", sha]));
  if (!files.length) return { ok: false, message: `${sha.slice(0, 8)} touched no files.` };
  const later = lines(await git(["log", "--format=%H", `${sha}..HEAD`, "--", ...files]));
  const dirty = lines(await git(["status", "--porcelain", "--", ...files]));
  if (later.length || dirty.length) {
    return {
      ok: false,
      message: `Not reverted: ${files.join(", ")} changed since the harvest. Edit the lines by hand instead.`,
    };
  }
  try {
    await git(["revert", "--no-commit", sha]);
    await git(["commit", "-m", revertCommitMessage(sha), "--", ...files]);
  } catch (err) {
    try {
      await git(["revert", "--abort"]);
    } catch {
      /* nothing to abort */
    }
    return { ok: false, message: `git revert failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const revertSha = (await git(["rev-parse", "HEAD"])).trim();
  return { ok: true, message: `Reverted memory harvest ${sha.slice(0, 8)} (${files.length} file(s)).`, revertSha };
}

/** No-git undo: put every file back to its pre-harvest content, all or nothing. */
export async function restoreSnapshots(vault: UndoVault, files: readonly FileSnapshot[]): Promise<UndoResult> {
  if (!files.length) return { ok: false, message: "That harvest has no snapshot to restore." };
  for (const f of files) {
    if ((await vault.read(f.path)) !== f.after) {
      return { ok: false, message: `Not restored: ${f.path} changed since the harvest. Edit the lines by hand instead.` };
    }
  }
  for (const f of files) {
    if (f.before === null) await vault.remove(f.path);
    else await vault.write(f.path, f.before);
  }
  return { ok: true, message: `Restored ${files.length} file(s) to before the harvest.` };
}
