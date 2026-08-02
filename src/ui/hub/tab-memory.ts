import { memoryStats, memoryActions } from "../../core/actions-hub";
import { gatherStoreEntries, gatherLoops } from "../../core/capability-scan";
import { monthFileName } from "../../core/memory-store";
import { exoPaths } from "../../core/paths";
import { buildGroupHeader, buildStatusRow, buildRowScaffold, openNote, runCommand, type HubTabContext } from "./shared";

/**
 * Memory tab — the dream/loops/store machinery in one place: live stats,
 * one-click actions (every action row maps to an existing command or file
 * open — no new capability), and the vault-memory files.
 */
export async function renderMemoryTab(host: HTMLElement, ctx: HubTabContext): Promise<void> {
  host.empty();
  const s = ctx.plugin.settings;
  const paths = exoPaths(s.memoryRoot);
  const now = Date.now();

  const [storeEntries, loops, reviewExists, snapshotPresent] = await Promise.all([
    gatherStoreEntries(ctx.app, paths.store),
    gatherLoops(ctx.app, paths.openLoops),
    ctx.app.vault.adapter.exists(paths.review).catch(() => false),
    ctx.plugin.loadDreamSnapshot().then((snap) => !!snap).catch(() => false),
  ]);

  // Stats
  host.appendChild(buildGroupHeader("Memory", storeEntries.length));
  for (const stat of memoryStats({
    storeEntries,
    loops,
    ledger: s.backgroundBudgetLedger,
    dailyBudget: s.backgroundDailyTokenBudget,
    lastDreamPass: s.lastDreamPass,
    now,
  })) {
    host.appendChild(buildStatusRow(stat.label, stat.value));
  }

  // Actions — Run for commands, Open for files.
  const openTargets: Record<string, string> = {
    "open-store": `${paths.store}/${monthFileName(now)}`,
    "open-loops": paths.openLoops,
    "open-review": paths.review,
  };
  const commands: Record<string, string> = {
    "dream-run": "exo:memory-dream-pass",
    "dream-undo": "exo:memory-dream-undo",
  };
  host.appendChild(buildGroupHeader("Actions"));
  for (const a of memoryActions({ snapshotPresent, reviewExists, loops, now, dreamLlmEnabled: s.dreamLlmEnabled })) {
    const { row, right } = buildRowScaffold(a.label, undefined, a.hint);
    const isOpen = a.id in openTargets;
    const btn = right.createEl("button", { cls: "mva-btn", text: isOpen ? "Open" : a.badge ? `Run · ${a.badge}` : "Run" });
    if (!a.enabled) btn.setAttr("disabled", "true");
    else if (isOpen) btn.onclick = () => openNote(ctx, openTargets[a.id]);
    else btn.onclick = () => runCommand(ctx, commands[a.id]);
    host.appendChild(row);
  }

  // Vault memory files
  host.appendChild(buildGroupHeader("Vault memory"));
  host.appendChild(buildStatusRow("Read at boot", s.memoryReadEnabled ? "on" : "off", s.memoryReadEnabled));
  host.appendChild(buildStatusRow("Write (gated)", s.memoryWriteEnabled ? "on" : "off", s.memoryWriteEnabled));
  const files: [string, string][] = [
    ["vault-context.md", paths.vaultContext],
    ["preferences.md", paths.preferences],
    ["session-log.md", paths.sessionLog],
  ];
  for (const [label, path] of files) {
    const { row, right } = buildRowScaffold(label, undefined, undefined);
    const btn = right.createEl("button", { cls: "mva-btn", text: "Open" });
    btn.onclick = () => openNote(ctx, path);
    host.appendChild(row);
  }
}
