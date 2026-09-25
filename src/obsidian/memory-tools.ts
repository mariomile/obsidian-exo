import type { App } from "obsidian";
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { MemoryCaps } from "../core/memory-caps";
import { formatRecentChats } from "../core/recent-chats";
import { ok, err, getExo } from "./tool-kit";
import type { AnyTool } from "./sdk-tool";

/**
 * The memory tools that read Exo's own state rather than a vault note:
 * `recent_chats` (the conversation store) and `undo_memory_write` (revert a
 * memory harvest). Both reach the plugin through `getExo`, like the automation
 * tools, so they work the same from chat, the Codex bridge and headless runs.
 */

/** Read-only memory tool names, auto-allowed without a permission card. */
export const MEMORY_READ_TOOLS = ["mcp__obsidian__recent_chats"];

export function buildMemoryTools(app: App, caps: MemoryCaps): AnyTool[] {
  const recentChats = tool(
    "recent_chats",
    "Read your own recent conversations with the user (current and archived chats): per chat the title, date, what the user wrote, your final answer and the notes you produced. Use it when the user asks what you discussed, decided or produced recently.",
    {
      days: z.number().optional().describe("Window in days, default 7."),
      max_chars: z.number().optional().describe("Output cap, default 30000."),
    },
    async (args) => {
      const exo = getExo(app);
      if (!exo) return err("Exo isn't loaded.");
      const days = Math.min(Math.max(args.days ?? 7, 1), 365);
      const maxChars = Math.min(Math.max(args.max_chars ?? 30_000, 1000), 100_000);
      const chats = await exo.readConversationStore();
      return ok(formatRecentChats(chats, { days, maxChars, now: Date.now() }));
    }
  );

  const undoMemoryWrite = tool(
    "undo_memory_write",
    "Undo a memory harvest: the lines Exo wrote into notes by itself after a chat. Reverts the latest harvest by default, or the one whose commit sha you pass. Refuses when a touched note changed since.",
    { sha: z.string().optional().describe("Commit sha (or prefix) of the harvest to revert; omit for the latest.") },
    async (args) => {
      const exo = getExo(app);
      if (!exo) return err("Exo isn't loaded.");
      const res = await exo.undoMemoryWrite(args.sha);
      return res.ok ? ok(res.message) : err(res.message);
    }
  );

  return [
    ...(caps.chatSearch ? [recentChats] : []),
    ...(caps.undo ? [undoMemoryWrite] : []),
  ];
}
