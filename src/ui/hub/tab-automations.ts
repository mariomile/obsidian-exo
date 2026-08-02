/**
 * Automations tab — the single surface for scheduled playbook runs (formerly
 * the Automations modal; every entry point now deep-links here).
 *
 * Design language: the canonical form recipe — `.mva-pv-label` quiet labels,
 * chip + `.mva-sel-pop` popovers (never a native <select>), `.mva-btn` buttons.
 * Rows edit `plugin.settings.automations` in place and save on every change;
 * there is no draft state to lose. The "Recent write runs" section lists
 * restorable run records (plugin sidecar) with a two-step Restore.
 *
 * Rendering model: full re-render via ctx.rerender() (rows mutate settings in
 * place and popover chips hold transient open state — a keyed sig would have
 * to encode all of it for no gain at this list size).
 */
import { Notice, TFile, setIcon } from "obsidian";
import { clickable } from "../dom";
import { openablePopover } from "../popover";
import { NoteDiffModal } from "../note-diff";
import { basename as noteBasename } from "../../obsidian/graph";
import {
  automationLastRunKey,
  cadenceLabel,
  formatDueIn,
  nextDueAt,
  type AutomationConfig,
  type AutomationRunRecord,
  type Cadence,
} from "../../core/automations";
import { dailyPulseMetaLabel, isDailyPulseAutomation } from "../../core/daily-pulse";
import {
  formatDuration,
  parseDuration,
  primaryTrigger,
  setPrimaryTrigger,
  type AgentContract,
  type AgentTrigger,
} from "../../core/agents";
import {
  describeAgentAutomation,
  triggerClause,
  cadenceNote,
  spellDuration,
  AUTONOMY_CHOICES,
  OUTPUT_CHOICES,
  COOLDOWN_CHOICES,
} from "../../core/agent-copy";

import { formatAge } from "../../core/actions-hub";
import type { HubTabContext } from "./shared";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export async function renderAutomationsTab(host: HTMLElement, ctx: HubTabContext): Promise<void> {
  host.empty();
  host.createDiv({
    cls: "mva-auto-sub",
    text: `Playbooks that run unattended on a schedule. Read-only runs report to ${ctx.plugin.paths.reports}/; write runs may also edit notes — every touched file is snapshotted and the whole run can be restored below.`,
  });

  const list = host.createDiv({ cls: "mva-auto-list" });
  const autos = ctx.plugin.settings.automations;
  if (!autos.length) list.createDiv({ cls: "mva-auto-empty", text: "No automations yet." });
  autos.forEach((a, i) => renderRow(list, a, i, ctx));

  const foot = host.createDiv({ cls: "mva-auto-foot" });
  const add = foot.createEl("button", { cls: "mva-btn", text: "Add automation" });
  add.onclick = () => {
    const prompts = ctx.plugin.settings.customPrompts;
    if (!prompts.length) {
      new Notice("No playbooks yet — add a custom prompt in Exo settings first.");
      return;
    }
    autos.push({ name: prompts[0].name, cadence: { kind: "daily", hour: 7 }, enabled: true, write: false });
    save(ctx);
    ctx.rerender();
  };

  const agentsEl = host.createDiv({ cls: "mva-auto-agents" });
  void renderAgents(agentsEl, ctx);

  const runsEl = host.createDiv({ cls: "mva-auto-runs" });
  void renderRuns(runsEl, ctx);
}

/**
 * Agents that run unattended, listed beside the playbooks they behave like.
 *
 * An agent with a trigger IS an automation from the user's side — the only
 * difference is that its instructions live in an agent file instead of a
 * prompt. Keeping them in separate rooms means "what runs without me?" has two
 * answers, which is one too many.
 *
 * Each row leads with a sentence rather than the contract's own vocabulary:
 * `act` / `vault-event create _inbox/**` / `15m` is the right language for a
 * file and the wrong one for a row, because reading it requires knowing the
 * schema. The chips edit; the sentence explains.
 */
