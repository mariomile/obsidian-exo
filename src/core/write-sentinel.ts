/**
 * Write-sentinel bridge — pure decision logic.
 *
 * Several agent sessions can write the same vault at once (Exo, one or more
 * Claude Code sessions, Codex). Each serializes its OWN writes — Exo through its
 * in-process WriteQueue — but none can see the others, so two sessions editing
 * one note clobber each other silently.
 *
 * The sentinel is a machine-local REGISTRY (never a lock): it records who wrote
 * what so overlaps become visible. This module decides WHETHER to record and
 * WHICH paths to send; the impure shell (main.ts) owns spawning the CLI, and
 * does so fire-and-forget so a turn is never delayed or failed by it.
 *
 * Tool + format live in ~/.marioverse/write-sentinel (shared with the CLI hook),
 * so the on-disk shape has exactly one owner.
 *
 * No 'obsidian' import here — deliberately, so this is unit-testable with plain
 * strings, no mocks required.
 */

/** Session label recorded for writes coming from the plugin. */
export const SENTINEL_AGENT = "exo";

/** Path of the sentinel CLI, relative to the user's home directory. */
export const SENTINEL_REL_PATH = ".marioverse/write-sentinel/sentinel.mjs";

/**
 * Vault-relative, forward-slashed paths — the shared key every session agrees
 * on. Drops anything outside the vault, since that is not shared state.
 *
 * Mirrors the normalization the sentinel CLI applies, so a path recorded by Exo
 * and the same path recorded by a CLI session collide on the same key.
 */
export function normalizeSentinelPaths(paths: readonly string[], vaultPath: string): string[] {
  const cwd = vaultPath.replace(/\/$/, "");
  const out: string[] = [];
  for (const raw of paths) {
    let path = raw.trim().replace(/\\/g, "/");
    if (!path) continue;
    if (path.startsWith(cwd + "/")) path = path.slice(cwd.length + 1);
    else if (path.startsWith("/")) continue;
    path = path.replace(/^\.\//, "");
    if (!path || path.split("/").includes("..")) continue;
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

/**
 * Argv for one `record` invocation, or null when there is nothing to record.
 * Capped because the registry only needs recent writes, and an unbounded argv
 * would be a silly way to fail on a huge turn.
 */
export function sentinelRecordArgs(
  scriptPath: string,
  paths: readonly string[],
  max = 40,
): string[] | null {
  if (!paths.length) return null;
  return [scriptPath, "record", ...paths.slice(0, max)];
}
