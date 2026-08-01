import { Notice } from "obsidian";
import { homedir } from "os";
import { scanSkillDirs, assignSkillState, type DiscoveryItem } from "../../core/connections-scan";
import { importSkill, removeSkill } from "../../core/connections-install";
import {
  gatherFromScopes,
  gatherFromVault,
  gatherOtherProjectSkills,
  gatherCodexSkills,
} from "../../core/capability-scan";
import { skillSections } from "../../core/hub-sections";
import { reconcileList, type CardModel } from "../keyed-reconcile";
import { buildGroupHeader, buildRowScaffold, type HubTabContext } from "./shared";

/**
 * The Skills tab — vault-installed skills first (removable), then importable
 * skills from other projects / Codex grouped by origin, then a single collapsed
 * count for the hundreds already available globally (not 281 rows).
 */

export async function gatherSkills(ctx: HubTabContext): Promise<DiscoveryItem[]> {
  const home = homedir();
  const caps = ctx.plugin.lastSessionCaps;
  const projectRoots = [`${home}/Dev Projects`, `${home}/Projects`];
  const dirs = [...await gatherOtherProjectSkills(projectRoots), await gatherCodexSkills()];
  const skillItems = scanSkillDirs(dirs);
  // "Already have" = the live session's loaded skills UNION the on-disk global
  // catalog. Union, not `??`: caps is authoritative when present but null
  // pre-init and on Codex; the disk scan (symlink-aware) covers that gap so a
  // skill Exo already has is never offered as importable.
  const haveNames = new Set<string>([
    ...(caps?.skills ?? []),
    ...(await gatherFromScopes("skills")).map((s) => s.name),
  ]);
  const vaultNames = new Set<string>((await gatherFromVault(ctx.app, "skills")).map((s) => s.name));
  return assignSkillState(skillItems, haveNames, vaultNames);
}

export async function renderSkillsTab(host: HTMLElement, ctx: HubTabContext): Promise<void> {
  const skills = await gatherSkills(ctx);
  const { vault, groups, haveCount } = skillSections(skills);

  const models: CardModel[] = [];
  if (!vault.length && !groups.length) {
    const text = haveCount
      ? `No external skills to import — ${haveCount} already in Exo.`
      : "No external skills to import.";
    models.push({ key: "skills-empty", sig: text, build: () => createDiv({ cls: "mva-conn-empty", text }) });
    reconcileList(host, models);
    return;
  }

  for (const it of vault) models.push({ key: `skill:${it.name}`, sig: "active", build: () => buildSkillRow(it, ctx) });
  for (const group of groups) {
    models.push({ key: `hdr:${group.origin}`, sig: `${group.items.length}`, build: () => buildGroupHeader(group.origin, group.items.length) });
    for (const it of group.items) models.push({ key: `skill:${it.name}`, sig: "importable", build: () => buildSkillRow(it, ctx) });
  }
  if (haveCount) {
    models.push({ key: "have-summary", sig: `${haveCount}`, build: () => {
      const s = createDiv({ cls: "mva-conn-have-summary" });
      s.setText(`${haveCount} skills already in Exo — not shown`);
      return s;
    } });
  }
  reconcileList(host, models);
}

function buildSkillRow(it: DiscoveryItem, ctx: HubTabContext): HTMLElement {
  const { row, right } = buildRowScaffold(it.name, it.origin, it.desc);
  row.toggleClass("is-muted", it.state === "have");

  if (it.state === "active") {
    right.createSpan({ cls: "mva-conn-state", text: "in vault" });
    const btn = right.createEl("button", { cls: "mva-btn", text: "Remove" });
    btn.onclick = () => void doRemoveSkill(ctx, it, btn);
  } else if (it.state === "have") {
    right.createSpan({ cls: "mva-conn-state is-muted", text: "already in Exo" });
  } else {
    const btn = right.createEl("button", { cls: "mva-btn", text: "Import" });
    btn.onclick = () => void doImport(ctx, it, btn);
  }
  return row;
}

async function doImport(ctx: HubTabContext, it: DiscoveryItem, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    const dest = `${ctx.base()}/.claude/skills/${it.name}`;
    const res = await importSkill(it.path!, dest);
    if (res === "exists") {
      if (!confirm(`A skill named "${it.name}" already exists in the vault. Overwrite it?`)) { btn.disabled = false; return; }
      await importSkill(it.path!, dest, { overwrite: true });
    }
    new Notice(`Skill "${it.name}" imported into the vault.`);
    ctx.rerender();
  } catch (e) {
    new Notice(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    btn.disabled = false;
  }
}

async function doRemoveSkill(ctx: HubTabContext, it: DiscoveryItem, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    await removeSkill(`${ctx.base()}/.claude/skills/${it.name}`);
    new Notice(`Skill "${it.name}" removed from the vault.`);
    ctx.rerender();
  } catch (e) {
    new Notice(`Removal failed: ${e instanceof Error ? e.message : String(e)}`);
    btn.disabled = false;
  }
}