async function renderAgents(host: HTMLElement, ctx: HubTabContext): Promise<void> {
  host.empty();
  if (!(await ctx.plugin.agentsReady())) return;
  const agents = ctx.plugin.agentStore
    .list()
    .filter((a) => a.brain.source === "vault" || a.brain.source === "user")
    // Only genuinely unattended triggers. `note-mention` fires because a human
    // typed the agent's name — that is invocation, not automation, and listing
    // it here buried the two real automations under fifteen rows of agents that
    // never run on their own.
    .filter((a) => a.contract.triggers.some((t) => t.on !== "note-mention"));
  if (!agents.length) return;

  host.createDiv({ cls: "mva-auto-h", text: "Agents" });
  host.createDiv({ cls: "mva-auto-sub", text: "These run on their own. Switch one off and nothing happens without you." });

  for (const a of agents) {
    const row = host.createDiv({ cls: "mva-auto-row" });
    row.toggleClass("is-off", !a.contract.enabled);

    const toggle = row.createDiv({ cls: "mva-ag-toggle", attr: { role: "button", tabindex: "0" } });
    toggle.toggleClass("is-on", a.contract.enabled);
    toggle.setAttribute("aria-label", a.contract.enabled ? "Disable agent" : "Enable agent");
    clickable(toggle, () => {
      void ctx.plugin.agentStore
        .setEnabled(a.brain.slug, !a.contract.enabled, new Date().toISOString().slice(0, 10))
        .then(() => ctx.rerender());
    });

    const main = row.createDiv({ cls: "mva-auto-main" });
    main.createDiv({ cls: "mva-auto-name", text: a.brain.name });

    // The sentence comes first and carries the whole answer: what fires it,
    // what it may do, where it says so. The chips below are how you change it —
    // reading the row must not require operating it.
    main.createDiv({ cls: "mva-auto-say", text: describeAgentAutomation(a.contract) });
    main.createDiv({ cls: "mva-auto-meta", text: cadenceNote(a.contract) });

    const chips = main.createDiv({ cls: "mva-auto-chips" });
    const patch = (next: Partial<typeof a.contract>) => {
      void ctx.plugin.agentStore
        .saveContract({ ...a.contract, ...next }, new Date().toISOString().slice(0, 10))
        .then(() => ctx.rerender());
    };
    const labelOf = (list: readonly { value: string; label: string }[], v: string) =>
      list.find((c) => c.value === v)?.label ?? v;

    chipSelect(chips, labelOf(AUTONOMY_CHOICES, a.contract.autonomy), "What it may do", (pop, close) =>
      hintedRows(pop, AUTONOMY_CHOICES, a.contract.autonomy, (v) => {
        close();
        patch({ autonomy: v as typeof a.contract.autonomy });
      }),
      // Set to make changes with nothing writable is the one combination that
      // runs and does nothing — worth a warning, not a discovery.
      { warn: a.contract.autonomy === "act" && a.contract.scope.write.length === 0 }
    );

    chipSelect(chips, labelOf(OUTPUT_CHOICES, a.contract.output), "What it leaves behind", (pop, close) =>
      hintedRows(pop, OUTPUT_CHOICES, a.contract.output, (v) => {
        close();
        patch({ output: v as typeof a.contract.output });
      })
    );

    renderTriggerChip(chips, a.contract, (triggers) => patch({ triggers }));

    chipSelect(chips, `no more than every ${spellDuration(a.contract.cooldownMs)}`, "How often at most", (pop, close) =>
      optionRows(
        pop,
        COOLDOWN_CHOICES.map((v) => ({ value: v, label: `no more than every ${spellDuration(parseDuration(v)!)}` })),
        formatDuration(a.contract.cooldownMs),
        (v) => {
          close();
          patch({ cooldownMs: parseDuration(v) ?? a.contract.cooldownMs });
        }
      )
    );

    row.createDiv({ cls: "mva-auto-spacer" });

    // Parity with a playbook row: an automation you cannot trigger by hand is
    // one you cannot test without waiting for its trigger.
    const run = row.createEl("button", { cls: "mva-btn", text: "Run now" });
    run.onclick = () => {
      run.setAttr("disabled", "true");
      run.setText("Running…");
      void ctx.plugin
        .invokeAgentFromAgent(a.brain.slug, "Do your standing job.")
        .then((msg) => new Notice(msg))
        .finally(() => {
          // The pane outlives the run — the row may be gone if the user moved on.
          if (!row.isConnected) return;
          run.removeAttribute("disabled");
          run.setText("Run now");
          ctx.rerender();
        });
    };

    const open = row.createDiv({ cls: "mva-ag-action", attr: { "aria-label": "Open contract" } });
    setIcon(open, "settings-2");
    clickable(open, () => {
      void ctx.plugin.app.workspace.openLinkText(ctx.plugin.agentStore.sidecarPath(a.brain.slug), "", "tab");
    });
  }
}

