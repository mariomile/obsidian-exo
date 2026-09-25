import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Git, impure shell: the vault's git auto-commit, memory-harvest commits and
 * their revert. Argument arrays only, explicit cwd, never a shell string, so
 * no path or message is ever interpolated into a command line. See
 * core/git-autocommit.ts for the pure decision logic the auto-commit executes.
 *
 * Every helper takes a {@link GitRun} rather than a cwd, so the harvest and
 * undo flows are testable against a scripted fake.
 */

/** Run `git <args>` and resolve with stdout; rejects on non-zero exit. */
export type GitRun = (args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

export function gitRunner(cwd: string): GitRun {
  return async (args) => (await execFileAsync("git", args, { cwd })).stdout;
}

/** Best-effort text of a node `child_process` error, for matching known-benign
 *  git outcomes (e.g. "nothing to commit"). Never throws. */
export function errText(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const e = err as { message?: unknown; stdout?: unknown; stderr?: unknown };
  return [e.message, e.stdout, e.stderr]
    .filter((x): x is string => typeof x === "string")
    .join("\n");
}

/** Is the cwd inside a git working tree, and is the `git` binary itself
 *  available? A single `git rev-parse` call answers both: ENOENT means the
 *  binary is missing; any other failure (exit 128, "not a git repository")
 *  means git ran fine but this path isn't a repo. Neither case throws: both
 *  are normal, silent no-op conditions, not failures. */
export async function checkGitRepo(git: GitRun): Promise<{ isGitRepo: boolean; gitAvailable: boolean }> {
  try {
    const stdout = await git(["rev-parse", "--is-inside-work-tree"]);
    return { isGitRepo: stdout.trim() === "true", gitAvailable: true };
  } catch (err) {
    const code = (err as { code?: unknown } | undefined)?.code;
    if (code === "ENOENT") return { isGitRepo: false, gitAvailable: false }; // git binary not found
    return { isGitRepo: false, gitAvailable: true }; // git ran, just not (cleanly) a repo here
  }
}

/** `git status --porcelain` on `paths`: non-empty output means they are dirty. */
export async function isWorktreeDirty(git: GitRun, paths: readonly string[]): Promise<boolean> {
  return (await git(["status", "--porcelain", "--", ...paths])).trim().length > 0;
}

/** Stage `paths` and commit ONLY them with `message`. A concurrent process
 *  (another Exo tick, a manual commit) can beat us to it between the
 *  dirty-check and here: `git commit` then exits non-zero with "nothing to
 *  commit", which is swallowed as benign; any other failure propagates. */
export async function runGitCommit(git: GitRun, paths: readonly string[], message: string): Promise<void> {
  await git(["add", "-A", "--", ...paths]);
  try {
    await git(["commit", "-m", message, "--", ...paths]);
  } catch (err) {
    if (/nothing to commit/i.test(errText(err))) return; // race: benign, silent
    throw err;
  }
}

/** The current HEAD sha. */
export async function headSha(git: GitRun): Promise<string> {
  return (await git(["rev-parse", "HEAD"])).trim();
}
