import {
  App,
  TFile,
  TFolder,
  FuzzySuggestModal,
  setIcon,
  setTooltip,
  Notice,
} from "obsidian";
import { Autocomplete, type AcItem } from "./autocomplete";
import type ExoPlugin from "../main";
import { ADAPTERS } from "../providers/registry";
import type {
  ContextUsage,
  ImageAttachment,
  PermissionMode,
  ProviderId,
  RateLimitInfo,
  SessionCaps,
} from "../providers/types";
import { basename as noteBasename } from "../obsidian/graph";
import { clickable } from "./dom";
import { openablePopover } from "./popover";
import { PromptVarsModal, extractVars, fillVars } from "./prompt-vars";
import type { Convo } from "../view";
import {
  badgeState,
  formatClock,
  normalizeResetEpochMs,
  windowLabel,
} from "../core/rate-limit";
import { buildOptionRows, type SelectOption } from "../core/option-filter";
import { queryWords, matchesWords } from "../core/ac-token";
import { selectionPreview } from "../core/selection-preview";
import { clampEffort, effortOptionsFor } from "../core/model-tuning";

/** Semantic risk modifier class for a toolbar selector option/chip ("" = neutral). */
type RiskLevel = "" | "is-caution" | "is-danger";

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Abbreviate a token count with k/M suffixes: 68000 → "68k", 1_500_000 → "1.5M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function extToMime(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "gif") return "image/gif";
  if (e === "webp") return "image/webp";
  return "image/png";
}

/**
 * What the composer needs from the view. Kept narrow: the send/stop turn
 * controls, workflow submission, the shared model/provider/permission state, and
 * a handful of view services (open a note, register cleanup). The composer owns
 * everything else (its own DOM, popovers, images, context row, selection chip).
 */
export interface ComposerHost {
  plugin: ExoPlugin;
  /** The scroll host the composer pins itself to the bottom of. */
  listWrap: HTMLElement;
  /** The active conversation. */
  active: Convo;
  /** Active conversation is streaming (drives the send/stop button). */
  streaming: boolean;
  /** Selected provider/model (writable — a model pick can flip provider+model). */
  provider: ProviderId;
  model: string;
  /** The mode a plan-mode entry came from, restored on plan approval. */
  prePlanMode: PermissionMode;
  /** Latest capability snapshot (skills/commands/agents) for the autocomplete menus. */
  sessionCaps: SessionCaps | null;
  register(cb: () => void): void;
  send(): void;
  stop(source?: "esc" | "button"): void;
  submitWorkflow(c: Convo, steps: string[]): void;
  compactActive(instructions?: string): void;
  togglePlanMode(): void;
  onProviderChange(next: ProviderId, explicitModel?: string): void;
  allModelChoices(): { id: string; label: string; provider: ProviderId }[];
  persistModel(): void;
  openNote(path: string): void;
  openArtifactExternally(path: string): void;
}

export class Composer {
  private usageEl: HTMLElement | null = null;
  private lastUsage: ContextUsage | null = null;
  private rateBadgeEl: HTMLElement | null = null;
  private lastRateLimit: RateLimitInfo | null = null;
  private composerEl!: HTMLElement;
  private compactNudgeEl: HTMLElement | null = null;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  // Three independent toolbar chips — Model, Effort, Permission — each expose a
  // refresh fn so external changes (provider switch, plan-mode toggle, model
  // pick) can re-sync their label without opening the chip's popover.
  // refreshModelChip also cascades into refreshEffortChip, since valid effort
  // tiers (and the label) depend on the chosen model; Permission only depends
  // on provider, and onProviderChange calls refreshPermChipFn directly.
  private refreshModelChip: () => void = () => {};
  private refreshEffortChip: () => void = () => {};
  private refreshPermChipFn: () => void = () => {};
  private contextEl!: HTMLElement;
  private excludeActiveNote = false;
  private manualAttached: string[] = [];
  /** The active editor's current selection, mirrored ambiently into the composer. */
  private currentSelection: { text: string; path: string } | null = null;
  private pendingImages: ImageAttachment[] = [];
  private imagesEl!: HTMLElement;

  constructor(private host: ComposerHost) {}

  /** The Obsidian app, reached through the plugin — the composer never holds a
   *  direct `app` handle, so the host stays a narrow view contract. */
  private get app(): App {
    return this.host.plugin.app;
  }

  /* --------------------------- public surface ----------------------- */

  getInputEl(): HTMLTextAreaElement {
    return this.inputEl;
  }
  getSendBtn(): HTMLButtonElement {
    return this.sendBtn;
  }
  getComposerEl(): HTMLElement {
    return this.composerEl;
  }
  getInputValue(): string {
    return this.inputEl.value;
  }
  setInputValue(v: string): void {
    this.inputEl.value = v;
  }
  focusInput(): void {
    window.setTimeout(() => this.inputEl?.focus(), 0);
  }
  getPendingImages(): ImageAttachment[] {
    return this.pendingImages;
  }
  clearPendingImages(): void {
    this.pendingImages = [];
  }
  addManualAttached(path: string): void {
    if (!this.manualAttached.includes(path)) this.manualAttached.push(path);
  }
  setLastRateLimit(info: RateLimitInfo | null): void {
    this.lastRateLimit = info;
  }
  resetSlashCache(): void {
    this.slashCache = null;
  }
  refreshModel(): void {
    this.refreshModelChip();
  }
  refreshPerm(): void {
    this.refreshPermChipFn();
  }

  /* ---------------------------- context ----------------------------- */

