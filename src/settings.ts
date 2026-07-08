import { App, DropdownComponent, Notice, PluginSettingTab, Setting } from "obsidian";
import type ExoPlugin from "./main";
import type { PermissionMode, ProviderId } from "./providers/types";
import { cliDiagnostics, updateClaudeCli } from "./cli";
import { compareSemver } from "./core/semver";
import { ADAPTERS } from "./providers/registry";
import { modelOptions } from "./core/model-options";

export interface MVASettings {
  provider: ProviderId;
  claudeBin: string;
  codexBin: string;
  claudeModel: string;
  codexModel: string;
  /** Extra model ids (comma/newline separated) added to the model pickers. */
  claudeCustomModels: string;
  codexCustomModels: string;
  effort: string;
  systemPrompt: string;
  /** User-defined prompt templates surfaced in the "/" menu. */
  customPrompts: { name: string; prompt: string }[];
  /** What sending a message during a running turn does: "queue" waits and starts
   *  it as the next turn; "steer" injects it into the live turn (Claude only). */
  steerMode: "queue" | "steer";
  /** Phase 1 default: false (pure chat). Phase 2 turns this on with gating. */
  toolsEnabled: boolean;
  permissionMode: PermissionMode;
  autoAllowRead: boolean;
  fastStartup: boolean;
  /** Start the CLI session in the background when Exo opens, so the first
   *  message skips the cold start. Claude only. */
  prewarmSession: boolean;
  /** Run Claude Code hooks (.claude/settings.json) — CC parity, on by default. */
  runHooks: boolean;
  /** Persistent allow rules — one per line: `Tool` or `Tool(argPrefix)`. */
  permAllowRules: string;
  /** Persistent deny rules — one per line; deny wins over allow. */
  permDenyRules: string;
  /** Persist "Always allow" card choices into permAllowRules across sessions. */
  rememberAlwaysAllow: boolean;
  /** Codex sandbox + approval policy. */
  codexSandbox: string;
  codexApproval: string;
  /** Auto-compact the conversation when context fills (token saver, Claude). */
  autoCompactEnabled: boolean;
  /** Load native tool defs on-demand instead of always in context (saves tokens). */
  contextSavingMode: boolean;
  // Obsidian-native (Claude). All optional/toggleable.
  obsidianToolsEnabled: boolean;
  nativeFirst: boolean;
  memoryReadEnabled: boolean;
  memoryWriteEnabled: boolean;
  /** Self-Writing Memory: after each healthy turn, a cheap background observer
   *  proposes durable memories and writes them to the store (with veto/undo).
   *  OFF by default — only runs when this AND memoryWriteEnabled are on. */
  selfWritingMemory: boolean;
  /** Observer cadence (W2-3): "session-end" is the original always-on
   *  end-of-turn capture (default, behavior-neutral). "every-n-steps" ALSO
   *  flushes a delta capture every `observerStepInterval` tool-call steps
   *  within a long turn — Letta-style sleep-time cadence, so context isn't
   *  lost waiting for a marathon agentic turn to finish. */
  observerCadence: "session-end" | "every-n-steps";
  /** Tool-call step interval for `observerCadence: "every-n-steps"`. */
  observerStepInterval: number;
  featureSurfacing: boolean;
  featureWikilinkify: boolean;
  /** Open notes the agent edits in a tab beside the chat, live. */
  revealEditedNotes: boolean;
  /** OS notifications when a turn finishes / waits / errors while Obsidian is backgrounded. */
  systemNotifications: boolean;
  /** Set once after seeding example custom prompts, so we never re-seed. */
  seededPrompts: boolean;
  /** Refine the first-message tab title with a Haiku-generated 3-6 word title. */
  aiTitles: boolean;
  /** In-note AI: floating toolbar over a selection (Edit / Continue / Ask Exo). */
  inlineAi: boolean;
  /** Show the current editor selection as a click-to-attach chip in the composer. */
  showSelectionChip: boolean;
  // Tab bar runtime state (not user-facing settings).
  openTabIds: string[];
  activeTabId: string;
  /** Memory dream pass automation: off | daily | weekly. */
  dreamPassSchedule: "off" | "daily" | "weekly";
  /** Timestamp of the last dream pass (scheduler bookkeeping). */
  lastDreamPass: number;
  /** Dream Pass v2 — LLM proposal stage. When ON, the dream pass runs an extra,
   *  transient tool-less LLM stage that PROPOSES typed consolidation changes
   *  (merge/supersede/rule_draft/import); a deterministic gate culls anything
   *  touching @user entries or matching known-false patterns before preview.
   *  OFF by default — zero behavior change when off. Claude only. */
  dreamLlmEnabled: boolean;
  /** Defrag threshold: when the store/ or learnings/ dir exceeds this many files,
   *  the dream LLM prompt asks for consolidation merges. */
  memoryFileBudget: number;
  /** claude-mem project filter for the import stage. NOT a path-slug — verified
   *  2026-07-05 against the real DB: claude-mem's `project` column stores the
   *  vault/repo's directory basename (e.g. "my-vault"), not the CWD-derived
   *  slug used elsewhere. */
  claudememProjects: string[];
  /** Canonical keys of dream proposals already applied — dedup across runs. */
  appliedProposalKeys: string[];
  /** W0 background-AI master toggle: gates every background LLM pass. */
  backgroundPassesEnabled: boolean;
  /** W0 shared daily token budget for all background passes (0 = unlimited). */
  backgroundDailyTokenBudget: number;
  /** W0 model for background passes (floor Sonnet — never Haiku). */
  backgroundModel: string;
  /** W0 persisted daily budget ledger. */
  backgroundBudgetLedger: { dateUTC: string; tokensUsed: number };
  /** Scheduled playbook runs — one per line: "<Prompt name> | daily" or "<Prompt name> | weekly". */
  scheduledRuns: string;
  /** Per-playbook last-run timestamps (scheduler bookkeeping). */
  scheduledLastRun: Record<string, number>;
  /** Epoch ms of the last daily Claude-CLI update check (0 = never). */
  cliUpdateCheckAt: number;
  /** Latest published Claude CLI version seen by the update check ("" = unknown). */
  cliLatestKnown: string;
  /** Git auto-commit safety net: silently commit vault writes so every
   *  agent-driven mutation is recoverable via git. OFF by default — an opt-in
   *  net, not a surprise. No-op when the vault isn't a git repo. */
  vaultAutoCommit: boolean;
  /** Periodic fallback cadence (minutes) — a commit check runs at least this
   *  often even without a fresh tracked write, catching a dirty tree from
   *  drift. The debounce quiet period after a write (2 min, fixed) usually
   *  fires first. */
  vaultAutoCommitIntervalMinutes: number;
  /** Orchestration Board master flag, default OFF. Gates the `add_task` tool,
   *  the "Promote to task" command, and (future) the board view/ribbon icon —
   *  chat is unaffected either way. See docs/superpowers/specs/2026-07-08-orchestration-board-design.md. */
  orchestrationEnabled: boolean;
}

