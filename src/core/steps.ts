/**
 * Steps-timeline membership (pure). Generic work (tool calls + thinking) folds
 * into the chronological "N steps" timeline. Note-touching calls (filePath
 * non-null) join the timeline too — their live row dissolves into the
 * touched-notes footer at turn end WITHOUT breaking the run, so a stretch of
 * work like Skill → read_note → search_vault folds as one run, not three.
 * Surfaces with their own live meaning stay flat and break the run:
 *   - background Bash + BashOutput/KillShell — their badge is live status
 * Interactive cards (permission/ask/plan/todos) never reach this decision;
 * their render paths close the run directly.
 */
import { WRITE_TOOLS } from "./touched";
import { toolFilePath } from "../ui/tools";

export type StepPlacement = "timeline" | "flat";

export function stepPlacement(name: string, input: unknown): StepPlacement {
  if (name === "BashOutput" || name === "KillShell") return "flat";
  if (name === "Bash") {
    const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    if (i.run_in_background === true) return "flat";
  }
  return "timeline";
}

/** Fold-header label: "1 step" / "N steps" (no minimum threshold — 1 folds too). */
export function stepsLabel(n: number): string {
  return n === 1 ? "1 step" : `${n} steps`;
}

/** Dedup key for "files edited" — the path a write tool touches (matched by
 *  the codebase's `WRITE_TOOLS` write-classification, the same one the
 *  touched-notes footer uses), or null for read-only/non-file tools. Reuses
 *  `toolFilePath`'s per-tool path-key mapping so SDK tools (file_path/
 *  notebook_path) and native mcp__obsidian__* tools (target/path) are both
 *  covered without duplicating that mapping here. `toolFilePath` coerces
 *  non-string values (e.g. `String(5)`) since it only feeds display code, so
 *  we re-validate against the raw input here rather than trust its return —
 *  a non-string file_path/target must still resolve to null. */
export function fileEditKey(name: string, input: unknown): string | null {
  if (!WRITE_TOOLS.test(name)) return null;
  const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const raw = name === "NotebookEdit" ? i.notebook_path : name.startsWith("mcp__obsidian__") ? i.target ?? i.path : i.file_path;
  if (typeof raw !== "string" || !raw) return null;
  return toolFilePath(name, input) ?? null;
}

/** Whether a tool call counts toward the "commands" tally. */
export function isCommandTool(name: string): boolean {
  return name === "Bash";
}

/** Turn-summary label: "N tools · M files edited · K commands" — any clause
 *  whose count is 0 is omitted (a turn with no Bash calls doesn't show
 *  "0 commands"). Tool count is always shown, even at 1. */
export function summarizeSteps(tools: number, files: number, commands: number): string {
  const parts = [`${tools} tool${tools === 1 ? "" : "s"}`];
  if (files) parts.push(`${files} file${files === 1 ? "" : "s"} edited`);
  if (commands) parts.push(`${commands} command${commands === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