function save(ctx: HubTabContext): void {
  void ctx.plugin.saveSettings();
}

/* ------------------------------ one row ------------------------------ */

function renderRow(list: HTMLElement, a: AutomationConfig, idx: number, ctx: HubTabContext): void {
  if (isDailyPulseAutomation(a)) {
    renderDailyPulseRow(list, a, idx, ctx);
    return;
  }
  const row = list.createDiv({ cls: "mva-auto-row" });
  const head = row.createDiv({ cls: "mva-auto-head" });

  // Playbook picker chip.
  const prompts = ctx.plugin.settings.customPrompts;
  const known = prompts.some((p) => p.name.toLowerCase() === a.name.toLowerCase());
  chipSelect(head, a.name, "Playbook", (pop, close) =>
    optionRows(
      pop,
      prompts.map((p) => ({ value: p.name, label: p.name })),
      a.name,
      (v) => {
        a.name = v;
        save(ctx);
        close();
        ctx.rerender();
      }
    ),
    { warn: !known }
  );

  renderCadenceChip(head, a, ctx);

  // Write-mode chip (is-caution when writes are on — it's the potent state).
  const writeChip = head.createDiv({ cls: "mva-sel-chip mva-auto-toggle", attr: { "aria-label": "Write mode" } });
  const syncWrite = () => {
    writeChip.setText(a.write ? "writes" : "read-only");
    writeChip.toggleClass("is-caution", a.write);
  };
  syncWrite();
  clickable(writeChip, () => {
    a.write = !a.write;
    save(ctx);
    syncWrite();
    refreshMeta(row, a, ctx);
  });

  // Enabled chip.
  renderEnabledChip(head, row, a, ctx);

  head.createDiv({ cls: "mva-auto-spacer" });

  const run = head.createEl("button", { cls: "mva-btn", text: "Run now" });
  run.onclick = () => {
    const p = prompts.find((x) => x.name.toLowerCase() === a.name.toLowerCase());
    if (!p) {
      new Notice(`No playbook named "${a.name}".`);
      return;
    }
    run.setAttr("disabled", "true");
    void ctx.plugin
      .runPlaybook(p.name, p.prompt, { write: a.write })
      .then((ok) => {
        if (ok) {
          ctx.plugin.settings.scheduledLastRun[p.name] = Date.now();
          save(ctx);
        }
      })
      .finally(() => {
        // The pane outlives the run — the row may be detached if the user
        // switched tabs (or the tab re-rendered) while the playbook ran.
        if (!row.isConnected) return;
        run.removeAttribute("disabled");
        refreshMeta(row, a, ctx);
        ctx.rerender();
      });
  };

  renderRemoveControl(head, idx, ctx);

  row.createDiv({ cls: "mva-auto-meta" });
  refreshMeta(row, a, ctx);
  if (!known) row.createDiv({ cls: "mva-auto-warn", text: "Playbook not found — pick an existing prompt." });
}

function renderCadenceChip(head: HTMLElement, a: AutomationConfig, ctx: HubTabContext): void {
  chipSelect(head, cadenceLabel(a.cadence), "Cadence", (pop, close) => {
    optionRows(
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
              ? { kind: "daily", hour: hourOf(a.cadence) }
              : { kind: "weekly", day: 1, hour: hourOf(a.cadence) };
        save(ctx);
        close();
        ctx.rerender();
      }
    );
    if (a.cadence.kind !== "hourly") {
      const hourRow = pop.createDiv({ cls: "mva-auto-popfield" });
      hourRow.createSpan({ cls: "mva-pv-label", text: "At hour" });
      const hour = hourRow.createEl("input", {
        cls: "mva-pv-input mva-auto-hour",
        attr: { type: "number", min: "0", max: "23" },
      });
      hour.value = String(hourOf(a.cadence));
      hour.onchange = () => {
        const h = Math.min(23, Math.max(0, Number(hour.value) || 0));
        if (a.cadence.kind !== "hourly") a.cadence.hour = h;
        save(ctx);
        ctx.rerender();
      };
    }
    if (a.cadence.kind === "weekly") {
      const dayRow = pop.createDiv({ cls: "mva-auto-popfield" });
      dayRow.createSpan({ cls: "mva-pv-label", text: "On" });
      optionRows(
        dayRow,
        DAY_LABELS.map((d, i) => ({ value: String(i), label: d })),
        String(a.cadence.day),
        (v) => {
          if (a.cadence.kind === "weekly") a.cadence.day = Number(v);
          save(ctx);
          close();
          ctx.rerender();
        }
      );
    }
  });
}