export const DEFAULT_SETTINGS: MVASettings = {
  provider: "claude",
  claudeBin: "",
  codexBin: "",
  claudeModel: "claude-fable-5",
  codexModel: "gpt-5.5",
  claudeCustomModels: "",
  codexCustomModels: "",
  effort: "default",
  systemPrompt: "",
  customPrompts: [],
  steerMode: "queue",
  toolsEnabled: false,
  permissionMode: "default",
  autoAllowRead: true,
  fastStartup: true,
  prewarmSession: true,
  runHooks: true,
  permAllowRules: "",
  permDenyRules: "",
  rememberAlwaysAllow: false,
  codexSandbox: "workspace-write",
  codexApproval: "on-request",
  autoCompactEnabled: true,
  contextSavingMode: false,
  obsidianToolsEnabled: true,
  nativeFirst: false,
  memoryReadEnabled: true,
  memoryWriteEnabled: true,
  selfWritingMemory: false,
  observerCadence: "session-end",
  observerStepInterval: 25,
  featureSurfacing: true,
  featureWikilinkify: true,
  revealEditedNotes: true,
  systemNotifications: true,
  seededPrompts: false,
  aiTitles: true,
  inlineAi: true,
  showSelectionChip: true,
  openTabIds: [],
  activeTabId: "",
  dreamPassSchedule: "off",
  lastDreamPass: 0,
  dreamLlmEnabled: false,
  memoryFileBudget: 25,
  claudememProjects: [],
  appliedProposalKeys: [],
  backgroundPassesEnabled: true,
  backgroundDailyTokenBudget: 200000,
  backgroundModel: "claude-sonnet-5",
  backgroundBudgetLedger: { dateUTC: "", tokensUsed: 0 },
  scheduledRuns: "",
  scheduledLastRun: {},
  cliUpdateCheckAt: 0,
  cliLatestKnown: "",
  vaultAutoCommit: false,
  vaultAutoCommitIntervalMinutes: 15,
  orchestrationEnabled: false,
};

