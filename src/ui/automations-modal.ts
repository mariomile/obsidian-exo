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
import { App, Modal, Notice, TFile, setIcon } from "obsidian";
import type ExoPlugin from "../main";
import { clickable } from "./dom";
import { openablePopover } from "./popover";
import { NoteDiffModal } from "./note-diff";
import { basename as noteBasename } from "../obsidian/graph";
import {
  automationLastRunKey,
  cadenceLabel,
  nextDueAt,
  type AutomationConfig,
  type AutomationRunRecord,
  type Cadence,
} from "../core/automations";
import {
  dailyPulseNeedsReview,
  isDailyPulseAutomation,
  type DailyPulseReviewState,
} from "../core/daily-pulse";
import { formatAge } from "../core/actions-hub";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtIn(ms: number): string {
  if (ms <= 60_000) return "due now";
  const HOUR = 3_600_000;
  if (ms < HOUR) return `in ${Math.floor(ms / 60_000)}m`;
  if (ms < 24 * HOUR) return `in ${Math.floor(ms / HOUR)}h`;
  return `in ${Math.floor(ms / (24 * HOUR))}d`;
}

function dailyPulseMetaLabel(state: DailyPulseReviewState): string {
  if (state.status === "error") return "retry available";
  if (dailyPulseNeedsReview(state)) {
    return `${state.itemCount} item${state.itemCount === 1 ? "" : "s"} to review`;
  }
  return state.lastSuccessAt > 0 ? "reviewed" : "not generated";
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
      text: `Playbooks that run unattended on a schedule. Read-only runs report to ${this.plugin.paths.reports}/; write runs may also edit notes — every touched file is snapshotted and the whole run can be restored below.`,
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
    if (isDailyPulseAutomation(a)) {
      this.renderDailyPulseRow(list, a, idx);
      return;
    }
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

    this.renderCadenceChip(head, a);

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
    this.renderEnabledChip(head, row, a);

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

    this.renderRemoveControl(head, idx);

    row.createDiv({ cls: "mva-auto-meta" });
    this.refreshMeta(row, a);
    if (!known) row.createDiv({ cls: "mva-auto-warn", text: "Playbook not found — pick an existing prompt." });
  }

  private renderCadenceChip(head: HTMLElement, a: AutomationConfig): void {
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
  }

  private renderDailyPulseRow(list: HTMLElement, a: AutomationConfig, idx: number): void {
    const row = list.createDiv({ cls: "mva-auto-row mva-auto-pulse" });
    const head = row.createDiv({ cls: "mva-auto-head" });
    head.createDiv({ cls: "mva-sel-chip", text: "Daily Pulse" });
    this.renderCadenceChip(head, a);

    this.renderEnabledChip(head, row, a);

    head.createDiv({ cls: "mva-auto-spacer" });
    const open = head.createEl("button", { cls: "mva-btn", text: "Open" });
    open.onclick = () => void this.plugin.openDailyPulse().then(() => this.render());

    const state = this.plugin.settings.dailyPulseReviewState;
    const retry = head.createEl("button", {
      cls: "mva-btn",
      text: state.retryable ? "Retry" : "Refresh now",
    });
    retry.onclick = () => {
      retry.setAttr("disabled", "true");
      void this.plugin.runDailyPulseNow().then((ok) => {
        if (!ok) new Notice("Daily Pulse could not be refreshed. You can retry.");
        this.render();
      });
    };

    this.renderRemoveControl(head, idx);

    row.createDiv({ cls: "mva-auto-meta" });
    this.refreshMeta(row, a);
    if (state.status === "error") {
      row.createDiv({
        cls: "mva-auto-warn",
        text: state.lastError || "Daily Pulse could not be refreshed. You can retry.",
      });
    } else if (state.warnings.length > 0) {
      row.createDiv({
        cls: "mva-auto-warn",
        text: `${state.warnings.length} source${state.warnings.length === 1 ? "" : "s"} unavailable; the rest of the pulse is ready.`,
      });
    }
  }

  private refreshMeta(row: HTMLElement, a: AutomationConfig): void {
    const meta = row.querySelector<HTMLElement>(".mva-auto-meta");
    if (!meta) return;
    const now = Date.now();
    const last = this.plugin.settings.scheduledLastRun[automationLastRunKey(a)] ?? 0;
    const parts = [`last ${formatAge(last || null, now, "never")}`];
    if (a.enabled) parts.push(`next ${fmtIn(nextDueAt(a.cadence, last, now) - now)}`);
    if (isDailyPulseAutomation(a)) {
      const state = this.plugin.settings.dailyPulseReviewState;
      parts.push(dailyPulseMetaLabel(state));
    }
    meta.setText(parts.join(" · "));
  }

  private hourOf(c: Cadence): number {
    return c.kind === "hourly" ? 7 : c.hour;
  }

  private renderEnabledChip(
    head: HTMLElement,
    row: HTMLElement,
    automation: AutomationConfig
  ): void {
    const chip = head.createDiv({
      cls: "mva-sel-chip mva-auto-toggle",
      attr: { "aria-label": "Enabled" },
    });
    const sync = () => {
      chip.setText(automation.enabled ? "on" : "paused");
      chip.toggleClass("is-off", !automation.enabled);
    };
    sync();
    clickable(chip, () => {
      automation.enabled = !automation.enabled;
      this.save();
      sync();
      this.refreshMeta(row, automation);
    });
  }

  private renderRemoveControl(head: HTMLElement, index: number): void {
    const control = head.createSpan({
      cls: "mva-auto-x",
      attr: { "aria-label": "Remove automation" },
    });
    setIcon(control, "x");
    clickable(control, () => {
      this.plugin.settings.automations.splice(index, 1);
      this.save();
      this.render();
    });
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
    const wrap = host.createDiv();
    const row = wrap.createDiv({ cls: "mva-auto-runrow" });
    const when = new Date(r.startedAt);
    const stamp = `${String(when.getDate()).padStart(2, "0")}/${String(when.getMonth() + 1).padStart(2, "0")} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
    const state = r.restoredAt ? " · restored" : r.reviewedAt ? " · reviewed" : "";
    const label = row.createSpan({
      cls: "mva-auto-runlabel",
      text: `${stamp} · ${r.name} · ${r.writes.length} note${r.writes.length === 1 ? "" : "s"}${r.ok ? "" : " · failed"}${state}`,
    });
    row.createDiv({ cls: "mva-auto-spacer" });

    // The label toggles a per-file list (diff + open) for the run's writes.
    if (r.writes.length) {
      label.addClass("is-openable");
      let filesEl: HTMLElement | null = null;
      clickable(label, () => {
        if (filesEl) {
          filesEl.remove();
          filesEl = null;
          return;
        }
        filesEl = wrap.createDiv({ cls: "mva-auto-runfiles" });
        for (const path of r.writes) {
          const f = filesEl.createDiv({ cls: "mva-auto-runfile" });
          const name = f.createSpan({ cls: "mva-auto-runlabel", text: noteBasename(path) });
          clickable(name, () => {
            void this.app.workspace.openLinkText(path, "", "tab");
            this.close();
          });
          f.createDiv({ cls: "mva-auto-spacer" });
          const entry = r.checkpoint.find(([p]) => p === path);
          const diff = f.createEl("button", { cls: "mva-btn", text: entry ? "Diff" : "No snapshot" });
          if (entry) {
            diff.onclick = () => void this.showDiff(path, entry[1]);
          } else diff.setAttr("disabled", "true");
        }
      });
    }

    if (!r.reviewedAt && !r.restoredAt && r.writes.length) {
      const reviewed = row.createEl("button", { cls: "mva-btn", text: "Reviewed" });
      reviewed.onclick = () => {
        reviewed.setAttr("disabled", "true");
        void this.plugin.markAutomationRunReviewed(r.id).finally(() => void this.renderRuns());
      };
    }

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

  /** Pre-run snapshot vs current content, in the shared NoteDiffModal. */
  private async showDiff(path: string, before: string | null): Promise<void> {
    let after = "";
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      try {
        after = await this.app.vault.read(f);
      } catch {
        /* unreadable — show as empty */
      }
    }
    new NoteDiffModal(this.app, noteBasename(path), before, after, () => {
      void this.app.workspace.openLinkText(path, "", "tab");
      this.close();
    }).open();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
