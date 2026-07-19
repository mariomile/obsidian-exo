/**
 * Vault Setup — pure logic (no Obsidian imports).
 *
 * Exo reads and writes a fixed set of paths under `_system/` for its memory
 * features (open loops, task board, preferences, cockpit staleness, dream
 * pass). On a fresh vault none of that exists, so every one of those
 * features silently degrades to empty/inert with no signal to the user that
 * anything is missing. `SCAFFOLD_ITEMS` is the create-only-if-absent list
 * that fixes that; `isVaultSetUp` is the single-file detection check used to
 * decide whether to offer the scaffold at all.
 *
 * Deliberately excluded (see the implementation plan's Global Constraints
 * for why): `_system/agent/{now,human,persona}.md` (owned by the "Agent Is
 * the Folder" LLM seeder — pre-creating blanks would make it think they're
 * already seeded) and `_system/review.md` (its mere existence is read as a
 * UI signal that there's something to review).
 */

export type ScaffoldKind = "folder" | "file";

export interface ScaffoldItem {
  path: string;
  kind: ScaffoldKind;
  /** Starter content for `kind: "file"`. Always absent for `kind: "folder"`. */
  content?: string;
}

/** Detection sentinel: absence means "this vault has never had Exo's memory
 *  layer set up." Also the natural first file to scaffold. */
export const VAULT_CONTEXT_PATH = "_system/vault-context.md";

const heading = (title: string, body: string): string => `# ${title}\n\n${body}\n`;

export const SCAFFOLD_ITEMS: readonly ScaffoldItem[] = [
  { path: "_system/memory/decisions", kind: "folder" },
  { path: "_system/memory/learnings", kind: "folder" },
  { path: "_system/memory/rules", kind: "folder" },
  { path: "_system/memory/store", kind: "folder" },
  { path: "_system/exo-queue", kind: "folder" },
  { path: "_system/reports", kind: "folder" },
  {
    path: "_system/memory/preferences/preferences.md",
    kind: "file",
    content: heading("Preferences", "_Nothing recorded yet._"),
  },
  {
    path: "_system/memory/open-loops.md",
    kind: "file",
    content: heading("Open loops", "_Nothing tracked yet._"),
  },
  {
    path: "_system/memory/session-log.md",
    kind: "file",
    content: "# Session log\n",
  },
  {
    path: "_system/memory/known-false.md",
    kind: "file",
    content: heading(
      "Known false",
      "_Corrections and debunked assumptions go here — dream-pass proposals matching these patterns are culled before they reach you._"
    ),
  },
  {
    path: "_system/orchestration/tasks.md",
    kind: "file",
    content: heading("Tasks", "_Nothing tracked yet._"),
  },
  {
    path: VAULT_CONTEXT_PATH,
    kind: "file",
    content: heading("Vault context", "_Nothing recorded yet — Exo will keep this current as you work._"),
  },
] as const;

/** True when the vault already has Exo's memory layer set up. `exists` is
 *  injected so this stays pure and testable without an Obsidian App. */
export function isVaultSetUp(exists: (path: string) => boolean): boolean {
  return exists(VAULT_CONTEXT_PATH);
}