/** Options for the "Background AI model" dropdown — Sonnet-class only.
 *  Product constraint: the floor for background
 *  passes is Sonnet — never offer (or default to) a Haiku model here, even
 *  though Haiku is available as the observer's own hardcoded fast-path model
 *  elsewhere. Keep in sync with the pinned ids in `providers/claude.ts`. */
const BACKGROUND_MODEL_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
];

export class MVASettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ExoPlugin) {
    super(app, plugin);
  }

  /** Remembered active tab across re-renders (not persisted to disk). */
  private activeTab = "General";

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Obsidian has no native settings tabs, so build a segmented bar of <button>s
    // (keyboard-operable for free) over one body container per tab; clicking a tab
    // shows its body and hides the rest. All settings live under exactly one tab.
    const tabNames = ["General", "Chat", "Agent & Permissions", "Memory", "Advanced"];
    const bar = containerEl.createDiv({ cls: "mva-settings-tabs" });
    const bodies = new Map<string, HTMLElement>();
    const btns = new Map<string, HTMLElement>();

    const select = (name: string) => {
      this.activeTab = name;
      for (const [n, b] of btns) b.toggleClass("is-active", n === name);
      for (const [n, el] of bodies) el.toggleClass("is-hidden", n !== name);
    };

    for (const name of tabNames) {
      const btn = bar.createEl("button", { cls: "mva-settings-tab", text: name });
      btn.onclick = () => select(name);
      btns.set(name, btn);
      bodies.set(name, containerEl.createDiv({ cls: "mva-settings-body" }));
    }

    this.renderGeneralTab(bodies.get("General")!);
    this.renderChatTab(bodies.get("Chat")!);
    this.renderAgentTab(bodies.get("Agent & Permissions")!);
    this.renderMemoryTab(bodies.get("Memory")!);
    this.renderAdvancedTab(bodies.get("Advanced")!);

    if (!bodies.has(this.activeTab)) this.activeTab = "General";
    select(this.activeTab);
  }

  /** A boolean toggle row — the repeated shape across the tabs. */
  private toggleSetting(el: HTMLElement, name: string, desc: string, key: keyof MVASettings): void {
    new Setting(el)
      .setName(name)
      .setDesc(desc)
      .addToggle((t) =>
        t.setValue(this.plugin.settings[key] as boolean).onChange(async (v) => {
          (this.plugin.settings[key] as boolean) = v;
          await this.plugin.saveSettings();
        })
      );
  }

  /* ------------------------------- General ------------------------------ */

  private renderGeneralTab(el: HTMLElement): void {
    const s = this.plugin.settings;

    new Setting(el)
      .setName("Default provider")
      .setDesc("The CLI backend every new conversation starts with.")
      .addDropdown((d) =>
        d
          .addOption("claude", "Claude")
          .addOption("codex", "Codex")
          .setValue(s.provider)
          .onChange(async (v) => {
            s.provider = v as ProviderId;
            await this.plugin.saveSettings();
          })
      );

    // The model each new chat starts with, per provider. Options = the provider's
    // built-ins + the custom ids from the textareas below; editing those textareas
    // repopulates these dropdowns live via fill().
    let claudeDd: DropdownComponent | undefined;
    let codexDd: DropdownComponent | undefined;
    const fill = (d: DropdownComponent, provider: ProviderId) => {
      d.selectEl.empty();
      const cur = provider === "claude" ? s.claudeModel : s.codexModel;
      const opts = modelOptions(
        ADAPTERS[provider].models(),
        provider === "claude" ? s.claudeCustomModels : s.codexCustomModels
      );
      for (const o of opts) d.addOption(o.id, o.label);
      // Keep the current selection valid even if it isn't in the option list.
      if (cur && !opts.some((o) => o.id === cur)) d.addOption(cur, cur);
      d.setValue(cur);
    };

    new Setting(el)
      .setName("Default Claude model")
      .setDesc("Which Claude model new conversations start with — includes any custom Claude models set below.")
      .addDropdown((d) => {
        claudeDd = d;
        fill(d, "claude");
        d.onChange(async (v) => {
          s.claudeModel = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(el)
      .setName("Default Codex model")
      .setDesc("Which Codex model new conversations start with — includes any custom Codex models set below.")
      .addDropdown((d) => {
        codexDd = d;
        fill(d, "codex");
        d.onChange(async (v) => {
          s.codexModel = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(el)
      .setName("Claude binary path")
      .setDesc("Path to the `claude` CLI. Leave empty to auto-detect; run `which claude` if detection fails.")
      .addText((t) =>
        t
          .setPlaceholder("auto-detect")
          .setValue(s.claudeBin)
          .onChange(async (v) => {
            s.claudeBin = v.trim();
            await this.plugin.saveSettings();
          })
      );
    this.renderCliDiagnostics(el, "claude", s.claudeBin);

    new Setting(el)
      .setName("Codex binary path")
      .setDesc("Path to the `codex` CLI. Leave empty to auto-detect; run `which codex` if detection fails.")
      .addText((t) =>
        t
          .setPlaceholder("auto-detect")
          .setValue(s.codexBin)
          .onChange(async (v) => {
            s.codexBin = v.trim();
            await this.plugin.saveSettings();
          })
      );
    this.renderCliDiagnostics(el, "codex", s.codexBin);

    new Setting(el)
      .setName("Custom Claude models")
      .setDesc("Extra Claude model ids (comma- or newline-separated) added to the model picker and the default-model dropdown above.")
      .addTextArea((t) =>
        t
          .setPlaceholder("claude-opus-4-6\nclaude-sonnet-4-6")
          .setValue(s.claudeCustomModels)
          .onChange(async (v) => {
            s.claudeCustomModels = v;
            await this.plugin.saveSettings();
            if (claudeDd) fill(claudeDd, "claude");
          })
      );

    new Setting(el)
      .setName("Custom Codex models")
      .setDesc("Extra Codex model ids (comma- or newline-separated) added to the model picker and the default-model dropdown above.")
      .addTextArea((t) =>
        t
          .setPlaceholder("gpt-5-codex\no3")
          .setValue(s.codexCustomModels)
          .onChange(async (v) => {
            s.codexCustomModels = v;
            await this.plugin.saveSettings();
            if (codexDd) fill(codexDd, "codex");
          })
      );
  }

  /* -------------------------------- Chat -------------------------------- */

  private renderChatTab(el: HTMLElement): void {
    const s = this.plugin.settings;

    new Setting(el)
      .setName("Sending during a running turn")
      .setDesc(
        "Queue = your message waits and starts as the next turn. Steer = inject it into the running turn so the agent can change course mid-flight (Claude only; Codex always queues)."
      )
      .addDropdown((d) =>
        d
          .addOption("queue", "Queue (wait for the next turn)")
          .addOption("steer", "Steer (inject into the running turn)")
          .setValue(s.steerMode)
          .onChange(async (v) => {
            s.steerMode = v as "queue" | "steer";
            await this.plugin.saveSettings();
          })
      );

    this.toggleSetting(
      el,
      "Generate chat titles with AI (Haiku)",
      "After the first reply, rename the tab to a concise 3-6 word summary using Claude Haiku; off keeps the truncated first message.",
      "aiTitles"
    );
    this.toggleSetting(
      el,
      "In-note AI toolbar",
      "Select text in a note to get a floating toolbar: rewrite it with a streaming inline diff (Edit), keep writing from it (Continue), or open the chat with it as context (Ask Exo).",
      "inlineAi"
    );
    this.toggleSetting(
      el,
      "Show selection in composer",
      "When you select text in a note, show it as a chip in the chat composer — click it to add the excerpt as context.",
      "showSelectionChip"
    );
    this.toggleSetting(
      el,
      "Surface related notes",
      "Show notes related to the active note in the empty state, before you send anything.",
      "featureSurfacing"
    );
    this.toggleSetting(
      el,
      "Wikilink-ify replies",
      "Turn mentions of existing note titles in replies into clickable [[wikilinks]].",
      "featureWikilinkify"
    );
    this.toggleSetting(
      el,
      "Reveal edited notes",
      "When the agent edits or creates a note, open it in a tab beside the chat so you watch it change live.",
      "revealEditedNotes"
    );
    this.toggleSetting(
      el,
      "System notifications",
      "Send an OS notification when a turn finishes, a card needs an answer, or an error occurs — only while Obsidian is in the background.",
      "systemNotifications"
    );

    new Setting(el)
      .setName("Custom prompts")
      .setDesc(
        'Reusable prompts for the "/" menu, one per line as "Name | prompt text". Use {{variables}} for fill-in values and " >>> " to chain steps into a multi-step workflow.'
      )
      .addTextArea((t) => {
        t.setPlaceholder("Summarize | Summarize the current note in 5 bullets")
          .setValue(s.customPrompts.map((p) => `${p.name} | ${p.prompt}`).join("\n"))
          .onChange(async (v) => {
            s.customPrompts = v
              .split("\n")
              .map((line) => {
                const i = line.indexOf("|");
                if (i < 0) return null;
                const name = line.slice(0, i).trim();
                const prompt = line.slice(i + 1).trim();
                return name && prompt ? { name, prompt } : null;
              })
              .filter((x): x is { name: string; prompt: string } => x !== null);
            await this.plugin.saveSettings();
          });
        t.inputEl.rows = 5;
      });

    new Setting(el)
      .setName("System prompt")
      .setDesc("Optional persona/instructions prepended to every conversation. Leave empty to use the CLI's default.")
      .addTextArea((t) =>
        t
          .setPlaceholder("(use the CLI's default)")
          .setValue(s.systemPrompt)
          .onChange(async (v) => {
            s.systemPrompt = v;
            await this.plugin.saveSettings();
          })
      );
  }

  /* ------------------------- Agent & Permissions ------------------------ */

  private renderAgentTab(el: HTMLElement): void {
    const s = this.plugin.settings;

    this.toggleSetting(
      el,
      "Enable tools (agentic mode)",
      "Let the agent read, write, and edit files and run commands in your vault. Every sensitive action is still gated by the permission cards.",
      "toolsEnabled"
    );

    new Setting(el)
      .setName("Permission mode")
      .setDesc(
        "How tool use is approved. Ask prompts for each sensitive action; Accept edits auto-approves file edits; Plan only forbids changes; Bypass skips every prompt (dangerous)."
      )
      .addDropdown((d) =>
        d
          .addOption("default", "Ask (default)")
          .addOption("acceptEdits", "Accept edits")
          .addOption("plan", "Plan only")
          .addOption("bypassPermissions", "Bypass (dangerous)")
          .setValue(s.permissionMode)
          .onChange(async (v) => {
            s.permissionMode = v as PermissionMode;
            await this.plugin.saveSettings();
          })
      );

    this.toggleSetting(
      el,
      "Auto-allow read-only tools",
      "Skip the permission prompt for side-effect-free tools (Read, Glob, Grep, LS).",
      "autoAllowRead"
    );
    this.toggleSetting(
      el,
      "Remember 'Always allow' across sessions",
      "When you pick 'Always allow' on a permission card, also save it as an allow rule below so it survives a reload.",
      "rememberAlwaysAllow"
    );

    const rulesDesc =
      "One per line: ToolName or ToolName(argument). Deny wins, and both apply before the permission card. " +
      "Bash arguments match command-token boundaries; file paths match exactly unless they end in * (explicit prefix match).";
    new Setting(el)
      .setName("Always-allow rules")
      .setDesc(rulesDesc)
      .addTextArea((t) => {
        t.setPlaceholder("Bash(git status)\nread_note")
          .setValue(s.permAllowRules)
          .onChange(async (v) => {
            s.permAllowRules = v;
            await this.plugin.saveSettings();
          });
        t.inputEl.rows = 4;
        t.inputEl.style.fontFamily = "var(--font-monospace)";
      });

    new Setting(el)
      .setName("Deny rules")
      .setDesc(rulesDesc)
      .addTextArea((t) => {
        t.setPlaceholder("Bash(rm)\nWrite")
          .setValue(s.permDenyRules)
          .onChange(async (v) => {
            s.permDenyRules = v;
            await this.plugin.saveSettings();
          });
        t.inputEl.rows = 4;
        t.inputEl.style.fontFamily = "var(--font-monospace)";
      });

    this.toggleSetting(
      el,
      "Run Claude Code hooks",
      "Execute hooks in .claude/settings.json (vault + global) — PreToolUse guards, formatters, notifications — matching Claude Code. Hooks run at session start and on every tool call, so heavy or network-bound ones slow turns down; turn off if Exo feels sluggish.",
      "runHooks"
    );

    new Setting(el)
      .setName("Codex sandbox")
      .setDesc("Filesystem access granted to Codex when tools are enabled.")
      .addDropdown((d) =>
        d
          .addOptions({
            "read-only": "Read-only",
            "workspace-write": "Workspace write",
            "danger-full-access": "Full access (danger)",
          })
          .setValue(s.codexSandbox)
          .onChange(async (v) => {
            s.codexSandbox = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName("Codex approval policy")
      .setDesc("When Codex pauses to ask before running a command.")
      .addDropdown((d) =>
        d
          .addOptions({
            untrusted: "Untrusted (ask often)",
            "on-request": "On request",
            "on-failure": "On failure",
            never: "Never",
          })
          .setValue(s.codexApproval)
          .onChange(async (v) => {
            s.codexApproval = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el).setName("Safety net").setHeading();

    this.toggleSetting(
      el,
      "Auto-commit vault changes to git",
      "Silently `git add -A && git commit` the vault after the agent writes files, so every mutation is recoverable. No-op (and silent) when the vault isn't a git repo or the git binary can't be found; never blocks a chat turn.",
      "vaultAutoCommit"
    );

    new Setting(el)
      .setName("Auto-commit fallback interval")
      .setDesc(
        "Minutes between periodic safety-net checks, independent of the debounce after a write. Catches a dirty tree even without a tracked agent write."
      )
      .addText((t) =>
        t
          .setPlaceholder("15")
          .setValue(String(s.vaultAutoCommitIntervalMinutes))
          .onChange(async (v) => {
            const n = Number.parseInt(v, 10);
            if (Number.isFinite(n) && n > 0) s.vaultAutoCommitIntervalMinutes = n;
            await this.plugin.saveSettings();
          })
      );
  }

  /* ------------------------------- Memory ------------------------------- */

  private renderMemoryTab(el: HTMLElement): void {
    const s = this.plugin.settings;

    this.toggleSetting(
      el,
      "Read vault memory",
      "Boot each conversation with context from _system/ (vault-context, preferences, rules, recent sessions). Claude only.",
      "memoryReadEnabled"
    );
    this.toggleSetting(
      el,
      "Write vault memory",
      "Let the agent capture decisions, learnings, and session-log entries into _system/ — every write is still permission-gated. Claude only.",
      "memoryWriteEnabled"
    );
    this.toggleSetting(
      el,
      "Self-writing memory",
      "After each healthy turn, a cheap background observer proposes durable memories and appends them to the store as @generated entries — you can review or undo each write. Off by default; runs only when Write vault memory is also on. Claude only.",
      "selfWritingMemory"
    );

    new Setting(el)
      .setName("Observer cadence")
      .setDesc(
        "When self-writing memory captures. \"End of turn\" (default) is the behavior above, unchanged. \"Every N tool-call steps\" ALSO flushes a delta capture partway through a long, tool-call-heavy turn — so context isn't lost waiting for it to finish — then the end-of-turn pass only covers whatever's left. Step passes respect the background-AI budget below."
      )
      .addDropdown((d) =>
        d
          .addOptions({ "session-end": "End of turn", "every-n-steps": "Every N tool-call steps" })
          .setValue(s.observerCadence)
          .onChange(async (v) => {
            s.observerCadence = v as "session-end" | "every-n-steps";
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (s.observerCadence === "every-n-steps") {
      new Setting(el)
        .setName("Observer step interval")
        .setDesc("Flush a delta capture every this many tool-call steps within a conversation.")
        .addText((t) =>
          t
            .setPlaceholder("25")
            .setValue(String(s.observerStepInterval))
            .onChange(async (v) => {
              const n = Number.parseInt(v, 10);
              if (Number.isFinite(n) && n > 0) s.observerStepInterval = n;
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(el)
      .setName("Memory dream pass")
      .setDesc(
        "Consolidate _system/memory deterministically: merge duplicate learnings, promote well-evidenced ones to rules, mark stale rules. Every run is snapshotted and undoable; set a schedule to automate it, or run it manually from the command palette."
      )
      .addDropdown((d) =>
        d
          .addOptions({ off: "Off", daily: "Daily", weekly: "Weekly" })
          .setValue(s.dreamPassSchedule)
          .onChange(async (v) => {
            s.dreamPassSchedule = v as "off" | "daily" | "weekly";
            await this.plugin.saveSettings();
          })
      );

    this.toggleSetting(
      el,
      "Dream pass — LLM proposal stage",
      "When the dream pass runs, add a transient tool-less LLM stage that PROPOSES typed changes (merge duplicates, supersede, draft rule candidates, import durable claude-mem observations). A deterministic gate culls anything that would touch your own @user memories or match a known-false pattern BEFORE the preview; you still review and can undo every applied change. Off by default; respects the background-AI budget. Claude only.",
      "dreamLlmEnabled"
    );

    new Setting(el)
      .setName("Memory file budget (defrag threshold)")
      .setDesc(
        "When the memory store/ or learnings/ folder exceeds this many files, the dream LLM stage is asked to propose consolidation merges to reduce sprawl."
      )
      .addText((t) =>
        t
          .setPlaceholder("25")
          .setValue(String(s.memoryFileBudget))
          .onChange(async (v) => {
            const n = Number.parseInt(v, 10);
            if (Number.isFinite(n) && n > 0) s.memoryFileBudget = n;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el).setName("Background AI").setHeading();

    this.toggleSetting(
      el,
      "Enable background AI passes",
      "Master switch for every background LLM pass (self-writing observer, dream LLM stage). Turn off to silence all of them at once regardless of their individual toggles.",
      "backgroundPassesEnabled"
    );

    new Setting(el)
      .setName("Background daily token budget")
      .setDesc(
        "Shared daily cap (UTC) across all background passes. When exhausted, background passes skip silently until the next day. Set 0 for unlimited."
      )
      .addText((t) =>
        t
          .setPlaceholder("200000")
          .setValue(String(s.backgroundDailyTokenBudget))
          .onChange(async (v) => {
            const n = Number.parseInt(v, 10);
            if (Number.isFinite(n) && n >= 0) s.backgroundDailyTokenBudget = n;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName("Background AI model")
      .setDesc(
        "Model used by background LLM passes (self-writing observer's dream stage, and future background passes). Floor is Sonnet — Haiku is never offered here, regardless of the observer's own cheap-model default."
      )
      .addDropdown((d) => {
        for (const o of BACKGROUND_MODEL_OPTIONS) d.addOption(o.id, o.label);
        // Keep an out-of-list saved value (custom id, or a retired option) selectable
        // rather than silently snapping to the first option.
        if (!BACKGROUND_MODEL_OPTIONS.some((o) => o.id === s.backgroundModel)) {
          d.addOption(s.backgroundModel, s.backgroundModel);
        }
        d.setValue(s.backgroundModel);
        d.onChange(async (v) => {
          s.backgroundModel = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(el)
      .setName("Scheduled playbook runs")
      .setDesc(
        'Run a custom prompt unattended on a schedule, read-only: the agent may read the vault but every write is denied, and the only output is a report note in _system/reports/. One per line: "Prompt name | daily" or "Prompt name | weekly"; prompts with {{variables}} can\'t be scheduled.'
      )
      .addTextArea((t) => {
        t.setPlaceholder("Morning brief | daily")
          .setValue(s.scheduledRuns)
          .onChange(async (v) => {
            s.scheduledRuns = v;
            await this.plugin.saveSettings();
          });
        t.inputEl.rows = 3;
      });
  }

  /* ------------------------------ Advanced ------------------------------ */

  private renderAdvancedTab(el: HTMLElement): void {
    this.toggleSetting(
      el,
      "Fast startup",
      "Skip external MCP servers at session start for snappier first responses. Turn off to load the MCP servers configured below.",
      "fastStartup"
    );
    this.toggleSetting(
      el,
      "Pre-warm the agent session",
      "Start the CLI session in the background the moment Exo opens, so your first message skips the cold start. Claude only.",
      "prewarmSession"
    );
    this.toggleSetting(
      el,
      "Auto-compact (token saver)",
      "Summarize and compact the conversation automatically when the context window fills, so long chats don't re-bill the whole history each turn. Claude only.",
      "autoCompactEnabled"
    );
    this.toggleSetting(
      el,
      "Context-saving mode",
      "Load Obsidian-native tool definitions on demand instead of always in context — saves tokens every turn, at the cost of an occasional extra discovery step. Claude only.",
      "contextSavingMode"
    );
    this.toggleSetting(
      el,
      "Obsidian tools",
      "Give the agent native vault tools (search, read, backlinks, neighborhood, create/edit notes, frontmatter) alongside the standard ones. Claude only.",
      "obsidianToolsEnabled"
    );
    this.toggleSetting(
      el,
      "Native-first",
      "Disable the built-in file tools (Read/Grep/Glob/LS/Edit/Write) so vault work goes only through the Obsidian-native tools. Bash stays available (gated). Claude only.",
      "nativeFirst"
    );

    new Setting(el).setName("Orchestration Board").setHeading();
    this.toggleSetting(
      el,
      "Enable orchestration",
      "Turn on the `add_task` chat tool and the \"Promote to task\" command, so a conversation can put work onto the Backlog. Off by default — chat behaves identically either way. Claude only.",
      "orchestrationEnabled"
    );

    void this.renderMcpSection(el);
  }

  /** In-app management of the project's `.mcp.json` (loads when Fast startup is off). */
  private async renderMcpSection(containerEl: HTMLElement): Promise<void> {
    new Setting(containerEl).setName("MCP servers").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Manage external MCP servers in the project's .mcp.json (vault root). These load into Claude when Fast startup is OFF.",
    });

    const adapter = this.plugin.app.vault.adapter;
    const path = ".mcp.json";
    let current = '{\n  "mcpServers": {}\n}';
    try {
      if (await adapter.exists(path)) current = await adapter.read(path);
    } catch {
      /* missing — use template */
    }

    const status = containerEl.createEl("div", { cls: "setting-item-description" });
    const setStatus = (msg: string, ok: boolean) => {
      status.setText(msg);
      status.style.color = ok ? "var(--text-success, var(--text-muted))" : "var(--text-error)";
    };

    // Detected servers summary.
    const summary = containerEl.createEl("div", { cls: "setting-item-description" });
    const refreshSummary = (text: string) => {
      try {
        const names = Object.keys((JSON.parse(text)?.mcpServers ?? {}) as Record<string, unknown>);
        summary.setText(names.length ? `Servers: ${names.join(", ")}` : "No servers configured.");
      } catch {
        summary.setText("");
      }
    };
    refreshSummary(current);

    const area = new Setting(containerEl).setName(".mcp.json").setDesc("Edit and save. Must be valid JSON.");
    area.addTextArea((t) => {
      t.setValue(current);
      t.inputEl.rows = 10;
      t.inputEl.style.width = "100%";
      t.inputEl.style.fontFamily = "var(--font-monospace)";
      t.onChange(() => refreshSummary(t.getValue()));
      area.addButton((b) =>
        b
          .setButtonText("Save")
          .setCta()
          .onClick(async () => {
            const raw = t.getValue();
            try {
              const parsed = JSON.parse(raw);
              if (typeof parsed !== "object" || parsed === null || typeof parsed.mcpServers !== "object") {
                setStatus('Invalid: expected an object with an "mcpServers" key.', false);
                return;
              }
              await adapter.write(path, JSON.stringify(parsed, null, 2));
              refreshSummary(raw);
              setStatus("Saved .mcp.json. Turn Fast startup off to load these servers.", true);
            } catch (e) {
              setStatus(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`, false);
            }
          })
      );
    });
  }

  /** Muted line under a binary-path field showing the RESOLVED path + CLI
   *  version (async, never blocks render). Turns future binary-drift debugging
   *  into a 5-second glance. */
  private renderCliDiagnostics(containerEl: HTMLElement, name: string, configured: string): void {
    const el = containerEl.createDiv({ cls: "setting-item-description mva-cli-diag" });
    el.setText("Resolving…");
    // Lazily run (or reuse) the daily update check for Claude, so the button
    // below can appear once both the resolved version and the latest are known.
    if (name === "claude") void this.plugin.maybeCheckCliUpdate();
    void cliDiagnostics(name, configured)
      .then((d) => {
        el.setText(
          d.found
            ? `Resolved: ${d.bin}${d.version ? ` — ${d.version}` : ""}`
            : "Not found — set the path explicitly"
        );
        if (name === "claude" && d.found && d.version) this.maybeRenderCliUpdate(containerEl, d.version);
      })
      .catch(() => el.setText("Not found — set the path explicitly"));
  }

  /** When the resolved Claude CLI is older than the latest known published
   *  version, offer a one-click `npm i -g …@latest` update (never auto-run). */
  private maybeRenderCliUpdate(containerEl: HTMLElement, currentVersion: string): void {
    const latest = this.plugin.settings.cliLatestKnown;
    if (!latest || compareSemver(currentVersion, latest) >= 0) return; // unknown or up to date
    const row = new Setting(containerEl)
      .setName(`Update available: ${latest}`)
      .setDesc("A newer Claude CLI has been published. Updating installs it into your global npm prefix.");
    row.addButton((b) =>
      b
        .setButtonText("Update")
        .setCta()
        .onClick(async () => {
          b.setButtonText("Updating…").setDisabled(true);
          new Notice("Updating Claude CLI…");
          const { ok, output } = await updateClaudeCli();
          if (ok) {
            new Notice(`Updated to ${latest} — restart sessions to pick it up.`);
            b.buttonEl.remove();
          } else {
            const tail = output.split("\n").filter(Boolean).slice(-4).join("\n");
            new Notice(`Claude CLI update failed:\n${tail || "unknown error"}`);
            b.setButtonText("Update").setDisabled(false);
          }
        })
    );
  }
}
