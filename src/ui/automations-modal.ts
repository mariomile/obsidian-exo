/**
 * Automations manager — the single surface for scheduled playbook runs
 * (settings button, Cockpit Autonomy tile, command palette).
 *
 * Design language: the canonical form recipe — `.mva-pv-label` quiet labels,
 * chip + `.mva-sel-pop` popovers (never a native <select>), `.mva-btn` buttons.
 * Rows edit `plugin.settings.automations` in place and save on every change;
 * there is no draft state to lose. The "Recent write runs" section lists
 * restorable run records (plugin sidecar) with a two-step Restore.
 */
import { App, Modal, Notice, setIcon } from "obsidian";
import type ExoPlugin from "../main";
import { clickable } from "./dom";
import { openablePopover } from "./popover";
import {
  cadenceLabel,
  nextDueAt,
  type AutomationConfig,
  type AutomationRunRecord,
  type Cadence,
} from "../core/automations";
import { formatAge } from "../core/actions-hub";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtIn(ms: number): string {
  if (ms <= 60_000) return "due now";
  const HOUR = 3_600_000;
  if (ms < HOUR) return `in ${Math.floor(ms / 60_000)}m`;
  if (ms < 24 * HOUR) return `in ${Math.floor(ms / HOUR)}h`;
  return `in ${Math.floor(ms / (24 * HOUR))}d`;
}

export class AutomationsModal extends Modal {
  private runsEl: HTMLElement | null = null;

  constructor(
    app: App,
    private plugin: ExoPlugin
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("mva-auto-modal");
    this.render();
  }

  private save(): void {
    void this.plugin.saveSettings();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Automations" });
    contentEl.createDiv({
      cls: "mva-auto-sub",
      text: "Playbooks that run unattended on a schedule. Read-only runs report to _system/reports/; write runs may also edit notes — every touched file is snapshotted and the whole run can be restored below.",
    });

    const list = contentEl.createDiv({ cls: "mva-auto-list" });
    const autos = this.plugin.settings.automations;
    if (!autos.length) list.createDiv({ cls: "mva-auto-empty", text: "No automations yet." });
    autos.forEach((a, i) => this.renderRow(list, a, i));

    const foot = contentEl.createDiv({ cls: "mva-auto-foot" });
    const add = foot.createEl("button", { cls: "mva-btn", text: "Add automation" });
    add.onclick = () => {
      const prompts = this.plugin.settings.customPrompts;
      if (!prompts.length) {
        new Notice("No playbooks yet — add a custom prompt in Exo settings first.");
        return;
      }
      autos.push({ name: prompts[0].name, cadence: { kind: "daily", hour: 7 }, enabled: true, write: false });
      this.save();
      this.render();
    };

    this.runsEl = contentEl.createDiv({ cls: "mva-auto-runs" });
    void this.renderRuns();
  }

  /* ------------------------------ one row ------------------------------ */

