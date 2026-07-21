/**
 * Vault Setup — pure logic (no Obsidian imports).
 *
 * Exo reads and writes a fixed set of paths under its memory root for its
 * memory features (open loops, task board, preferences, cockpit staleness,
 * dream pass). On a fresh vault none of that exists, so every one of those
 * features silently degrades to empty/inert with no signal to the user that
 * anything is missing. `scaffoldItems(paths)` is the create-only-if-absent
 * list that fixes that; `isVaultSetUp` is the single-file detection check used
 * to decide whether to offer the scaffold at all.
 *
 * All paths derive from the caller-supplied `ExoPaths` (core/paths.ts), so the
 * root is configurable and the module stays pure/testable.
 *
 * Deliberately excluded (see the implementation plan's Global Constraints
 * for why): the `agent/{now,human,persona}.md` blocks (owned by the "Agent Is
 * the Folder" LLM seeder — pre-creating blanks would make it think they're
 * already seeded) and `review.md` (its mere existence is read as a UI signal
 * that there's something to review).
 */

import type { ExoPaths } from "./paths";

export type ScaffoldKind = "folder" | "file";

export interface ScaffoldItem {
  path: string;
  kind: ScaffoldKind;
  /** Starter content for `kind: "file"`. Always absent for `kind: "folder"`. */
  content?: string;
}

const heading = (title: string, body: string): string => `# ${title}\n\n${body}\n`;

/** The create-only-if-absent scaffold for a given memory root. */
export function scaffoldItems(paths: ExoPaths): ScaffoldItem[] {
  return [
    { path: paths.decisions, kind: "folder" },
    { path: paths.learnings, kind: "folder" },
    { path: paths.rules, kind: "folder" },
    { path: paths.store, kind: "folder" },
    { path: paths.queue, kind: "folder" },
    { path: paths.reports, kind: "folder" },
    {
      path: paths.preferences,
      kind: "file",
      content: heading("Preferences", "_Nothing recorded yet._"),
    },
    {
      path: paths.openLoops,
      kind: "file",
      content: heading("Open loops", "_Nothing tracked yet._"),
    },
    {
      path: paths.sessionLog,
      kind: "file",
      content: "# Session log\n",
    },
    {
      path: paths.knownFalse,
      kind: "file",
      content: heading(
        "Known false",
        "_Corrections and debunked assumptions go here — dream-pass proposals matching these patterns are culled before they reach you._"
      ),
    },
    {
      path: paths.tasks,
      kind: "file",
      content: heading("Tasks", "_Nothing tracked yet._"),
    },
    {
      path: paths.vaultContext,
      kind: "file",
      content: heading("Vault context", "_Nothing recorded yet — Exo will keep this current as you work._"),
    },
  ];
}

/** The parent directory of a scaffold path, or null if the path has no
 *  slash (top-level). Every `kind: "file"` item is nested, so this always
 *  resolves for them — `runVaultSetup` uses it to ensure the parent folder
 *  exists before creating the file, since `vault.create()` (unlike
 *  `vault.createFolder()`) does not create intermediate directories. */
export function parentFolder(path: string): string | null {
  const i = path.lastIndexOf("/");
  return i === -1 ? null : path.slice(0, i);
}

/** True when the vault already has Exo's memory layer set up — detected via the
 *  vault-context file (also the natural first file to scaffold). `exists` is
 *  injected so this stays pure and testable without an Obsidian App. */
export function isVaultSetUp(exists: (path: string) => boolean, paths: ExoPaths): boolean {
  return exists(paths.vaultContext);
}
