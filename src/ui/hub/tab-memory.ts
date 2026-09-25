import { Notice } from "obsidian";
import { memoryStats, memoryActions, formatAge } from "../../core/actions-hub";
import { gatherLoops } from "../../core/capability-scan";
import { localDate } from "../../core/recent-chats";
import { exoPaths } from "../../core/paths";
import { buildGroupHeader, buildStatusRow, buildRowScaffold, openNote, type HubTabContext } from "./shared";

/** Harvests listed in the digest. */
const DIGEST_ROWS = 10;

/**
 * Memory tab: automatic memory at a glance (stats), one-click actions, the
 * digest of recent memory writes with a per-harvest Undo, and the vault-memory
 * files. Every action maps to an existing command, file open or plugin method.
 */
export async function renderMemoryTab(host: HTMLElement, ctx: HubTabContext): Promise<void> {
  host.empty();
  const s = ctx.plugin.settings;
  const paths = exoPaths(s.memoryRoot);
  const now = Date.now();
  const inboxPath = `${paths.inbox}/${localDate(now)}.md`;

  const [harvests, loops, reviewExists, inboxExists] = await Promise.all([
    ctx.plugin.harvestLog.list(),
    gatherLoops(ctx.app, paths.openLoops),
    ctx.app.vault.adapter.exists(paths.review).catch(() => false),
    ctx.app.vault.adapter.exists(inboxPath).catch(() => false),
  ]);
  const caps = ctx.plugin.memoryCaps();

  // Stats
  host.appendChild(buildGroupHeader("Memory"));
  for (const stat of memoryStats({
    autoMemory: caps.autoCapture,
    harvests: harvests.map((h) => ({ at: h.at, writes: h.writes.length, undone: !!h.undoneAt })),
    loops,
    ledger: s.backgroundBudgetLedger,
    dailyBudget: s.backgroundDailyTokenBudget,
    now,
  })) {
    host.appendChild(buildStatusRow(stat.label, stat.value));
  }

  // Actions
  const undo = async (target?: string): Promise<void> => {
    const result = await ctx.plugin.undoMemoryWrite(target);
    new Notice(result.message, 8000);
    ctx.rerender();
  };
  const openTargets: Record<string, string> = {
    "open-inbox": inboxPath,
    "open-loops": paths.openLoops,
    "open-review": paths.review,
  };
  host.appendChild(buildGroupHeader("Actions"));
  for (const a of memoryActions({
    canUndo: caps.undo && harvests.some((h) => !h.undoneAt),
    inboxExists,
    reviewExists,
    loops,
    now,
  })) {
    const { row, right } = buildRowScaffold(a.label, undefined, a.hint);
    const isOpen = a.id in openTargets;
    const btn = right.createEl("button", { cls: "mva-btn", text: isOpen ? "Open" : a.badge ? `Run · ${a.badge}` : "Run" });
    if (!a.enabled) btn.setAttr("disabled", "true");
    else if (isOpen) btn.onclick = () => openNote(ctx, openTargets[a.id]);
    else if (a.id === "undo-harvest") btn.onclick = () => void undo();
    host.appendChild(row);
  }

  // Digest: what automatic memory wrote, newest first.
  host.appendChild(buildGroupHeader("Recent memory writes", harvests.length));
  if (!harvests.length) {
    host.appendChild(buildStatusRow("Nothing yet", caps.autoCapture ? "writes appear after a chat goes idle" : "automatic memory is off"));
  }
  for (const h of harvests.slice(0, DIGEST_ROWS)) {
    const desc = h.writes.map((w) => `${w.op === "update" ? "~" : "+"} ${w.path}: ${w.text}`).join("\n");
    const { row, right } = buildRowScaffold(h.title || "Chat", formatAge(h.at, now, "never"), desc);
    if (h.undoneAt) {
      right.createSpan({ cls: "mva-faint", text: "undone" });
    } else {
      const btn = right.createEl("button", { cls: "mva-btn", text: "Undo" });
      if (!caps.undo) btn.setAttr("disabled", "true");
      else btn.onclick = () => void undo(h.id);
    }
    host.appendChild(row);
  }

  // Vault memory files
  host.appendChild(buildGroupHeader("Vault memory"));
  host.appendChild(buildStatusRow("Read at boot", caps.bootRead ? "on" : "off", caps.bootRead));
  host.appendChild(buildStatusRow("Write (gated)", caps.ledgerWrite ? "on" : "off", caps.ledgerWrite));
  const files: [string, string][] = [
    ["vault-context.md", paths.vaultContext],
    ["preferences.md", paths.preferences],
    ["AGENTS.md", "AGENTS.md"],
  ];
  for (const [label, path] of files) {
    const { row, right } = buildRowScaffold(label, undefined, undefined);
    const btn = right.createEl("button", { cls: "mva-btn", text: "Open" });
    btn.onclick = () => openNote(ctx, path);
    host.appendChild(row);
  }
}
