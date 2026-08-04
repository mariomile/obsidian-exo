import { Notice, setIcon } from "obsidian";
import { cadenceLabel } from "../../core/automations";
import { buildRowScaffold, openExoSettings, type HubTabContext } from "./shared";

/**
 * Playbooks tab — every custom prompt as a row: workflow badge (" >>> "
 * prompts), schedule badge when an enabled automation references it, and a
 * read-only "Run now" (the write-enabled path lives on the Automations tab).
 * Editing stays in settings — the tab deep-links there.
 */
export async function renderPlaybooksTab(host: HTMLElement, ctx: HubTabContext): Promise<void> {
  host.empty();
  const s = ctx.plugin.settings;
  const prompts = s.customPrompts ?? [];

  host.createDiv({
    cls: "mva-auto-sub",
    text: "Reusable prompts you can run by name — from here (read-only), from chat, or on a schedule via Automations.",
  });

  if (!prompts.length) {
    host.createDiv({ cls: "mva-conn-empty", text: "No playbooks yet — add custom prompts in settings." });
  }

  for (const p of prompts) {
    const isWorkflow = p.prompt.includes(" >>> ");
    const steps = isWorkflow ? p.prompt.split(/\s+>>>\s+/).filter(Boolean).length : 0;
    const desc = isWorkflow ? `workflow · ${steps} steps` : "prompt";
    const { row, right } = buildRowScaffold(p.name, undefined, desc);

    // Scheduled when an enabled automation file matches this playbook by name.
    const auto = ctx.plugin.automationStore
      .list()
      .find((a) => a.enabled && a.name.toLowerCase() === p.name.toLowerCase());
    const schedWhen = auto?.when.find((w) => w.on === "schedule");
    const sched = schedWhen?.on === "schedule" ? cadenceLabel(schedWhen.cadence) : null;
    if (sched) {
      const badge = right.createSpan({ cls: "mva-conn-state mva-hub-sched" });
      setIcon(badge.createSpan({ cls: "mva-hub-sched-icon" }), "clock");
      badge.createSpan({ text: sched });
    }

    const hasVars = /\{\{[^}]+\}\}/.test(p.prompt);
    const run = right.createEl("button", { cls: "mva-btn", text: "Run now" });
    if (hasVars) {
      run.setAttr("disabled", "true");
      run.setAttr("title", "Prompts with {{variables}} need the chat composer.");
    } else {
      run.onclick = () => {
        run.setAttr("disabled", "true");
        new Notice(`Running "${p.name}"…`);
        void ctx.plugin.runPlaybook(p.name, p.prompt).finally(() => {
          if (row.isConnected) run.removeAttribute("disabled");
        });
      };
    }
    host.appendChild(row);
  }

  const foot = host.createDiv({ cls: "mva-auto-foot" });
  const edit = foot.createEl("button", { cls: "mva-btn", text: prompts.length ? "Edit in settings" : "Add in settings" });
  edit.onclick = () => openExoSettings(ctx);
}