  private renderRow(list: HTMLElement, a: AutomationConfig, idx: number): void {
    const row = list.createDiv({ cls: "mva-auto-row" });
    const head = row.createDiv({ cls: "mva-auto-head" });

    // Playbook picker chip.
    const prompts = this.plugin.settings.customPrompts;
    const known = prompts.some((p) => p.name.toLowerCase() === a.name.toLowerCase());
    this.chipSelect(head, a.name + (known ? "" : " ⚠"), "Playbook", (pop, close) =>
      this.optionRows(
        pop,
        prompts.map((p) => ({ value: p.name, label: p.name })),
        a.name,
        (v) => {
          a.name = v;
          this.save();
          close();
          this.render();
        }
      )
    );

    // Cadence chip: kind rows + hour / weekday editors in one popover.
    this.chipSelect(head, cadenceLabel(a.cadence), "Cadence", (pop, close) => {
      this.optionRows(
        pop,
        [
          { value: "hourly", label: "hourly" },
          { value: "daily", label: "daily" },
          { value: "weekly", label: "weekly" },
        ],
        a.cadence.kind,
        (v) => {
          a.cadence =
            v === "hourly"
              ? { kind: "hourly" }
              : v === "daily"
                ? { kind: "daily", hour: this.hourOf(a.cadence) }
                : { kind: "weekly", day: 1, hour: this.hourOf(a.cadence) };
          this.save();
          close();
          this.render();
        }
      );
      if (a.cadence.kind !== "hourly") {
        const hourRow = pop.createDiv({ cls: "mva-auto-popfield" });
        hourRow.createSpan({ cls: "mva-pv-label", text: "At hour" });
        const hour = hourRow.createEl("input", {
          cls: "mva-pv-input mva-auto-hour",
          attr: { type: "number", min: "0", max: "23" },
        });
        hour.value = String(this.hourOf(a.cadence));
        hour.onchange = () => {
          const h = Math.min(23, Math.max(0, Number(hour.value) || 0));
          if (a.cadence.kind !== "hourly") a.cadence.hour = h;
          this.save();
          this.render();
        };
      }
      if (a.cadence.kind === "weekly") {
        const dayRow = pop.createDiv({ cls: "mva-auto-popfield" });
        dayRow.createSpan({ cls: "mva-pv-label", text: "On" });
        this.optionRows(
          dayRow,
          DAY_LABELS.map((d, i) => ({ value: String(i), label: d })),
          String(a.cadence.day),
          (v) => {
            if (a.cadence.kind === "weekly") a.cadence.day = Number(v);
            this.save();
            close();
            this.render();
          }
        );
      }
    });

    // Write-mode chip (is-caution when writes are on — it's the potent state).
    const writeChip = head.createDiv({ cls: "mva-sel-chip mva-auto-toggle", attr: { "aria-label": "Write mode" } });
    const syncWrite = () => {
      writeChip.setText(a.write ? "writes" : "read-only");
      writeChip.toggleClass("is-caution", a.write);
    };
    syncWrite();
    clickable(writeChip, () => {
      a.write = !a.write;
      this.save();
      syncWrite();
      this.refreshMeta(row, a);
    });

    // Enabled chip.
    const onChip = head.createDiv({ cls: "mva-sel-chip mva-auto-toggle", attr: { "aria-label": "Enabled" } });
    const syncOn = () => {
      onChip.setText(a.enabled ? "on" : "paused");
      onChip.toggleClass("is-off", !a.enabled);
    };
    syncOn();
    clickable(onChip, () => {
      a.enabled = !a.enabled;
      this.save();
      syncOn();
      this.refreshMeta(row, a);
    });

    head.createDiv({ cls: "mva-auto-spacer" });

    const run = head.createEl("button", { cls: "mva-btn", text: "Run now" });
    run.onclick = () => {
      const p = prompts.find((x) => x.name.toLowerCase() === a.name.toLowerCase());
      if (!p) {
        new Notice(`No playbook named "${a.name}".`);
        return;
      }
      run.setAttr("disabled", "true");
      void this.plugin
        .runPlaybook(p.name, p.prompt, { write: a.write })
        .then((ok) => {
          if (ok) {
            this.plugin.settings.scheduledLastRun[p.name] = Date.now();
            this.save();
          }
        })
        .finally(() => {
          run.removeAttribute("disabled");
          this.refreshMeta(row, a);
          void this.renderRuns();
        });
    };

    const del = head.createSpan({ cls: "mva-auto-x", attr: { "aria-label": "Remove automation" } });
    setIcon(del, "x");
    clickable(del, () => {
      this.plugin.settings.automations.splice(idx, 1);
      this.save();
      this.render();
    });

    row.createDiv({ cls: "mva-auto-meta" });
    this.refreshMeta(row, a);
    if (!known) row.createDiv({ cls: "mva-auto-warn", text: "Playbook not found — pick an existing prompt." });
  }

