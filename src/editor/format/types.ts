import type { Editor } from "obsidian";

export type CommandGroup = "format" | "block" | "insert";

/** A single toolbar formatting action — pure data plus one mutator. */
export interface ToolbarCommand {
  /** Stable id, used in command palette ids (`format-${id}`). */
  id: string;
  /** Tooltip + aria-label. */
  label: string;
  /** Lucide icon name passed to setIcon(). */
  icon: string;
  /** Visual grouping (separators are drawn between groups). */
  group: CommandGroup;
  /** Mutates the editor selection. Self-contained and re-entrant-safe. */
  apply: (editor: Editor) => void;
  /** Optional: is the formatting already applied to the selection? Pure. */
  isActive?: (editor: Editor) => boolean;
}