function renderDailyPulseRow(list: HTMLElement, a: AutomationConfig, idx: number, ctx: HubTabContext): void {
  const row = list.createDiv({ cls: "mva-auto-row mva-auto-pulse" });
  const head = row.createDiv({ cls: "mva-auto-head" });
  head.createDiv({ cls: "mva-sel-chip", text: "Daily Pulse" });
  renderCadenceChip(head, a, ctx);

  renderEnabledChip(head, row, a, ctx);

  head.createDiv({ cls: "mva-auto-spacer" });
  const open = head.createEl("button", { cls: "mva-btn", text: "Open" });
  open.onclick = () => void ctx.plugin.openDailyPulse().then(() => {
    if (row.isConnected) ctx.rerender();
  });

  const state = ctx.plugin.settings.dailyPulseReviewState;
  const retry = head.createEl("button", {
    cls: "mva-btn",
    text: state.retryable ? "Retry" : "Refresh now",
  });
  retry.onclick = () => {
    retry.setAttr("disabled", "true");
    void ctx.plugin.runDailyPulseNow().then((ok) => {
      if (!ok) new Notice("Daily Pulse could not be refreshed. You can retry.");
      if (row.isConnected) ctx.rerender();
    });
  };

  renderRemoveControl(head, idx, ctx);

  row.createDiv({ cls: "mva-auto-meta" });
  refreshMeta(row, a, ctx);
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

function refreshMeta(row: HTMLElement, a: AutomationConfig, ctx: HubTabContext): void {
  const meta = row.querySelector<HTMLElement>(".mva-auto-meta");
  if (!meta) return;
  const now = Date.now();
  const last = ctx.plugin.settings.scheduledLastRun[automationLastRunKey(a)] ?? 0;
  const parts = [`last ${formatAge(last || null, now, "never")}`];
  if (a.enabled) parts.push(`next ${formatDueIn(nextDueAt(a.cadence, last, now) - now)}`);
  if (isDailyPulseAutomation(a)) {
    parts.push(dailyPulseMetaLabel(ctx.plugin.settings.dailyPulseReviewState));
  }
  meta.setText(parts.join(" · "));
}

function hourOf(c: Cadence): number {
  return c.kind === "hourly" ? 7 : c.hour;
}

function renderEnabledChip(head: HTMLElement, row: HTMLElement, automation: AutomationConfig, ctx: HubTabContext): void {
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
    save(ctx);
    sync();
    refreshMeta(row, automation, ctx);
  });
}

function renderRemoveControl(head: HTMLElement, index: number, ctx: HubTabContext): void {
  const control = head.createSpan({
    cls: "mva-auto-x",
    attr: { "aria-label": "Remove automation" },
  });
  setIcon(control, "x");
  clickable(control, () => {
    ctx.plugin.settings.automations.splice(index, 1);
    save(ctx);
    ctx.rerender();
  });
}

/* --------------------------- chip + popover --------------------------- */