  private refreshMeta(row: HTMLElement, a: AutomationConfig): void {
    const meta = row.querySelector<HTMLElement>(".mva-auto-meta");
    if (!meta) return;
    const now = Date.now();
    const last = this.plugin.settings.scheduledLastRun[a.name] ?? 0;
    const parts = [`last ${formatAge(last || null, now, "never")}`];
    if (a.enabled) parts.push(`next ${fmtIn(nextDueAt(a.cadence, last, now) - now)}`);
    meta.setText(parts.join(" · "));
  }

  private hourOf(c: Cadence): number {
    return c.kind === "hourly" ? 7 : c.hour;
  }

  /* --------------------------- chip + popover --------------------------- */

  private chipSelect(
    parent: HTMLElement,
    label: string,
    aria: string,
    fill: (pop: HTMLElement, close: () => void) => void
  ): void {
    const wrap = parent.createDiv({ cls: "mva-sel" });
    const chip = wrap.createDiv({ cls: "mva-sel-chip", attr: { "aria-label": aria } });
    chip.setText(label);
    const pop = wrap.createDiv({ cls: "mva-sel-pop" });
    pop.hide();
    const popover = openablePopover({
      anchor: chip,
      pop,
      wrap,
      onOpen: () => {
        pop.empty();
        fill(pop, () => popover.close());
      },
      focus: () => pop.querySelector<HTMLElement>(".mva-sel-opt")?.focus(),
    });
    clickable(chip, (e) => {
      e.stopPropagation();
      popover.toggle();
    });
  }

  private optionRows(
    pop: HTMLElement,
    options: { value: string; label: string }[],
    selected: string,
    onPick: (v: string) => void
  ): void {
    for (const o of options) {
      const opt = pop.createDiv({ cls: "mva-sel-opt", attr: { tabindex: "0" } });
      const dot = opt.createSpan({ cls: "mva-sel-opt-dot" });
      if (o.value === selected) setIcon(dot, "check");
      opt.createSpan({ text: o.label });
      clickable(opt, () => onPick(o.value));
    }
  }

  /* ------------------------------ run log ------------------------------ */

  private async renderRuns(): Promise<void> {
    const host = this.runsEl;
    if (!host) return;
    host.empty();
    const runs = await this.plugin.loadAutomationRuns();
    if (!runs.length) return;
    host.createDiv({ cls: "mva-pv-label", text: "Recent write runs" });
    for (const r of runs.slice(0, 8)) this.renderRunRow(host, r);
  }

  private renderRunRow(host: HTMLElement, r: AutomationRunRecord): void {
    const row = host.createDiv({ cls: "mva-auto-runrow" });
    const when = new Date(r.startedAt);
    const stamp = `${String(when.getDate()).padStart(2, "0")}/${String(when.getMonth() + 1).padStart(2, "0")} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
    row.createSpan({
      cls: "mva-auto-runlabel",
      text: `${stamp} · ${r.name} · ${r.writes.length} note${r.writes.length === 1 ? "" : "s"}${r.ok ? "" : " · failed"}${r.restoredAt ? " · restored" : ""}`,
    });
    row.createDiv({ cls: "mva-auto-spacer" });
    const report = row.createEl("button", { cls: "mva-btn", text: "Report" });
    report.onclick = () => {
      void this.app.workspace.openLinkText(r.reportPath, "", "tab");
      this.close();
    };
    if (r.checkpoint.length && !r.restoredAt) {
      const restore = row.createEl("button", { cls: "mva-btn", text: "Restore" });
      let armed = false;
      restore.onclick = () => {
        if (!armed) {
          armed = true;
          restore.setText("Sure?");
          restore.addClass("mod-warning");
          window.setTimeout(() => {
            armed = false;
            restore.setText("Restore");
            restore.removeClass("mod-warning");
          }, 4000);
          return;
        }
        restore.setAttr("disabled", "true");
        void this.plugin.restoreAutomationRun(r.id).finally(() => void this.renderRuns());
      };
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
