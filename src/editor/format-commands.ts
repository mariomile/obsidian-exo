/**
 * Palette commands for the in-note formatting actions. Lives here because
 * `main.ts` is at its size ceiling — a new command block does not land there.
 *
 * Comment hands off to AIditor when that plugin is installed (same seam
 * Selection Sidekick used), so there is still one "comment" affordance.
 */
import type { Editor } from "obsidian";
import type ExoPlugin from "../main";
import { COMMANDS } from "./format/registry";
import type { ToolbarCommand } from "./format/types";

function commandApi(plugin: ExoPlugin): {
  findCommand: (id: string) => unknown;
  executeCommandById: (id: string) => boolean;
} {
  return (plugin.app as unknown as {
    commands: {
      findCommand: (id: string) => unknown;
      executeCommandById: (id: string) => boolean;
    };
  }).commands;
}

export function applyFormatCommand(plugin: ExoPlugin, cmd: ToolbarCommand, editor: Editor): void {
  if (cmd.id === "comment") {
    const api = commandApi(plugin);
    if (api.findCommand("aiditor:annotate-selection")) {
      api.executeCommandById("aiditor:annotate-selection");
      return;
    }
  }
  cmd.apply(editor);
}

export function registerFormatCommands(plugin: ExoPlugin): void {
  for (const cmd of COMMANDS) {
    plugin.addCommand({
      id: `format-${cmd.id}`,
      name: `Format: ${cmd.label}`,
      editorCallback: (editor) => applyFormatCommand(plugin, cmd, editor),
    });
  }
}