  /** Build the composer (input box + toolbar) and mount it into `root`. */
  mount(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "mva-composer" });
    this.composerEl = bar;
    // The composer is pinned to the bottom of listWrap (CSS), overlapping the
    // transcript. Publish its live height as --mva-composer-h so the list can
    // reserve matching bottom padding (last message clears the bar) and the jump
    // pill / content fade sit just above it. Height changes as the textarea grows,
    // images/context rows appear, or the bar is hidden (gallery → 0).
    const syncHeight = () =>
      this.host.listWrap.style.setProperty("--mva-composer-h", `${bar.offsetHeight}px`);
    const composerResize = new ResizeObserver(syncHeight);
    composerResize.observe(bar);
    this.host.register(() => composerResize.disconnect());
    this.contextEl = bar.createDiv({ cls: "mva-context" });
    this.imagesEl = bar.createDiv({ cls: "mva-images is-hidden" });

    // One unified input box (the only surface): textarea on top, controls at the bottom.
    const box = bar.createDiv({ cls: "mva-inputbox" });
    this.inputEl = box.createEl("textarea", {
      cls: "mva-input",
      attr: { rows: "3", placeholder: "Message the agent…" },
    });
    this.inputEl.addEventListener("input", () => this.autoGrow());
    this.inputEl.addEventListener("paste", (e) => this.onPaste(e));
    bar.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        bar.addClass("is-drop");
      }
    });
    bar.addEventListener("dragleave", () => bar.removeClass("is-drop"));
    bar.addEventListener("drop", (e) => {
      bar.removeClass("is-drop");
      this.onDrop(e);
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        this.host.togglePlanMode();
        return;
      }
      if (e.key === "Escape" && this.host.streaming) {
        e.preventDefault();
        this.host.stop("esc");
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.host.send(); // send() queues if the active conversation is streaming
      }
    });

    new Autocomplete(this.inputEl, box, [
      { trigger: "/", getItems: (q) => this.slashItems(q) },
      { trigger: "$", getItems: (q) => this.skillItems(q) },
      // Vault file names use spaces, so the file picker keeps matching past
      // whitespace: "@mario mil" narrows word-by-word instead of dying at the
      // first space.
      { trigger: "@", allowSpaces: true, getItems: (q) => this.atItems(q) },
    ]);

    this.buildToolbar(box);
  }

  /** Seed the composer with a selection quoted from a note (the in-note "Ask Exo"
   *  action) and focus it. The excerpt is rendered as a Markdown blockquote with
   *  a source line so the agent sees exactly what the user highlighted; the caret
   *  lands after it, ready for the question. */
  attachSelection(text: string, sourcePath: string): void {
    const src = sourcePath ? noteBasename(sourcePath) : "the current note";
    const quoted = text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    const block = `From "${src}":\n${quoted}\n\n`;
    // Prepend the excerpt, leave the caret at the very end for the question.
    this.inputEl.value = block + this.inputEl.value;
    const caret = this.inputEl.value.length;
    this.inputEl.setSelectionRange(caret, caret);
    this.autoGrow();
    window.setTimeout(() => this.inputEl?.focus(), 0);
  }

  /** Mirror the active editor's current selection into the composer as an ambient
   *  "Selection" chip (see the selection observer). Empty `text` clears it. No-op
   *  when the (text, path) pair is unchanged, so the debounced observer can call
   *  freely without churning the DOM. */
  setCurrentSelection(text: string, path: string): void {
    const next = text ? { text, path } : null;
    const prev = this.currentSelection;
    if ((prev?.text ?? "") === (next?.text ?? "") && (prev?.path ?? "") === (next?.path ?? "")) return;
    this.currentSelection = next;
    this.refreshContext();
  }

  /* ----------------------------- images ----------------------------- */

  private onPaste(e: ClipboardEvent): void {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length) {
      e.preventDefault();
      void this.attachImages(files);
    }
  }

  private onDrop(e: DragEvent): void {
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      void this.attachImages(files);
    }
  }

  private async attachImages(files: Blob[]): Promise<void> {
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        const dataB64 = arrayBufferToBase64(buf);
        this.pendingImages.push({
          mediaType: (f as File).type || "image/png",
          dataB64,
          name: (f as File).name || "pasted image",
        });
      } catch {
        new Notice("Couldn't read an image.");
      }
    }
    this.renderImageStrip();
  }

  /** Resolve `![[image]]` embeds in the text to base64 attachments (Obsidian-native). */
  async embeddedImages(text: string): Promise<ImageAttachment[]> {
    const out: ImageAttachment[] = [];
    const re = /!\[\[([^\]]+?\.(?:png|jpe?g|gif|webp))(?:\|[^\]]*)?\]\]/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const f = this.app.metadataCache.getFirstLinkpathDest(m[1], "");
      if (!f) continue;
      try {
        const buf = await this.app.vault.readBinary(f);
        out.push({
          mediaType: extToMime(f.extension),
          dataB64: arrayBufferToBase64(buf),
          name: f.name,
        });
      } catch {
        /* skip unreadable */
      }
    }
    return out;
  }

  renderImageStrip(): void {
    this.imagesEl.empty();
    this.imagesEl.toggleClass("is-hidden", this.pendingImages.length === 0);
    this.pendingImages.forEach((img, i) => {
      const chip = this.imagesEl.createDiv({ cls: "mva-img-chip" });
      const thumb = chip.createEl("img", { cls: "mva-img-thumb" });
      thumb.src = `data:${img.mediaType};base64,${img.dataB64}`;
      const x = chip.createSpan({ cls: "mva-img-x", attr: { "aria-label": "Remove image" } });
      setIcon(x, "x");
      clickable(x, () => {
        this.pendingImages.splice(i, 1);
        this.renderImageStrip();
      });
    });
  }

  /* --------------------------- autocomplete ------------------------- */

  private slashCache: { commands: string[]; skills: string[]; agents: string[]; ts: number } | null = null;
  private static readonly SLASH_TTL = 30_000;

  private async loadSlash(): Promise<{ commands: string[]; skills: string[]; agents: string[] }> {
    if (this.slashCache && Date.now() - this.slashCache.ts < Composer.SLASH_TTL) return this.slashCache;
    const commands: string[] = [];
    const skills: string[] = [];
    const agents: string[] = [];
    const base = (p: string) => p.split("/").pop()?.replace(/\.md$/, "") ?? p;
    try {
      const c = await this.app.vault.adapter.list(".claude/commands");
      for (const f of c.files) if (f.endsWith(".md")) commands.push(base(f));
    } catch {
      /* no commands dir */
    }
    try {
      const s = await this.app.vault.adapter.list(".claude/skills");
      for (const folder of s.folders) skills.push(folder.split("/").pop() ?? folder);
      for (const f of s.files) if (f.endsWith(".md")) skills.push(base(f));
    } catch {
      /* no skills dir */
    }
    try {
      const a = await this.app.vault.adapter.list(".claude/agents");
      for (const f of a.files) if (f.endsWith(".md")) agents.push(base(f));
    } catch {
      /* no agents dir */
    }
    // Union with the session's live init snapshot (global + plugin + vault —
    // the vault scan above only ever saw the vault's own .claude/). Dedup keeps
    // the menus stable when both sources know the same name.
    if (this.host.sessionCaps) {
      const add = (into: string[], names: string[]) => {
        const seen = new Set(into);
        for (const n of names) if (!seen.has(n)) (seen.add(n), into.push(n));
      };
      add(commands, this.host.sessionCaps.commands);
      add(skills, this.host.sessionCaps.skills);
      add(agents, this.host.sessionCaps.agents);
    }
    this.slashCache = { commands, skills, agents, ts: Date.now() };
    return this.slashCache;
  }

  /** `$` trigger — skills. */
  private async skillItems(query: string): Promise<AcItem[]> {
    const q = query.toLowerCase();
    const { skills } = await this.loadSlash();
    return skills
      .filter((sk) => sk.toLowerCase().includes(q))
      .map((sk) => ({ label: sk, detail: "skill", icon: "sparkles", insert: `$${sk} ` }));
  }

  private async slashItems(query: string): Promise<AcItem[]> {
    const q = query.toLowerCase();
    const out: AcItem[] = [];
    // Built-in: /compact [instructions] — compaction, handled locally in send().
    if ("compact".includes(q)) {
      out.push({ label: "compact", detail: "compact context", icon: "scissors", insert: "/compact " });
    }
    for (const p of this.host.plugin.settings.customPrompts) {
      if (p.name.toLowerCase().includes(q)) {
        const isWorkflow = p.prompt.includes(" >>> ");
        out.push({
          label: p.name,
          detail: isWorkflow ? "workflow" : "prompt",
          icon: isWorkflow ? "list-ordered" : "message-square",
          insert: "",
          onSelect: () => this.usePrompt(p.prompt),
        });
      }
    }
    const { commands, skills } = await this.loadSlash();
    for (const c of commands) {
      if (c.toLowerCase().includes(q)) out.push({ label: c, detail: "command", icon: "terminal", insert: `/${c} ` });
    }
    for (const sk of skills) {
      if (sk.toLowerCase().includes(q)) out.push({ label: sk, detail: "skill", icon: "sparkles", insert: `/${sk} ` });
    }
    return out;
  }

  private async atItems(query: string): Promise<AcItem[]> {
    // AND-match on words: "@people mario" finds Atlas/People/Mario Miletta.md
    // regardless of word order — each space-separated word must appear in the path.
    const words = queryWords(query);
    const out: AcItem[] = [];
    // Subagents first — reference a vault agent by @mention.
    const { agents } = await this.loadSlash();
    for (const a of agents) {
      if (!matchesWords(a, words)) continue;
      out.push({ label: a, detail: "subagent", icon: "bot", insert: `@${a} ` });
    }
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if (!f.path || f.path === "/") continue;
      if (!matchesWords(f.path, words)) continue;
      const isFolder = f instanceof TFolder;
      if (!isFolder && !(f instanceof TFile)) continue;
      const parent = f.parent && f.parent.path !== "/" ? f.parent.path : "";
      out.push({
        label: isFolder ? `${f.name}/` : f.name,
        detail: parent,
        icon: isFolder ? "folder" : "file-text",
        insert: `@${f.path}${isFolder ? "/" : ""} `,
        onSelect: () => {
          if (!this.manualAttached.includes(f.path)) this.manualAttached.push(f.path);
          this.refreshContext();
        },
      });
      if (out.length >= 40) break;
    }
    return out;
  }

  private static readonly EFFORT_OPTS: [string, string][] = [
    ["default", "Default"],
    ["low", "Low"],
    ["medium", "Medium"],
    ["high", "High"],
    ["xhigh", "Extra high"],
    ["max", "Max"],
  ];
  private static effortLabel(e: string): string {
    return Composer.EFFORT_OPTS.find(([v]) => v === e)?.[1] ?? e;
  }

  private buildToolbar(bar: HTMLElement): void {
    const tb = bar.createDiv({ cls: "mva-toolbar" });

    // Attach "+" — the single entry point for adding context (note / file /
    // folder / image). Leftmost in the toolbar; opens a themed popover (matching
    // the select chips) rather than the OS/Obsidian menu.
    this.buildAttachButton(tb);

    // Tuning cascade, left-aligned, each its own visible chip: Model → Effort →
    // Permission. Model comes first because the other two derive from it (the
    // chosen model gates which effort tiers are valid and which provider owns
    // the permission/sandbox setting). Three chips instead of one dial (07-06:
    // reverts the 07-05 consolidation) — a hidden "sliders" icon meant the
    // active model/effort/permission weren't visible without a click; each
    // chip now shows its own current value at rest.
    this.buildModelSelect(tb);
    this.buildEffortSelect(tb);
    this.buildPermissionSelect(tb);

    tb.createDiv({ cls: "mva-spacer" }).style.flex = "1";
    // Context usage as a compact circular counter (donut ring). Hover for the
    // detailed breakdown, click to compact. See updateUsage for the fill logic.
    this.usageEl = tb.createDiv({ cls: "mva-ctx-ring" });
    clickable(this.usageEl, () => this.host.compactActive());
    this.updateUsage(null);

    // Claude-plan quota badge — a quiet dot+percent that only appears when the
    // plan is nearing (≥80% / warning) or over its limit. Sits beside the ring.
    this.rateBadgeEl = tb.createDiv({ cls: "mva-rate-badge" });
    this.rateBadgeEl.hide();
    this.updateRateBadge();

    // Send button — lives inside the input box, right side.
    this.sendBtn = tb.createEl("button", { cls: "mva-send", attr: { "aria-label": "Send" } });
    setIcon(this.sendBtn, "arrow-up");
    setTooltip(this.sendBtn, "Send");
    this.sendBtn.onclick = () => (this.host.streaming ? this.host.stop() : void this.host.send());
  }

  /** Model selector — unified picker across BOTH providers (no separate
   *  Provider chip), first in the cascade since Effort/Permission derive from
   *  it. The chip shows the chosen model's label at rest; its popover groups
   *  Claude/Codex options under quiet headers with a brand-color dot per row.
   *  Picking a model from the other backend switches provider+model together
   *  (that also flips Permission↔Sandbox — see onProviderChange). */
  private buildModelSelect(tb: HTMLElement): void {
    const wrap = tb.createDiv({ cls: "mva-sel" });
    const chip = wrap.createDiv({ cls: "mva-sel-chip", attr: { "aria-label": "Model" } });
    const pop = wrap.createDiv({ cls: "mva-sel-pop" });
    pop.hide();

    const refreshLabel = () => chip.setText(this.modelLabel());

    const popover = openablePopover({
      anchor: chip,
      pop,
      wrap,
      onOpen: () =>
        this.renderOptionRows(
          pop,
          this.host.allModelChoices().map((m) => ({
            value: m.id,
            label: m.label,
            dotColor: ADAPTERS[m.provider].brandColor,
            group: m.provider === "claude" ? "Claude" : "Codex",
          })),
          this.host.model,
          {
            onPick: (v) => {
              this.applyModelChoice(v);
              popover.close();
            },
            onEscape: () => popover.close(),
          }
        ),
      focus: () => pop.querySelector<HTMLElement>(".mva-sel-opt")?.focus(),
    });
    clickable(chip, (e) => {
      e.stopPropagation();
      popover.toggle();
    });
    this.host.register(() => popover.close());

    refreshLabel();
    // External-change hook (provider switch, model pick): re-label this chip,
    // then cascade into Effort — its valid tiers (and displayed label) depend
    // on the model. Permission doesn't depend on the model, only the
    // provider, and onProviderChange already calls refreshPerm() directly.
    this.refreshModelChip = () => {
      refreshLabel();
      this.refreshEffortChip();
    };
  }

  /** Effort selector — tiers are per-model (core/model-tuning.ts); a stale
   *  stored tier (e.g. "max" saved, then a Codex model restored) is clamped
   *  to the nearest valid one on every label refresh, so an invalid tier
   *  never reaches the CLI and the chip never shows a value the model
   *  doesn't support. Hidden entirely for models with no effort support. */
  private buildEffortSelect(tb: HTMLElement): void {
    const s = this.host.plugin.settings;
    const effortOpts = () => effortOptionsFor(this.host.provider, this.host.model);

    const wrap = tb.createDiv({ cls: "mva-sel" });
    const chip = wrap.createDiv({ cls: "mva-sel-chip", attr: { "aria-label": "Effort" } });
    const pop = wrap.createDiv({ cls: "mva-sel-pop" });
    pop.hide();

    const refreshLabel = () => {
      const eo = effortOpts();
      if (!eo) {
        wrap.hide();
        return;
      }
      wrap.show();
      const next = clampEffort(s.effort || "default", eo);
      if (next !== (s.effort || "default")) {
        s.effort = next;
        void this.host.plugin.saveSettings();
      }
      chip.setText(Composer.effortLabel(s.effort || "default"));
    };

    const popover = openablePopover({
      anchor: chip,
      pop,
      wrap,
      onOpen: () => {
        const eo = effortOpts();
        if (!eo) return;
        this.renderOptionRows(pop, eo.map(([value, label]) => ({ value, label })), s.effort || "default", {
          onPick: (v) => {
            s.effort = v;
            void this.host.plugin.saveSettings();
            refreshLabel();
            popover.close();
          },
          onEscape: () => popover.close(),
        });
      },
      focus: () => pop.querySelector<HTMLElement>(".mva-sel-opt")?.focus(),
    });
    clickable(chip, (e) => {
      e.stopPropagation();
      popover.toggle();
    });
    this.host.register(() => popover.close());

    refreshLabel();
    this.refreshEffortChip = refreshLabel;
  }

  /** Permission (Claude) / Sandbox (Codex) selector — the actual tool gate,
   *  last in the cascade. Provider-aware: Claude's `permissionMode` gates
   *  tool calls via `canUseTool`; Codex has no such hook, so its sandbox
   *  setting is what the chip shows and controls instead. Risk (caution/
   *  danger) colors the chip itself — no separate always-visible dot. */
  private buildPermissionSelect(tb: HTMLElement): void {
    const s = this.host.plugin.settings;

    const wrap = tb.createDiv({ cls: "mva-sel" });
    const chip = wrap.createDiv({ cls: "mva-sel-chip", attr: { "aria-label": "Permission mode" } });
    const pop = wrap.createDiv({ cls: "mva-sel-pop" });
    pop.hide();

    const refreshLabel = () => {
      const risk = this.host.provider === "codex" ? Composer.codexSandboxRisk(s.codexSandbox) : Composer.permRisk(s.permissionMode);
      chip.className = `mva-sel-chip${risk ? ` ${risk}` : ""}`;
      chip.setText(
        this.host.provider === "codex" ? Composer.codexSandboxLabel(s.codexSandbox) : Composer.permLabel(s.permissionMode)
      );
    };

    const popover = openablePopover({
      anchor: chip,
      pop,
      wrap,
      onOpen: () => {
        const options =
          this.host.provider === "codex"
            ? Composer.CODEX_SANDBOX_OPTS.map(([v, l]) => ({ value: v, label: l, risk: Composer.codexSandboxRisk(v) }))
            : Composer.PERM_OPTS.map(([v, l]) => ({ value: v, label: l, risk: Composer.permRisk(v) }));
        const current = this.host.provider === "codex" ? s.codexSandbox : s.permissionMode;
        this.renderOptionRows(pop, options, current, {
          onPick: (v) => {
            this.applyPermChoice(v);
            popover.close();
          },
          onEscape: () => popover.close(),
        });
      },
      focus: () => pop.querySelector<HTMLElement>(".mva-sel-opt")?.focus(),
    });
    clickable(chip, (e) => {
      e.stopPropagation();
      popover.toggle();
    });
    this.host.register(() => popover.close());

    refreshLabel();
    this.refreshPermChipFn = refreshLabel;
  }

  /** Apply a model pick from the tune dialog (mirrors the old model chip's
   *  onSelect): guard while streaming, switch provider+model together when the
   *  chosen model belongs to the other backend. */
  private applyModelChoice(v: string): void {
    if (this.host.streaming) {
      new Notice("Can't switch model while a reply is streaming.");
      return;
    }
    const found = this.host.allModelChoices().find((m) => m.id === v);
    if (!found) return;
    if (found.provider !== this.host.provider) {
      this.host.onProviderChange(found.provider, v);
      return;
    }
    this.host.model = v;
    this.host.persistModel();
    // Re-render the statusline's model label immediately — no new usage event
    // fires just from a model switch, so refresh with cached data.
    this.updateUsage(this.lastUsage);
    // Effort options (and the current tier's validity) follow the model —
    // re-sync the whole cascade.
    this.refreshModelChip();
  }

  /** Apply a permission (Claude) or sandbox (Codex) pick; keeps setting, live
   *  session, and the permission chip in sync. */
  private applyPermChoice(v: string): void {
    const s = this.host.plugin.settings;
    if (this.host.provider === "codex") {
      s.codexSandbox = v;
      void this.host.plugin.saveSettings();
    } else {
      // Entering plan mode records the mode we came from, so a later plan approval
      // restores it (mirrors togglePlanMode).
      if (v === "plan" && s.permissionMode !== "plan") this.host.prePlanMode = s.permissionMode;
      s.permissionMode = v as typeof s.permissionMode;
      void this.host.plugin.saveSettings();
      this.host.active.session?.setPermissionMode?.(s.permissionMode);
    }
    this.refreshPermChipFn();
  }

  /**
   * Shared option-row renderer for BOTH the toolbar select chips and the tune
   * dialog — the single source of truth for grouped/flat option rows. Draws quiet
   * group headers (from buildOptionRows), an optional provider brand-dot, risk
   * coloring, and a check on the current value; wires roving ArrowUp/Down + Enter +
   * Escape keyboard nav onto `container` (focus lives on the container, never the
   * rows). Picking a row fires `onPick` and moves the check to it — chips close
   * afterwards; the dialog stays open, so the moved check reflects the new value.
   * Returns a `focus()` that seeds the keyboard cursor on the current row.
   */
  private renderOptionRows(
    container: HTMLElement,
    options: SelectOption[],
    current: string,
    cb: { onPick: (value: string) => void; onEscape?: () => void }
  ): () => void {
    container.empty();
    const optionEls: { el: HTMLElement; value: string; check: HTMLElement }[] = [];
    let activeIdx = -1;
    const setActive = (idx: number) => {
      if (!optionEls.length) {
        activeIdx = -1;
        return;
      }
      activeIdx = ((idx % optionEls.length) + optionEls.length) % optionEls.length;
      optionEls.forEach((o, i) => o.el.toggleClass("is-active", i === activeIdx));
      optionEls[activeIdx].el.scrollIntoView({ block: "nearest" });
    };
    const markSelected = (value: string) => {
      for (const o of optionEls) {
        const sel = o.value === value;
        o.el.toggleClass("is-selected", sel);
        o.check.style.visibility = sel ? "visible" : "hidden";
      }
    };
    const pick = (value: string) => {
      cb.onPick(value);
      markSelected(value);
    };
    for (const r of buildOptionRows(options, "")) {
      if (r.kind === "header") {
        container.createDiv({ cls: "mva-sel-group", text: r.group });
        continue;
      }
      const o = r.option;
      const row = container.createDiv({ cls: "mva-sel-opt" });
      if (o.risk) row.addClass(o.risk);
      if (o.dotColor) row.createSpan({ cls: "mva-sel-opt-dot" }).style.background = o.dotColor;
      row.createSpan({ cls: "mva-sel-opt-label", text: o.label });
      const check = row.createSpan({ cls: "mva-sel-opt-check" });
      setIcon(check, "check");
      const idx = optionEls.length;
      optionEls.push({ el: row, value: o.value, check });
      row.addEventListener("mouseenter", () => setActive(idx));
      row.onclick = () => pick(o.value);
    }
    markSelected(current);
    const curIdx = optionEls.findIndex((o) => o.value === current);
    setActive(curIdx >= 0 ? curIdx : 0);
    container.tabIndex = 0;
    container.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        setActive(activeIdx + 1);
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        setActive(activeIdx - 1);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        const o = optionEls[activeIdx];
        if (o) pick(o.value);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        cb.onEscape?.();
      }
    });
    return () => container.focus();
  }

  /**
   * Single entry point for the composer footer's circular context counter
   * (donut ring). Sets --pct (0-100) and --ring-color on the ring element and
   * a hover/aria tooltip with the used/total breakdown. Called after every
   * 'usage' event and whenever model/provider changes so it stays in sync even
   * without a fresh event. NOTE: the >=75% compact nudge hooks in here — this
   * stays the one place usage state is rendered, so that trigger keeps firing.
   */
  updateUsage(u: ContextUsage | null): void {
    const ring = this.usageEl;
    if (!ring) return;
    this.lastUsage = u;

    ring.removeClass("is-caution");
    ring.removeClass("is-danger");

    // Fresh session / provider that doesn't report usage (Codex): empty ring.
    if (!u || !u.total) {
      ring.addClass("is-empty");
      ring.style.setProperty("--pct", "0");
      ring.style.setProperty("--ring-color", "var(--interactive-accent)");
      const tip = "Context usage appears after the first reply";
      setTooltip(ring, tip);
      ring.setAttribute("aria-label", tip);
      this.hideCompactNudge();
      return;
    }

    ring.removeClass("is-empty");
    const pct = Math.min(100, Math.round((u.used / u.total) * 100));
    const risk: RiskLevel = pct >= 90 ? "is-danger" : pct >= 75 ? "is-caution" : "";
    const color = pct >= 90 ? "var(--color-red)" : pct >= 75 ? "var(--color-orange)" : "var(--interactive-accent)";
    ring.style.setProperty("--pct", String(pct));
    ring.style.setProperty("--ring-color", color);
    if (risk) ring.addClass(risk);

    // Cost lives in the tooltip only (Codex omits it; Claude omits it when the
    // experimental SDK cost API is unavailable) — never a broken/empty footer.
    const costPart = typeof u.costUsd === "number" ? ` · $${u.costUsd.toFixed(2)}` : "";
    const tip = `Context: ${pct}% — ~${fmtTokens(u.used)} / ${fmtTokens(u.total)} tokens${costPart} · click to compact`;
    setTooltip(ring, tip);
    ring.setAttribute("aria-label", tip);

    // Proactive one-shot nudge: once context crosses 75% (same threshold as the
    // ring's caution state), suggest compacting. Shown at most once per convo.
    if (pct >= 75) this.maybeShowCompactNudge();
    else this.hideCompactNudge();
  }

  /** Render the Claude-plan quota badge from `lastRateLimit`. Hidden entirely
   *  when there's no snapshot (API-key sessions, or a plan with headroom) — no
   *  fake states. Visible as a quiet dot+percent at ≥80%/warning (caution) or a
   *  danger "limit" when the plan rejects. Pure thresholding lives in
   *  core/rate-limit.ts. */
  updateRateBadge(): void {
    const el = this.rateBadgeEl;
    if (!el) return;
    const info = this.lastRateLimit;
    el.removeClass("is-caution");
    el.removeClass("is-danger");
    if (!info) {
      el.hide();
      return;
    }
    const state = badgeState(info.status, info.utilization);
    if (!state.visible) {
      el.hide();
      return;
    }
    el.empty();
    el.createSpan({ cls: "mva-rate-dot" });
    el.createSpan({ cls: "mva-rate-pct", text: state.label });
    el.addClass(state.level === "danger" ? "is-danger" : "is-caution");
    // Tooltip: "Plan usage: N% of the {5-hour|weekly} window — resets HH:MM".
    const win = windowLabel(info.windowType);
    const resetMs = normalizeResetEpochMs(info.resetsAt);
    const parts = [`Plan usage: ${state.label === "limit" ? "over" : state.label} of the ${win} window`];
    if (resetMs) parts.push(`resets ${formatClock(resetMs)}`);
    const tip = parts.join(" — ");
    setTooltip(el, tip);
    el.setAttribute("aria-label", tip);
    el.show();
  }

  /** Show the discreet ≥75% compaction nudge under the composer — one-shot per
   *  conversation, Claude-only (compaction is a Claude capability). Marks the
   *  convo as nudged before rendering so it never re-appears. */
  private maybeShowCompactNudge(): void {
    const c = this.host.active;
    if (c.provider !== "claude") return; // compaction is Claude-only
    if (c.compactNudged) return; // one-shot per conversation
    if (!c.session?.compact) return; // nothing to compact yet
    if (this.compactNudgeEl) return; // already visible
    c.compactNudged = true;

    const row = this.composerEl.createDiv({ cls: "mva-compact-nudge" });
    setIcon(row.createSpan({ cls: "mva-compact-nudge-icon" }), "scissors");
    row.createSpan({
      cls: "mva-compact-nudge-text",
      text: "Context is filling up — compacting keeps the conversation sharp.",
    });
    const act = row.createEl("button", { cls: "mva-compact-nudge-act", text: "Compact now" });
    act.onclick = () => {
      this.hideCompactNudge();
      this.host.compactActive(); // no instructions — quick one-click compaction
    };
    const x = row.createSpan({ cls: "mva-compact-nudge-x", attr: { "aria-label": "Dismiss" } });
    setIcon(x, "x");
    x.onclick = () => this.hideCompactNudge();
    this.compactNudgeEl = row;
  }

  /** Remove the nudge row (visual only — the per-convo `compactNudged` flag
   *  persists, so the one-shot is never re-triggered). */
  hideCompactNudge(): void {
    this.compactNudgeEl?.remove();
    this.compactNudgeEl = null;
  }


  /* ---- Permission chip helpers ---- */
  private static readonly PERM_OPTS: [string, string][] = [
    ["default", "Ask"],
    ["acceptEdits", "Accept edits"],
    ["plan", "Plan"],
    ["auto", "Auto"],
    ["bypassPermissions", "Bypass"],
  ];
  private static permLabel(mode: string): string {
    return Composer.PERM_OPTS.find(([v]) => v === mode)?.[1] ?? mode;
  }
  /** Returns a CSS modifier class for risk coloring; empty string = safe mode. */
  private static permRisk(mode: string): RiskLevel {
    if (mode === "bypassPermissions") return "is-danger";
    if (mode === "acceptEdits" || mode === "auto") return "is-caution";
    return "";
  }

  /** Codex sandbox options (Codex has no canUseTool — its sandbox is the gate). */
  private static readonly CODEX_SANDBOX_OPTS: [string, string][] = [
    ["read-only", "Read-only"],
    ["workspace-write", "Workspace write"],
    ["danger-full-access", "Full access"],
  ];
  private static codexSandboxLabel(mode: string): string {
    return Composer.CODEX_SANDBOX_OPTS.find(([v]) => v === mode)?.[1] ?? mode;
  }
  private static codexSandboxRisk(mode: string): RiskLevel {
    if (mode === "danger-full-access") return "is-danger";
    if (mode === "workspace-write") return "is-caution";
    return "";
  }

  private activeNotePath(): string | null {
    const f = this.app.workspace.getActiveFile();
    return f ? f.path : null;
  }

  contextPaths(): string[] {
    const out: string[] = [];
    const active = this.excludeActiveNote ? null : this.activeNotePath();
    if (active) out.push(active);
    for (const p of this.manualAttached) if (!out.includes(p)) out.push(p);
    return out;
  }

  refreshContext(): void {
    if (!this.contextEl) return;
    this.contextEl.empty();
    // Every context note is a uniform card in a horizontal row (Craft-style):
    // the active note first ("Current Document"), then manual attachments.
    // The ADD affordances live inside the composer toolbar now (the "+" menu);
    // this row is purely the list of attached items — so when it's empty it
    // collapses entirely rather than leaving an empty bar.
    const active = this.excludeActiveNote ? null : this.activeNotePath();
    const items = active ? 1 : 0;
    // The selection chip shows only while a live selection exists that isn't
    // already attached as its own text (once attached it becomes redundant with
    // the seeded excerpt in the input — see attachSelection).
    const sel = this.selectionChipModel();
    const hasAny = items + this.manualAttached.filter((p) => p !== active).length > 0 || !!sel;
    this.contextEl.toggleClass("is-empty", !hasAny);
    if (!hasAny) return;
    const cards = this.contextEl.createDiv({ cls: "mva-doc-cards" });
    if (active) this.renderContextCard(cards, active, true);
    for (const p of this.manualAttached) {
      if (p !== active) this.renderContextCard(cards, p, false);
    }
    if (sel) this.renderSelectionCard(cards, sel.text, sel.path, active);
  }

  /** The selection chip's model, or null when it shouldn't show: gated on the
   *  setting, a non-empty selection, and not-already-seeded into the composer.
   *  Kept separate so `refreshContext` stays a straight list build. */
  private selectionChipModel(): { text: string; path: string } | null {
    if (!this.host.plugin.settings.showSelectionChip) return null;
    const sel = this.currentSelection;
    if (!sel || !sel.text.trim()) return null;
    return sel;
  }

  /** A transient, click-to-attach card for the active editor's selection. Same
   *  card grammar as the document cards (thumb + body + ×) but visually a hair
   *  distinct (`.mva-sel-card`): a text-cursor thumb, a "Selection" kind line, a
   *  one-line preview + count, and a source-note suffix when the selection comes
   *  from a note other than the active-context doc. Clicking seeds the quoted
   *  excerpt into the composer via the existing `attachSelection` path; the ×
   *  dismisses the chip. Keyboard-operable via `clickable()`. */
  private renderSelectionCard(parent: HTMLElement, text: string, path: string, activePath: string | null): void {
    const { label, count } = selectionPreview(text);
    const card = parent.createDiv({ cls: "mva-doc-card mva-sel-card" });
    const thumb = card.createDiv({ cls: "mva-doc-thumb is-icon" });
    setIcon(thumb, "text-cursor-input");
    const body = card.createDiv({ cls: "mva-doc-body" });
    body.createDiv({ cls: "mva-doc-title", text: label || "Selection", attr: { title: label } });
    // Show the source note only when it isn't the active-context doc (which the
    // "Current Document" card already names), so the kind line stays terse.
    const fromOther = path && path !== activePath ? ` · ${noteBasename(path)}` : "";
    body.createDiv({ cls: "mva-doc-kind", text: `Selection · ${count}${fromOther}` });
    const x = card.createSpan({ cls: "mva-doc-x", attr: { "aria-label": "Dismiss selection" } });
    setIcon(x, "x");
    clickable(x, (e) => {
      e.stopPropagation();
      this.currentSelection = null;
      this.refreshContext();
    });
    // Click-to-attach: seed the quoted excerpt into the composer, then clear the
    // chip (the excerpt now lives in the input, so the chip would be redundant).
    clickable(card, () => {
      this.attachSelection(text, path);
      this.currentSelection = null;
      this.refreshContext();
    });
  }

  /** The composer "+" attach control: a themed popover (matching the select chips,
   *  not the OS/Obsidian menu) with the single set of attach actions — note / file
   *  / folder / image. Opens upward, closes on pick / outside-click / Esc. */
  private buildAttachButton(tb: HTMLElement): void {
    const wrap = tb.createDiv({ cls: "mva-sel mva-attach" });
    const btn = wrap.createDiv({ cls: "mva-tb-btn", attr: { "aria-label": "Attach" } });
    setIcon(btn, "plus");
    setTooltip(btn, "Attach note, file, folder, or image");
    const pop = wrap.createDiv({ cls: "mva-sel-pop mva-attach-pop" });
    pop.hide();
    const items: [string, string, () => void][] = [
      ["Add note", "plus", () => this.pickNote()],
      ["Attach file", "file-plus", () => this.pickExternal(false)],
      ["Attach folder", "folder-plus", () => this.pickExternal(true)],
      ["Attach image", "image", () => this.pickImage()],
    ];
    const popover = openablePopover({
      anchor: btn,
      pop,
      wrap,
      onOpen: () => {
        pop.empty();
        for (const [label, icon, run] of items) {
          const row = pop.createDiv({ cls: "mva-sel-opt" });
          setIcon(row.createSpan({ cls: "mva-attach-ico" }), icon);
          row.createSpan({ text: label });
          clickable(row, () => {
            popover.close();
            run();
          });
        }
      },
      focus: () => pop.querySelector<HTMLElement>(".mva-sel-opt")?.focus(),
    });
    clickable(btn, (e) => {
      e.stopPropagation();
      popover.toggle();
    });
    this.host.register(() => popover.close());
  }

  /** Electron file picker for images → reuses the paste/drop attachment path. */
  private pickImage(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      if (files.length) void this.attachImages(files);
    };
    input.click();
  }

  /** Electron file picker for paths OUTSIDE the vault. A hidden <input type=file>
   *  is enough — in Electron, picked File objects expose an absolute `.path`
   *  (no @electron/remote needed). Folder mode uses webkitdirectory and derives
   *  the folder root from the first entry's path minus its relative suffix. */
  private pickExternal(directory: boolean): void {
    const input = document.createElement("input");
    input.type = "file";
    if (directory) input.webkitdirectory = true;
    else input.multiple = true;
    input.onchange = () => {
      const files = Array.from(input.files ?? []) as Array<File & { path?: string; webkitRelativePath?: string }>;
      if (!files.length) return;
      if (directory) {
        const first = files[0];
        const abs = first.path ?? "";
        const rel = first.webkitRelativePath ?? "";
        if (!abs || !rel) return;
        // abs = /Users/x/proj/sub/file.ts, rel = proj/sub/file.ts → root = /Users/x/proj
        const root = abs.slice(0, abs.length - rel.length) + rel.split("/")[0];
        this.addExternalPath(root);
      } else {
        for (const f of files) if (f.path) this.addExternalPath(f.path);
      }
    };
    input.click();
  }

  private addExternalPath(p: string): void {
    if (!this.manualAttached.includes(p)) this.manualAttached.push(p);
    this.refreshContext();
  }

  /** Absolute (out-of-vault) context path? Vault attachments are vault-relative. */
  private static isExternalPath(p: string): boolean {
    return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
  }

  /** A uniform context card: text thumbnail + title + kind ("Current Document" /
   *  "Document" / "External"). External (absolute) paths open via the OS. */
  private renderContextCard(parent: HTMLElement, path: string, isActive: boolean): void {
    const external = Composer.isExternalPath(path);
    const card = parent.createDiv({ cls: "mva-doc-card" });
    const thumb = card.createDiv({ cls: "mva-doc-thumb" });
    if (external) {
      thumb.addClass("is-icon");
      let isDir = false;
      try {
        isDir = (require("fs") as typeof import("fs")).statSync(path).isDirectory();
      } catch {
        /* unreadable — treat as file */
      }
      setIcon(thumb, isDir ? "folder" : "file");
    } else {
      void this.fillThumb(thumb, path);
    }
    const body = card.createDiv({ cls: "mva-doc-body" });
    body.createDiv({ cls: "mva-doc-title", text: noteBasename(path), attr: { title: path } });
    body.createDiv({ cls: "mva-doc-kind", text: isActive ? "Current Document" : external ? "External" : "Document" });
    const x = card.createSpan({ cls: "mva-doc-x", attr: { "aria-label": "Remove from context" } });
    setIcon(x, "x");
    clickable(x, (e) => {
      e.stopPropagation();
      if (isActive) this.excludeActiveNote = true;
      else this.manualAttached = this.manualAttached.filter((p) => p !== path);
      this.refreshContext();
    });
    clickable(card, () => (external ? this.host.openArtifactExternally(path) : this.host.openNote(path)));
  }

  private static readonly IMAGE_EXT = /^(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

  /**
   * Fill a card thumbnail: image files get a real image preview, markdown gets a
   * tiny text preview ("document" look), everything else gets a file-type icon.
   */
  private async fillThumb(el: HTMLElement, path: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) {
      el.addClass("is-icon");
      setIcon(el, "file");
      return;
    }
    if (Composer.IMAGE_EXT.test(f.extension)) {
      el.addClass("is-image");
      const img = el.createEl("img");
      img.src = this.app.vault.getResourcePath(f);
      img.onerror = () => {
        el.empty();
        el.removeClass("is-image");
        el.addClass("is-icon");
        setIcon(el, "image");
      };
      return;
    }
    if (f.extension !== "md") {
      el.addClass("is-icon");
      setIcon(el, "file");
      return;
    }
    try {
      const txt = (await this.app.vault.cachedRead(f))
        .replace(/^---\n[\s\S]*?\n---\n?/, "") // drop frontmatter
        .replace(/!?\[\[[^\]]*\]\]/g, " ") // drop embeds / wikilinks
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // md links → their text
        .replace(/[#>*_`~]/g, "")
        .trim();
      if (txt) el.setText(txt.slice(0, 260));
      else {
        el.addClass("is-icon");
        setIcon(el, "file-text");
      }
    } catch {
      el.addClass("is-icon");
      setIcon(el, "file-text");
    }
  }

  private pickNote(): void {
    new NotePicker(this.app, (f) => {
      if (!this.manualAttached.includes(f.path)) this.manualAttached.push(f.path);
      this.refreshContext();
    }).open();
  }

  autoGrow(): void {
    const el = this.inputEl;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }

  /** Use a custom prompt. A single prompt is inserted into the composer; a
   *  workflow (steps separated by " >>> ") is queued and run in sequence.
   *  {{variables}} across all steps are collected once, then applied to each. */
  usePrompt(promptText: string): void {
    const steps = promptText.split(/\s+>>>\s+/).map((s) => s.trim()).filter(Boolean);
    const vars = extractVars(promptText);
    const run = (values: Record<string, string>) => {
      if (steps.length > 1) {
        // Turn orchestration lives in the view — hand it the resolved steps.
        this.host.submitWorkflow(this.host.active, steps.map((s) => fillVars(s, values)));
      } else {
        this.insertAtComposer(fillVars(promptText, values));
      }
    };
    if (vars.length === 0) {
      run({});
      return;
    }
    new PromptVarsModal(this.app, vars, run).open();
  }

  /** Insert text at the composer's caret (replacing any selection), then focus. */
  private insertAtComposer(text: string): void {
    const el = this.inputEl;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    const caret = start + text.length;
    el.setSelectionRange(caret, caret);
    el.focus();
    this.autoGrow();
  }

  private modelLabel(): string {
    const found = this.host.allModelChoices().find((m) => m.id === this.host.model);
    return found?.label || this.host.model || "Model";
  }
}

/* ---------------------- note picker (multi-attach) ---------------------- */
class NotePicker extends FuzzySuggestModal<TFile> {
  constructor(app: App, private onPick: (f: TFile) => void) {
    super(app);
    this.setPlaceholder("Attach a note to the conversation…");
  }
  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }
  getItemText(f: TFile): string {
    return f.path;
  }
  onChooseItem(f: TFile): void {
    this.onPick(f);
  }
}