function chipSelect(
  parent: HTMLElement,
  label: string,
  aria: string,
  fill: (pop: HTMLElement, close: () => void) => void,
  opts?: { warn?: boolean }
): void {
  const wrap = parent.createDiv({ cls: "mva-sel" });
  const chip = wrap.createDiv({ cls: "mva-sel-chip", attr: { "aria-label": aria } });
  chip.setText(label);
  if (opts?.warn) {
    const w = chip.createSpan({ cls: "mva-auto-chip-warn" });
    setIcon(w, "alert-triangle");
  }
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

/**
 * Option rows that carry a second line explaining the choice.
 *
 * A label alone makes you pick and then find out. These are consequential
 * settings — one of them lets an agent edit notes while you are not looking —
 * so the meaning belongs next to the choice, not in documentation.
 */
/**
 * The "when it runs" chip — the last field that used to require editing YAML.
 *
 * Edits only the primary trigger. An agent almost always has one reason it runs
 * on its own; a full list editor would be a modal, and a modal for the common
 * case is the wrong trade. Rarer shapes (several schedules, a second watched
 * folder) stay available from chat and the contract file, which the chip's
 * footer says out loud rather than leaving the reader to wonder.
 */
function renderTriggerChip(
  chips: HTMLElement,
  contract: AgentContract,
  onChange: (triggers: AgentTrigger[]) => void
): void {
  const current = primaryTrigger(contract.triggers);
  const kind =
    !current ? "none"
    : current.on === "schedule" ? current.cadence.kind
    : current.on === "vault-event" ? "folder"
    : "tag";

  const replace = (next: AgentTrigger | null) => onChange(setPrimaryTrigger(contract.triggers, next));
  const hourNow = current?.on === "schedule" && current.cadence.kind !== "hourly" ? current.cadence.hour : 8;

  chipSelect(chips, current ? triggerClause(current).toLowerCase() : "only when i ask", "When it runs", (pop, close) => {
    optionRows(
      pop,
      [
        { value: "none", label: "only when I ask" },
        { value: "hourly", label: "every hour" },
        { value: "daily", label: "every day" },
        { value: "weekly", label: "every week" },
        { value: "folder", label: "when a note lands in a folder" },
        { value: "tag", label: "when a tag is added" },
      ],
      kind,
      (v) => {
        close();
        if (v === "none") return replace(null);
        if (v === "hourly") return replace({ on: "schedule", cadence: { kind: "hourly" } });
        if (v === "daily") return replace({ on: "schedule", cadence: { kind: "daily", hour: hourNow } });
        if (v === "weekly") return replace({ on: "schedule", cadence: { kind: "weekly", day: 1, hour: hourNow } });
        if (v === "folder") return replace({ on: "vault-event", event: "create", path: "_inbox/**" });
        return replace({ on: "tag", tag: "#todo" });
      }
    );

    if (current?.on === "schedule" && current.cadence.kind !== "hourly") {
      const cadence = current.cadence;
      const row = pop.createDiv({ cls: "mva-auto-popfield" });
      row.createSpan({ cls: "mva-pv-label", text: "At hour" });
      const hour = row.createEl("input", {
        cls: "mva-pv-input mva-auto-hour",
        attr: { type: "number", min: "0", max: "23" },
      });
      hour.value = String(cadence.hour);
      hour.onchange = () => {
        const h = Math.min(23, Math.max(0, Number(hour.value) || 0));
        replace({ on: "schedule", cadence: { ...cadence, hour: h } });
      };
    }

    if (current?.on === "schedule" && current.cadence.kind === "weekly") {
      const cadence = current.cadence;
      const row = pop.createDiv({ cls: "mva-auto-popfield" });
      row.createSpan({ cls: "mva-pv-label", text: "On" });
      optionRows(
        row,
        DAY_LABELS.map((d, i) => ({ value: String(i), label: d })),
        String(cadence.day),
        (v) => replace({ on: "schedule", cadence: { ...cadence, day: Number(v) } })
      );
    }

    if (current?.on === "vault-event") {
      const evt = current;
      const row = pop.createDiv({ cls: "mva-auto-popfield" });
      row.createSpan({ cls: "mva-pv-label", text: "Folder" });
      const input = row.createEl("input", { cls: "mva-pv-input", attr: { type: "text", placeholder: "_inbox" } });
      // The glob is the schema's business, not the reader's: they type a folder.
      input.value = evt.path.replace(/\/\*+$/, "");
      input.onchange = () => {
        const folder = input.value.trim().replace(/^\/+|\/+$/g, "");
        if (folder) replace({ ...evt, path: `${folder}/**` });
      };
    }

    if (current?.on === "tag") {
      const tag = current;
      const row = pop.createDiv({ cls: "mva-auto-popfield" });
      row.createSpan({ cls: "mva-pv-label", text: "Tag" });
      const input = row.createEl("input", { cls: "mva-pv-input", attr: { type: "text", placeholder: "#todo" } });
      input.value = tag.tag;
      input.onchange = () => {
        const t = input.value.trim();
        if (t) replace({ on: "tag", tag: t.startsWith("#") ? t : `#${t}` });
      };
    }

    const extra = contract.triggers.filter((t) => t.on !== "note-mention").length - 1;
    if (extra > 0) {
      pop.createDiv({
        cls: "mva-sel-opt-hint mva-auto-popnote",
        text: `+${extra} more trigger${extra > 1 ? "s" : ""} — edit them in the contract file or from chat.`,
      });
    }
  });
}

function hintedRows(
  pop: HTMLElement,
  options: readonly { value: string; label: string; hint: string }[],
  selected: string,
  onPick: (v: string) => void
): void {
  for (const o of options) {
    const opt = pop.createDiv({ cls: "mva-sel-opt mva-sel-opt-tall", attr: { tabindex: "0" } });
    const dot = opt.createSpan({ cls: "mva-sel-opt-dot" });
    if (o.value === selected) setIcon(dot, "check");
    const text = opt.createDiv({ cls: "mva-sel-opt-text" });
    text.createDiv({ text: o.label });
    text.createDiv({ cls: "mva-sel-opt-hint", text: o.hint });
    clickable(opt, () => onPick(o.value));
  }
}

function optionRows(
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

async function renderRuns(host: HTMLElement, ctx: HubTabContext): Promise<void> {
  host.empty();
  const runs = await ctx.plugin.loadAutomationRuns();
  if (!runs.length) return;
  host.createDiv({ cls: "mva-pv-label", text: "Recent write runs" });
  for (const r of runs.slice(0, 8)) renderRunRow(host, r, ctx);
}

function renderRunRow(host: HTMLElement, r: AutomationRunRecord, ctx: HubTabContext): void {
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
        clickable(name, () => void ctx.app.workspace.openLinkText(path, "", "tab"));
        f.createDiv({ cls: "mva-auto-spacer" });
        const entry = r.checkpoint.find(([p]) => p === path);
        const diff = f.createEl("button", { cls: "mva-btn", text: entry ? "Diff" : "No snapshot" });
        if (entry) {
          diff.onclick = () => void showDiff(ctx, path, entry[1]);
        } else diff.setAttr("disabled", "true");
      }
    });
  }

  const rerunRuns = () => {
    if (host.isConnected) void renderRuns(host, ctx);
  };
  if (!r.reviewedAt && !r.restoredAt && r.writes.length) {
    const reviewed = row.createEl("button", { cls: "mva-btn", text: "Reviewed" });
    reviewed.onclick = () => {
      reviewed.setAttr("disabled", "true");
      void ctx.plugin.markAutomationRunReviewed(r.id).finally(rerunRuns);
    };
  }

  const report = row.createEl("button", { cls: "mva-btn", text: "Report" });
  report.onclick = () => void ctx.app.workspace.openLinkText(r.reportPath, "", "tab");
  if (r.checkpoint.length && !r.restoredAt) {
    const restore = row.createEl("button", { cls: "mva-btn", text: "Restore" });
    let armed = false;
    restore.onclick = () => {
      if (!armed) {
        armed = true;
        restore.setText("Sure?");
        restore.addClass("mva-btn-danger");
        window.setTimeout(() => {
          armed = false;
          restore.setText("Restore");
          restore.removeClass("mva-btn-danger");
        }, 4000);
        return;
      }
      restore.setAttr("disabled", "true");
      void ctx.plugin.restoreAutomationRun(r.id).finally(rerunRuns);
    };
  }
}

/** Pre-run snapshot vs current content, in the shared NoteDiffModal. */
async function showDiff(ctx: HubTabContext, path: string, before: string | null): Promise<void> {
  let after = "";
  const f = ctx.app.vault.getAbstractFileByPath(path);
  if (f instanceof TFile) {
    try {
      after = await ctx.app.vault.read(f);
    } catch {
      /* unreadable — show as empty */
    }
  }
  new NoteDiffModal(ctx.app, noteBasename(path), before, after, () => {
    void ctx.app.workspace.openLinkText(path, "", "tab");
  }).open();
}
